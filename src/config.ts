import "dotenv/config";

export interface AppConfig {
  llm: {
    baseURL: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxTokens: number;
  };
  server: {
    /** Hardcoded — jangan baca dari env; guardrail bind 127.0.0.1 (docs/00-guardrails.md). */
    host: "127.0.0.1";
    port: number;
  };
  limits: {
    maxMessageChars: number;
  };
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Env var '${name}' kosong atau tidak diset. Salin .env.example jadi .env dan isi konfigurasinya sebelum menjalankan server.`
    );
  }
  return value.trim();
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

/** Fail-fast: dipanggil sekali di startup server; throw pesan jelas kalau env tidak lengkap. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseURL = required("API_BASE_URL", env);
  const apiKey = required("API_KEY", env);
  const model = required("MODEL_NAME", env);

  return {
    llm: {
      baseURL,
      apiKey,
      model,
      timeoutMs: intFromEnv("LLM_TIMEOUT_MS", env, 120_000),
      maxTokens: intFromEnv("LLM_MAX_TOKENS", env, 8192),
    },
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
