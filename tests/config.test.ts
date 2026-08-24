import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const BASE_ENV = {
  API_BASE_URL: "https://api.example.com/v1",
  API_KEY: "sk-test",
  MODEL_NAME: "test-model",
} as NodeJS.ProcessEnv;

describe("loadConfig — fail-fast (docs/04a §5 checklist)", () => {
  it("env lengkap → config valid", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.llm.baseURL).toBe("https://api.example.com/v1");
    expect(config.llm.apiKey).toBe("sk-test");
    expect(config.llm.model).toBe("test-model");
  });

  it("API_BASE_URL kosong → throw dengan pesan jelas", () => {
    expect(() => loadConfig({ ...BASE_ENV, API_BASE_URL: "" })).toThrow(/API_BASE_URL/);
  });

  it("API_KEY kosong → throw", () => {
    expect(() => loadConfig({ ...BASE_ENV, API_KEY: " " })).toThrow(/API_KEY/);
  });

  it("MODEL_NAME kosong → throw", () => {
    expect(() => loadConfig({ ...BASE_ENV, MODEL_NAME: undefined })).toThrow(/MODEL_NAME/);
  });

  it("PORT tidak valid → throw", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "nol" })).toThrow(/PORT/);
  });

  it("guardrail: HOST selalu 127.0.0.1 dan tidak bisa dioverride env", () => {
    const config = loadConfig({ ...BASE_ENV, HOST: "0.0.0.0" });
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("default port & timeout masuk akal", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.server.port).toBe(3000);
    expect(config.llm.timeoutMs).toBe(120_000);
    expect(config.limits.maxMessageChars).toBeGreaterThan(0);
  });
});
