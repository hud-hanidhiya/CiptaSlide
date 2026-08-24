import type z from "zod";
import type { LlmClient, TokenUsage } from "../llm/client";
import { buildRepairPrompt, buildRevisionPrompt, buildSystemPrompt, buildUserPrompt } from "../llm/promptBuilder";
import { LlmSchemaError, LlmTransientError, UserInputError } from "../errors";
import { DeckSchema, type Deck } from "../schema/deck.schema";

/**
 * Guardrail biaya (docs/00-guardrails.md): MAKSIMAL 3 percobaan per giliran
 * (initial maupun revisi). Percobaan gagal (schema invalid ATAU error teknis seperti
 * timeout/429 — lihat spec §Error handling) dikirim ulang sebagai konteks perbaikan,
 * bukan generate ulang dari nol. Setelah habis → throw fail loud.
 */
export const MAX_PLANNER_ATTEMPTS = 3;

export interface PlannerDeps {
  client: LlmClient;
  /** Log token usage tiap attempt kalau provider menyediakannya (guardrail biaya). */
  onUsage?: (usage: TokenUsage) => void;
  maxAttempts?: number;
}

/** Ambil bagian objek JSON dari raw response (provider kadang menambah fence/teks walau dilarang). */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new SyntaxError("Response tidak mengandung objek JSON sama sekali");
  }
  return candidate.slice(first, last + 1);
}

interface AttemptOutcomeOk {
  ok: true;
  deck: Deck;
}
interface AttemptOutcomeFail {
  ok: false;
  /** Raw response terakhir (konteks repair), atau deskripsi error teknis. */
  raw: string;
  errors: string[];
  /** true kalau gagal karena error teknis LLM (timeout/429/network), bukan schema invalid. */
  transient?: boolean;
}
type AttemptOutcome = AttemptOutcomeOk | AttemptOutcomeFail;

function formatZodErrors(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`
  );
}

/**
 * Giliran initial: brief teks → Deck tervalidasi.
 * Throw UserInputError (brief kosong) atau fail loud setelah attempt habis:
 * LlmTransientError kalau penyebabnya teknis, LlmSchemaError kalau schema.
 */
export async function planDeck(deps: PlannerDeps, brief: string): Promise<Deck> {
  if (!brief || brief.trim() === "") {
    throw new UserInputError("Brief kosong — tulis deskripsi presentasi yang mau dibuat.");
  }
  return runPlannerLoop(deps, () => buildUserPrompt(brief));
}

/**
 * Giliran revisi: Deck saat ini + instruksi → Deck baru tervalidasi.
 * Konteks yang dikirim = Deck terakhir + instruksi (BUKAN riwayat chat penuh — guardrail payload).
 */
export async function reviseDeck(
  deps: PlannerDeps,
  currentDeck: Deck,
  instruction: string
): Promise<Deck> {
  if (!instruction || instruction.trim() === "") {
    throw new UserInputError("Instruksi revisi kosong.");
  }
  return runPlannerLoop(deps, () => buildRevisionPrompt(currentDeck, instruction));
}

async function runPlannerLoop(
  deps: PlannerDeps,
  buildBaseUserPrompt: () => string
): Promise<Deck> {
  const systemPrompt = buildSystemPrompt();
  const maxAttempts = deps.maxAttempts ?? MAX_PLANNER_ATTEMPTS;
  let lastFailure: Extract<AttemptOutcome, { ok: false }> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userPrompt =
      attempt === 1 ? buildBaseUserPrompt() : buildRepairPrompt(lastFailure!.raw, lastFailure!.errors);
    const outcome = await executeAttempt(deps, systemPrompt, userPrompt);
    if (outcome.ok) return outcome.deck;
    lastFailure = outcome;
  }

  const attemptsDesc = `setelah ${maxAttempts} percobaan`;
  if (lastFailure!.transient) {
    throw new LlmTransientError(`LLM gagal secara teknis ${attemptsDesc}. Penyebab terakhir: ${lastFailure!.errors.join("; ")}`);
  }
  throw new LlmSchemaError(
    `Deck tetap tidak valid ${attemptsDesc}. Error terakhir:\n- ${lastFailure!.errors.join("\n- ")}`
  );
}

async function executeAttempt(
  deps: PlannerDeps,
  systemPrompt: string,
  userPrompt: string
): Promise<AttemptOutcome> {
  let raw: string;
  try {
    const result = await deps.client.completeJsonWithUsage(systemPrompt, userPrompt);
    raw = result.content;
    if (result.usage && deps.onUsage) deps.onUsage(result.usage);
  } catch (err) {
    // Error teknis (timeout, 429, network, response kosong) → masuk repair-loop dengan batas yang sama,
    // sesuai spec §Error handling. Bukan silent fallback — kalau attempt habis, throw di runPlannerLoop.
    if (err instanceof LlmTransientError) {
      return { ok: false, raw: "", errors: [err.message], transient: true };
    }
    // Bug pemakaian library/konfigurasi salah (mis. API key format) → fail loud segera.
    throw err;
  }

  try {
    const jsonSlice = extractJsonObject(raw);
    const parsedUnknown: unknown = JSON.parse(jsonSlice);
    const parsed = DeckSchema.safeParse(parsedUnknown);
    if (parsed.success) {
      return { ok: true, deck: parsed.data };
    }
    return { ok: false, raw, errors: formatZodErrors(parsed.error) };
  } catch (err) {
    return {
      ok: false,
      raw,
      errors: [
        `Response bukan JSON yang bisa diparse: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
