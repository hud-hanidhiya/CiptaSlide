import path from "node:path";
import express, { type Express } from "express";
import { loadConfig } from "../config";
import { OpenAiCompatClient } from "../llm/client";
import type { TokenUsage } from "../llm/client";
import { createChatRouter } from "./routes/chat";
import { createSessionsRouter } from "./routes/sessions";
import { sessionStore } from "./sessionStore";
import { assertAllLayoutsHaveRenderers } from "../render/pptxRenderer";

export function createApp(config = loadConfig()): Express {
  // Fail-fast: loadConfig throw dengan pesan jelas kalau env tidak lengkap — sebelum listen.
  const client = new OpenAiCompatClient(config.llm);
  assertAllLayoutsHaveRenderers();

  const onUsage = (usage: TokenUsage) => {
    // Guardrail biaya: log token per giliran (kalau provider menyediakan).
    console.log(
      `[usage] prompt=${usage.promptTokens ?? "?"} completion=${usage.completionTokens ?? "?"} total=${usage.totalTokens ?? "?"}`
    );
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use(express.static(path.resolve("public")));
  app.use("/output", express.static(path.resolve("output")));

  app.use("/api", createSessionsRouter(sessionStore));
  app.use("/api", createChatRouter({ config, client, onUsage, store: sessionStore }));

  return app;
}

/** Entry point server lokal. Host SELALU 127.0.0.1 (guardrail docs/00-guardrails.md). */
function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  const { host, port } = config.server;
  app.listen(port, host, () => {
    console.log(`CiptaSlide berjalan di http://${host}:${port} (bind ${host} saja — tidak terekspos ke jaringan)`);
    console.log(`LLM: model=${config.llm.model} baseURL=${config.llm.baseURL}`);
  });
}

// Jalankan hanya kalau dieksekusi langsung (bukan saat di-import test).
if (require.main === module) {
  main();
}
