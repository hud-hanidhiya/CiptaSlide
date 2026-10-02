import "dotenv/config";

export interface AppConfig {
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
  };
  /**
   * False when the LLM env vars are absent.
   *
   * The HTML -> PPTX path needs no LLM at all, so the server can run without a
   * provider configured; only the chat routes are withheld in that case.
   */
  llmEnabled: boolean;
  server: {
    /** Hardcoded — jangan baca dari env; guardrail bind 127.0.0.1 (docs/00-guardrails.md). */
    host: "127.0.0.1";
    port: number;
  };
  limits: {
    maxMessageChars: number;
  };
}

function intFromEnv(name: string, env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Env var '${name}' harus bilangan bulat positif, dapat: '${raw}'`);
  }
  return parsed;
}

/** True when every LLM var needed by the chat path is present. */
function hasLlmEnv(env: NodeJS.ProcessEnv): boolean {
  return ["API_BASE_URL", "API_KEY", "MODEL_NAME"].every(
    (name) => (env[name] ?? "").trim() !== "",
  );
}

/**
 * Load configuration.
 *
 * Strict by default: a missing LLM var throws with a clear message. Pass
 * `requireLlm: false` when only the HTML -> PPTX path is needed, which is a
 * legitimate configuration: the converter never contacts a provider.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireLlm?: boolean } = {},
): AppConfig {
  const requireLlm = options.requireLlm ?? true;
  if (requireLlm && !hasLlmEnv(env)) {
    const missing = ["API_BASE_URL", "API_KEY", "MODEL_NAME"].filter(
      (name) => (env[name] ?? "").trim() === "",
    );
    throw new Error(
      `Env var ${missing.join(", ")} kosong atau tidak diset. Salin .env.example jadi .env dan isi konfigurasinya sebelum menjalankan server. ` +
        `Jalur HTML -> PPTX tidak butuh LLM: jalankan dengan LLM_REQUIRED=false untuk memakai konverter tanpa provider.`
    );
  }

  return {
    llm: {
      baseURL: (env.API_BASE_URL ?? "").trim(),
      apiKey: (env.API_KEY ?? "").trim(),
      model: (env.MODEL_NAME ?? "").trim(),
      timeoutMs: intFromEnv("LLM_TIMEOUT_MS", env, 120_000),
      maxTokens: intFromEnv("LLM_MAX_TOKENS", env, 8192),
    },
    llmEnabled: hasLlmEnv(env),
    // Guardrail: server pribadi tanpa auth wajib bind 127.0.0.1 saja — tidak pernah dibaca dari env.
    server: {
      host: "127.0.0.1",
      port: intFromEnv("PORT", env, 3000),
    },
    limits: {
      maxMessageChars: intFromEnv("MAX_MESSAGE_CHARS", env, 8000),
    },
  };
}
