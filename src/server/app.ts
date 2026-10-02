import path from "node:path";
import express, { type Express } from "express";
import { loadConfig, type AppConfig } from "../config";
import { OpenAiCompatClient } from "../llm/client";
import type { TokenUsage } from "../llm/client";
import { createChatRouter } from "./routes/chat";
import { createHtmlPptxRouter } from "./routes/html2pptx";
import { createSessionsRouter } from "./routes/sessions";
import { sessionStore } from "./sessionStore";
import { assertAllLayoutsHaveRenderers } from "../render/pptxRenderer";

/**
 * Build the Express app.
 *
 * The HTML -> PPTX converter is always mounted: it needs no LLM configuration.
 * The chat routes are mounted only when a provider is configured, so an operator
 * using purely as a converter does not need an API key at all.
 */
export function createApp(config = loadConfig()): Express {
  assertAllLayoutsHaveRenderers();

  const app = express();
  // Konversi HTML memerlukan payload besar: markup, CSS, dan gambar inline.
  // 1mb hanya cukup untuk deck chat; 40mb masih aman untuk bind 127.0.0.1.
  app.use(express.json({ limit: "40mb" }));

  app.use(express.static(path.resolve("public")));
  app.use("/output", express.static(path.resolve("output")));

  app.use("/api/v1", createHtmlPptxRouter());

  if (config.llmEnabled) {
    const client = new OpenAiCompatClient(config.llm);
    const onUsage = (usage: TokenUsage): void => {
      // Guardrail biaya: log token per giliran (kalau provider menyediakan).
      console.log(
        `[usage] prompt=${usage.promptTokens ?? "?"} completion=${usage.completionTokens ?? "?"} total=${usage.totalTokens ?? "?"}`
      );
    };
    app.use("/api", createSessionsRouter(sessionStore));
    app.use("/api", createChatRouter({ config, client, onUsage, store: sessionStore }));
  } else {
    app.use("/api/chat", (_req, res) => {
      res.status(503).json({
        error: "llm_tidak_dikonfigurasi",
        message:
          "Jalur chat butuh provider LLM (API_BASE_URL, API_KEY, MODEL_NAME di .env). Jalur HTML -> PPTX tetap tersedia tanpa LLM.",
      });
    });
  }

  return app;
}

/**
 * Entry point server lokal.
 *
 * Host SELALU 127.0.0.1 (guardrail docs/00-guardrails.md). `LLM_REQUIRED=false`
 * membuat server tetap jalan tanpa provider LLM.
 */
function main(): void {
  const requireLlm = process.env.LLM_REQUIRED !== "false";
  let config: AppConfig;
  try {
    config = loadConfig(process.env, { requireLlm });
  } catch (error) {
    console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`);
    console.error("[startup] Melanjutkan tanpa LLM. Set LLM_REQUIRED=false untuk sengaja menjalankan mode konverter saja.");
    config = loadConfig(process.env, { requireLlm: false });
  }

  const app = createApp(config);
  const { host, port } = config.server;
  app.listen(port, host, () => {
    console.log(`CiptaSlide berjalan di http://${host}:${port} (bind ${host} saja — tidak terekspos ke jaringan)`);
    console.log(`HTML -> PPTX: http://${host}:${port}/html/  (tanpa LLM)`);
    if (config.llmEnabled) {
      console.log(`Chat (LLM): model=${config.llm.model} baseURL=${config.llm.baseURL}`);
    } else {
      console.log("Chat (LLM): dinonaktifkan — API_BASE_URL / API_KEY / MODEL_NAME belum di-set.");
    }
  });
}

// Jalankan hanya kalau dieksekusi langsung (bukan saat di-import test).
if (require.main === module) {
  main();
}