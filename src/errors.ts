/**
 * Custom error classes — klasifikasi error lintas-stage.
 * Route API menerjemahkan tiap kelas ini ke HTTP status + pesan yang jelas (fail loud, tanpa silent fallback).
 */

/** Input operator tidak valid (brief kosong/kepanjangan, dsb.) → HTTP 400, tidak boleh retry. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

/** Session tidak dikenal di store (mis. server restart) → HTTP 404, frontend arahkan mulai chat baru. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' tidak dikenal. Server mungkin sudah di-restart — mulai chat baru.`);
    this.name = "SessionNotFoundError";
  }
}

/** Error teknis LLM sementara (timeout, 429, network, response bukan JSON) → retryable dalam repair-loop. */
export class LlmTransientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LlmTransientError";
  }
}

/**
 * Error PERMANEN dari provider/konfigurasi (API key salah, model tak dikenal, request malformed).
 * Tidak boleh masuk repair-loop — gagal cepat dengan pesan yang jelas (docs/03-spec.md §Edge case).
 */
export class LlmConfigError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly cause?: unknown) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Schema tetap invalid setelah repair-loop habis → HTTP 502, tidak boleh dirender. */
export class LlmSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmSchemaError";
  }
}

/** Render gagal / layout tak dikenal → HTTP 500. */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** File .pptx hasil render gagal validasi struktural → HTTP 500, TIDAK dilaporkan sukses ke chat. */
export class PptxStructureError extends Error {
  constructor(problems: string[]) {
    super(`Validasi struktur .pptx gagal:\n- ${problems.join("\n- ")}`);
    this.name = "PptxStructureError";
  }
}
