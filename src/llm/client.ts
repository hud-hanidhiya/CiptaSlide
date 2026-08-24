import OpenAI, { APIError } from "openai";
import type { AppConfig } from "../config";
import { LlmConfigError, LlmTransientError } from "../errors";

export interface LlmClient {
  /**
   * Kirim pesan chat-completions, balikin raw content + token usage (belum divalidasi).
   * Throw LlmConfigError untuk penolakan permanen (tidak boleh retry) atau
   * LlmTransientError untuk error teknis sementara (retryable dalam repair-loop).
   */
  completeJsonWithUsage(systemPrompt: string, userPrompt: string): Promise<CompleteResult>;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompleteResult {
  content: string;
  usage: TokenUsage | null;
}

export class OpenAiCompatClient implements LlmClient {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(config: AppConfig["llm"]) {
    this.openai = new OpenAI({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      maxRetries: 0, // retry dikelola sendiri di repair-loop planner dengan batas eksplisit, bukan di SDK.
    });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
  }

  async completeJsonWithUsage(
    systemPrompt: string,
    userPrompt: string
  ): Promise<CompleteResult> {
    let response;
    try {
      response = await this.openai.chat.completions.create({
        model: this.model,
        max_tokens: this.maxTokens, // guardrail biaya: batas response eksplisit di tiap request
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
    } catch (err) {
      if (isPermanentLlmHttpError(err)) {
        // Penolakan permanen (API key salah, model tidak ada, request malformed) →
        // gagal cepat, TIDAK masuk repair-loop (docs/03-spec.md §Edge case).
        throw new LlmConfigError(
          `Provider LLM menolak request secara permanen (HTTP ${err.status}): ${stringifyError(err)}`,
          err.status,
          err
        );
      }
      throw new LlmTransientError(`Panggilan LLM gagal (teknis): ${stringifyError(err)}`, err);
    }

    const choice = response.choices[0];
    const finishReason = choice?.finish_reason;
    if (!choice?.message?.content || choice.message.content.trim() === "") {
      throw new LlmTransientError(
        `LLM mengembalikan response kosong (finish_reason=${finishReason ?? "unknown"})`
      );
    }
    if (finishReason === "length") {
      // Kemungkinan besar JSON terpotong → tidak akan pernah valid, tapi tetap diklasifikasikan transient
      // supaya masuk repair-loop (attempt berikutnya masih punya kesempatan; batas 3x tetap berlaku).
      throw new LlmTransientError("Response LLM terpotong karena max_tokens habis (finish_reason=length)");
    }

    return {
      content: choice.message.content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : null,
    };
  }
}

/**
 * True kalau provider menolak secara PERMANEN via HTTP status 4xx — kecuali
 * 408 (request timeout) dan 429 (rate limit) yang memang sifatnya sementara.
 * Error lain (5xx, network, timeout SDK) dianggap transien.
 */
export function isPermanentLlmHttpError(err: unknown): err is APIError {
  if (!(err instanceof APIError)) return false;
  const status = err.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
