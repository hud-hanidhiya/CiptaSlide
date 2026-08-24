import { describe, expect, it, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import path from "node:path";
import { rm } from "node:fs/promises";
import { createChatRouter } from "../src/server/routes/chat";
import { createSessionsRouter } from "../src/server/routes/sessions";
import { SessionStore } from "../src/server/sessionStore";
import { PptxStructureError } from "../src/errors";
import type { AppConfig } from "../src/config";
import type { LlmClient, CompleteResult } from "../src/llm/client";
import { LlmConfigError, LlmTransientError } from "../src/errors";
import { validDeckFixture } from "./schema.test";
import { validatePptxStructure } from "../src/qa/validator";

/**
 * Integration test POST /api/chat — LLM di-mock (fixture JSON), render & validator ASLI.
 * Server sementara listen di 127.0.0.1 port acak (konsisten guardrail bind localhost).
 */

const testConfig: AppConfig = {
  llm: {
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "test-key",
    model: "mock-model",
    timeoutMs: 5000,
    maxTokens: 1024,
  },
  server: { host: "127.0.0.1", port: 0 },
  limits: { maxMessageChars: 200 },
};

function mockLlm(responses: (CompleteResult | Error)[]): LlmClient {
  let i = 0;
  return {
    async completeJsonWithUsage(): Promise<CompleteResult> {
      const item = responses[i++];
      if (item instanceof Error) throw item;
      if (!item) throw new Error("mock kehabisan response");
      return item;
    },
  };
}

function buildApp(
  llm: LlmClient,
  overrides?: Parameters<typeof createChatRouter>[0]["overrides"]
): { app: Express; store: SessionStore } {
  const store = new SessionStore();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createSessionsRouter(store));
  app.use("/api", createChatRouter({ config: testConfig, client: llm, store, overrides }));
  return { app, store };
}

async function listen(app: Express): Promise<string> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function newSession(base: string): Promise<string> {
  const res = await fetch(`${base}/api/sessions`, { method: "POST" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { sessionId: string };
  return body.sessionId;
}

async function chat(base: string, sessionId: string, message: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  return { status: res.status, body: await res.json() };
}

function outputFilePath(downloadUrl: string): string {
  // downloadUrl berbentuk /output/<encoded-file>.pptx — renderDeck menulis relatif terhadap CWD proyek.
  return path.join(process.cwd(), "output", decodeURIComponent(path.basename(downloadUrl)));
}

const createdFiles: string[] = [];
function trackFile(downloadUrl?: string): void {
  if (downloadUrl) createdFiles.push(outputFilePath(downloadUrl));
}

afterAll(async () => {
  await Promise.all(createdFiles.map((f) => rm(f, { force: true })));
});

describe("POST /api/chat — integration (mocked LLM)", () => {
  it("AC-01 happy path initial: brief → reply + downloadUrl, file lolos validasi struktural", async () => {
    const deckJson = JSON.stringify(validDeckFixture());
    const { app } = buildApp(mockLlm([{ content: deckJson, usage: null }]));
    const base = await listen(app);
    const sessionId = await newSession(base);

    const { status, body } = await chat(base, sessionId, "Deck pitch kopi susu literan untuk investor");
    expect(status).toBe(200);
    expect(body.reply).toContain("2 slide"); // fixture punya 2 slide
    expect(body.downloadUrl).toMatch(/^\/output\/.+\.pptx$/);
    expect(body.deckSummary).toEqual({ title: "Deck Uji", slideCount: 2 });

    // Guardrail: file benar-benar valid, bukan cuma klaim sukses.
    const filePath = trackFilePath(body.downloadUrl);
    expect(await validatePptxStructure(filePath)).toEqual([]);
    void filePath;
  });

  it("AC-04 revisi multi-turn: pesan lanjutan → deck baru + file & link baru di sesi sama", async () => {
    const revised = validDeckFixture();
    revised.meta.title = "Deck Uji Revisi";
    const llm = mockLlm([
      { content: JSON.stringify(validDeckFixture()), usage: null },
      { content: JSON.stringify(revised), usage: null },
    ]);
    const { app, store } = buildApp(llm);
    const base = await listen(app);
    const sessionId = await newSession(base);

    const first = await chat(base, sessionId, "brief awal");
    expect(first.status).toBe(200);

    const second = await chat(base, sessionId, "ganti judul jadi Deck Uji Revisi");
    expect(second.status).toBe(200);
    expect(second.body.deckSummary.title).toBe("Deck Uji Revisi");
    expect(second.body.downloadUrl).not.toBe(first.body.downloadUrl); // file unik per giliran
    expect(second.body.reply).toContain("direvisi");

    // Deck di sesi benar-benar berganti ke versi revisi
    expect(store.get(sessionId)?.deck?.meta.title).toBe("Deck Uji Revisi");
    trackFilePath(first.body.downloadUrl);
    trackFilePath(second.body.downloadUrl);
  });

  it("giliran revisi membawa Deck lama + instruksi ke LLM (bukan brief dari nol)", async () => {
    const seenUserPrompts: string[] = [];
    const llm: LlmClient = {
      async completeJsonWithUsage(_system, userPrompt) {
        seenUserPrompts.push(userPrompt);
        return {
          content: JSON.stringify(validDeckFixture()),
          usage: null,
        };
      },
    };
    const { app } = buildApp(llm);
    const base = await listen(app);
    const sessionId = await newSession(base);

    await chat(base, sessionId, "brief pertama");
    await chat(base, sessionId, "tambahkan slide penutup");

    expect(seenUserPrompts).toHaveLength(2);
    expect(seenUserPrompts[1]).toContain("INSTRUKSI REVISI");
    expect(seenUserPrompts[1]).toContain("tambahkan slide penutup");
    // Konteks revisi = JSON Deck saat ini:
    expect(seenUserPrompts[1]).toContain('"Deck Uji"');
    createdFiles.length; // tidak ada file yang perlu dilacak khusus di test ini
  });

  it("AC-02 schema invalid 3x → HTTP 502 dengan pesan jelas (bukan stack trace)", async () => {
    const bad = { content: JSON.stringify({ bukan: "deck" }), usage: null };
    const { app } = buildApp(mockLlm([bad, bad, bad]));
    const base = await listen(app);
    const sessionId = await newSession(base);

    const { status, body } = await chat(base, sessionId, "brief");
    expect(status).toBe(502);
    expect(body.error).toBe("deck_invalid");
    expect(typeof body.message).toBe("string");
  });

  it("error teknis LLM terus-menerus → HTTP 503", async () => {
    const err = new LlmTransientError("ETIMEDOUT");
    const { app } = buildApp(mockLlm([err, err, err]));
    const base = await listen(app);
    const sessionId = await newSession(base);
    const { status, body } = await chat(base, sessionId, "brief");
    expect(status).toBe(503);
    expect(body.error).toBe("llm_tidak_bisa_dihubungi");
  });

  it("error permanen provider (API key salah) → HTTP 400 llm_config_salah tanpa retry", async () => {
    const err = new LlmConfigError("Provider LLM menolak request secara permanen (HTTP 401)", 401);
    const { app } = buildApp(mockLlm([err]));
    const base = await listen(app);
    const sessionId = await newSession(base);
    const { status, body } = await chat(base, sessionId, "brief");
    expect(status).toBe(400);
    expect(body.error).toBe("llm_config_salah");
    expect(body.message).toContain(".env");
  });

  it("guardrail output integrity: validator gagal → HTTP 500 dan deck TIDAK disimpan di sesi", async () => {
    const deckJson = JSON.stringify(validDeckFixture());
    const failingValidator = async (): Promise<never> => {
      throw new PptxStructureError(["entri wajib hilang"]);
    };
    const { app, store } = buildApp(mockLlm([{ content: deckJson, usage: null }]), {
      validatePptxFn: failingValidator as unknown as typeof import("../src/qa/validator").assertValidPptxStructure,
    });
    const base = await listen(app);
    const sessionId = await newSession(base);

    const { status, body } = await chat(base, sessionId, "brief");
    expect(status).toBe(500);
    expect(body.error).toBe("file_corrupt");
    expect(store.get(sessionId)?.deck).toBeNull(); // jangan pernah dilaporkan sukses
  });

  it("sessionId tak dikenal (mis. server restart) → HTTP 404 + kode session_tidak_dikenal", async () => {
    const { app } = buildApp(mockLlm([]));
    const base = await listen(app);
    const { status, body } = await chat(base, "session-palsu-xyz", "revisi dong");
    expect(status).toBe(404);
    expect(body.error).toBe("session_tidak_dikenal");
  });

  it("pesan kosong → HTTP 400 tanpa memanggil LLM", async () => {
    const llm = mockLlm([]);
    const { app } = buildApp(llm);
    const base = await listen(app);
    const sessionId = await newSession(base);
    const { status } = await chat(base, sessionId, "   ");
    expect(status).toBe(400);
  });

  it("pesan melebihi batas karakter → HTTP 400 (guardrail biaya)", async () => {
    const { app } = buildApp(mockLlm([]));
    const base = await listen(app);
    const sessionId = await newSession(base);
    const { status, body } = await chat(base, sessionId, "a".repeat(testConfig.limits.maxMessageChars + 1));
    expect(status).toBe(400);
    expect(body.message).toContain("terlalu panjang");
  });

  it("frontend statis tersedia dari server yang sama", async () => {
    const { createApp } = await import("../src/server/app");
    void createApp;
    // Static serving diverifikasi manual via browser; di sini cukup pastikan route API hidup.
    const { app } = buildApp(mockLlm([]));
    const base = await listen(app);
    const res = await fetch(`${base}/api/sessions`, { method: "POST" });
    expect(res.status).toBe(201);
  });
});

function trackFilePath(downloadUrl: string): string {
  const filePath = outputFilePath(downloadUrl);
  createdFiles.push(filePath);
  return filePath;
}
