import { Router, type Request, type Response } from "express";
import type { AppConfig } from "../../config";
import { UserInputError, SessionNotFoundError, LlmConfigError, LlmSchemaError, LlmTransientError, PptxStructureError, RenderError } from "../../errors";
import { planDeck, reviseDeck } from "../../planner/contentPlanner";
import { renderDeck } from "../../render/pptxRenderer";
import { assertValidPptxStructure } from "../../qa/validator";
import { stringifyError } from "../../llm/client";
import type { LlmClient, TokenUsage } from "../../llm/client";
import { SessionStore, sessionStore as defaultSessionStore } from "../sessionStore";

/**
 * POST /api/chat — satu giliran chat = pipeline penuh:
 * Planner (LLM + repair-loop max 3x) → Renderer → Validator struktural → update session → balasan.
 * Semua error fail loud dari stage diterjemahkan di sini jadi HTTP status + pesan jelas.
 */

export interface ChatDeps {
  config: AppConfig;
  client: LlmClient;
  onUsage?: (usage: TokenUsage) => void;
  /** Override untuk integration test — default memakai singleton produksi. */
  store?: SessionStore;
  overrides?: {
    planDeckFn?: typeof planDeck;
    reviseDeckFn?: typeof reviseDeck;
    renderDeckFn?: typeof renderDeck;
    validatePptxFn?: typeof assertValidPptxStructure;
  };
}

interface ChatRequestBody {
  sessionId?: unknown;
  message?: unknown;
}

export function createChatRouter(deps: ChatDeps): Router {
  const router = Router();
  const maxMessageChars = deps.config.limits.maxMessageChars;
  const store = deps.store ?? defaultSessionStore;
  const planDeckFn = deps.overrides?.planDeckFn ?? planDeck;
  const reviseDeckFn = deps.overrides?.reviseDeckFn ?? reviseDeck;
  const renderDeckFn = deps.overrides?.renderDeckFn ?? renderDeck;
  const validatePptxFn = deps.overrides?.validatePptxFn ?? assertValidPptxStructure;

  router.post("/chat", async (req: Request, res: Response) => {
    try {
      const body = req.body as ChatRequestBody | undefined;
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      const message = typeof body?.message === "string" ? body.message : "";

      if (!sessionId.trim()) {
        throw new UserInputError("Field 'sessionId' wajib diisi (dapat dari POST /api/sessions).");
      }
      if (!message.trim()) {
        throw new UserInputError("Pesan kosong — tulis brief atau instruksi revisi.");
      }
      if (message.length > maxMessageChars) {
        throw new UserInputError(
          `Pesan terlalu panjang (${message.length} karakter; maksimal ${maxMessageChars}). Ringkas brief-nya.`
        );
      }

      // Session tidak dikenal (mis. server restart) → 404 jelas, BUKAN diam-diam bikin sesi kosong.
      const session = store.require(sessionId);

      const isRevision = session.deck !== null;
      console.log(
        `[chat] session=${sessionId.slice(0, 8)}… giliran=${isRevision ? "revisi" : "initial"} chars=${message.length}`
      );

      // Stage 1 — Planner. Deck lama TIDAK disentuh sampai giliran baru sukses (failure mode docs/04).
      const plannerDeps = { client: deps.client, onUsage: deps.onUsage };
      const deck = isRevision
        ? await reviseDeckFn(plannerDeps, session.deck!, message)
        : await planDeckFn(plannerDeps, message);

      // Stage 2 — Render deterministik. Nama file unik per giliran (bukan overwrite diam-diam).
      const fileName = `${sessionId}-${Date.now()}.pptx`;
      const renderResult = await renderDeckFn(deck, `output/${fileName}`);

      // Stage 3 — QA struktural. Gagal di sini = TIDAK dilaporkan sukses ke chat.
      await validatePptxFn(renderResult.absolutePath);

      // Sukses penuh baru session di-update.
      session.deck = deck;
      session.lastPptxFile = fileName;
      session.turns.push({ role: "user", summary: truncate(message, 200) });
      session.turns.push({
        role: "assistant",
        summary: `Deck "${deck.meta.title}" (${deck.slides.length} slide) ${isRevision ? "revisi" : "dibuat"} → ${fileName}`,
      });

      console.log(
        `[chat] OK session=${sessionId.slice(0, 8)}… file=${fileName} slides=${deck.slides.length}`
      );

      res.json({
        reply:
          `Selesai — deck "${deck.meta.title}" berisi ${deck.slides.length} slide ` +
          `${isRevision ? "sudah direvisi dan dirender ulang" : "berhasil dibuat"}. ` +
          "File .pptx sudah lolos validasi struktur.",
        downloadUrl: `/output/${encodeURIComponent(fileName)}`,
        deckSummary: { title: deck.meta.title, slideCount: deck.slides.length },
      });
    } catch (err) {
      mapErrorToResponse(res, err);
    }
  });

  return router;
}

function mapErrorToResponse(res: Response, err: unknown): void {
  if (err instanceof UserInputError) {
    res.status(400).json({ error: "input_tidak_valid", message: err.message });
  } else if (err instanceof SessionNotFoundError) {
    // Sesi mati (mis. server restart) → frontend diarahkan mulai chat baru, bukan retry diam-diam.
    console.warn(`[chat] ${err.message}`);
    res.status(404).json({ error: "session_tidak_dikenal", message: err.message });
  } else if (err instanceof LlmConfigError) {
    // Penolakan permanen provider (API key/model/baseURL salah) — retry tidak akan membantu.
    console.error(`[chat] LLM config error: ${err.message}`);
    res.status(400).json({
      error: "llm_config_salah",
      message:
        "Provider LLM menolak request secara permanen. Periksa API_BASE_URL, API_KEY, dan MODEL_NAME di .env lalu restart server.",
    });
  } else if (err instanceof LlmTransientError) {
    // Technical error yang tetap gagal setelah repair-loop habis.
    console.error(`[chat] LLM transient: ${err.message}`);
    res.status(503).json({
      error: "llm_tidak_bisa_dihubungi",
      message: "Provider LLM gagal/timeout setelah beberapa percobaan. Coba kirim ulang pesannya nanti.",
    });
  } else if (err instanceof LlmSchemaError) {
    console.error(`[chat] Schema invalid persisten: ${err.message}`);
    res.status(502).json({
      error: "deck_invalid",
      message: "Isi deck dari LLM tetap tidak valid setelah maksimal percobaan perbaikan. Coba reformulasikan brief/instruksinya.",
    });
  } else if (err instanceof RenderError) {
    console.error(`[chat] Render gagal: ${err.message}`);
    res.status(500).json({ error: "render_gagal", message: "Gagal merender deck menjadi file .pptx." });
  } else if (err instanceof PptxStructureError) {
    // Guardrail: jangan pernah dilaporkan sukses ke chat.
    console.error(`[chat] Validasi pptx gagal: ${err.message}`);
    res.status(500).json({
      error: "file_corrupt",
      message: "File hasil render gagal validasi struktur, jadi tidak dikirim. Silakan coba lagi atau ubah instruksinya.",
    });
  } else {
    console.error(`[chat] Error tak terduga: ${stringifyError(err)}`);
    res.status(500).json({ error: "internal", message: "Terjadi kesalahan internal server." });
  }
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}
