import { describe, expect, it, vi } from "vitest";
import { APIError } from "openai";
import { MAX_PLANNER_ATTEMPTS, planDeck, reviseDeck, extractJsonObject } from "../src/planner/contentPlanner";
import { isPermanentLlmHttpError } from "../src/llm/client";
import type { LlmClient } from "../src/llm/client";
import type { CompleteResult, TokenUsage } from "../src/llm/client";
import { LlmConfigError, LlmSchemaError, LlmTransientError, UserInputError } from "../src/errors";
import type { Deck } from "../src/schema/deck.schema";
import { validDeckFixture } from "./schema.test";

function okResult(content: string): CompleteResult {
  return { content, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
}

/** Mock client yang memancarkan response berurutan per panggilan. */
function mockClient(responses: (CompleteResult | Error)[]): {
  client: LlmClient;
  calls: string[];
  usages: TokenUsage[];
} {
  const calls: string[] = [];
  const usages: TokenUsage[] = [];
  let index = 0;
  const client: LlmClient = {
    async completeJsonWithUsage(systemPrompt: string, userPrompt: string) {
      calls.push(userPrompt);
      const item = responses[index++];
      if (item instanceof Error) throw item;
      if (!item) throw new Error("mock kehabisan response");
      if (item.usage) usages.push(item.usage);
      return item;
    },
  };
  return { client, calls, usages };
}

const deckJson = JSON.stringify(validDeckFixture());

describe("planDeck — giliran initial", () => {
  it("sukses pada percobaan pertama", async () => {
    const { client, calls, usages } = mockClient([okResult(deckJson)]);
    const deck = await planDeck({ client }, "Deck tentang kopi");
    expect(deck.meta.title).toBe("Deck Uji");
    expect(calls).toHaveLength(1);
    // Guardrail biaya: usage dilog kalau provider menyediakan
    expect(usages).toHaveLength(1);
  });

  it("menolak brief kosong tanpa memanggil LLM", async () => {
    const { client, calls } = mockClient([]);
    await expect(planDeck({ client }, "   ")).rejects.toThrow(UserInputError);
    expect(calls).toHaveLength(0);
  });

  it("repair-loop pulih dari 1x schema invalid — attempt kedua membawa konteks error + raw JSON lama", async () => {
    const invalidJson = JSON.stringify({ meta: {}, slides: [] });
    const { client, calls } = mockClient([okResult(invalidJson), okResult(deckJson)]);
    const deck = await planDeck({ client }, "brief");

    expect(deck.meta.title).toBe("Deck Uji");
    expect(calls).toHaveLength(2);
    // Attempt ke-2 adalah repair prompt: berisi daftar error + JSON invalid sebelumnya
    expect(calls[1]).toContain("GAGAL validasi schema");
    expect(calls[1]).toContain(invalidJson);
  });

  it("mem-parsing JSON yang dibungkus markdown fence", async () => {
    const fenced = "```json\n" + deckJson + "\n```";
    const { client } = mockClient([okResult(fenced)]);
    const deck = await planDeck({ client }, "brief");
    expect(deck.slides).toHaveLength(2);
  });

  it(`throw LlmSchemaError setelah ${MAX_PLANNER_ATTEMPTS}x gagal`, async () => {
    const bad = okResult(JSON.stringify({ bukan: "deck" }));
    const { client, calls } = mockClient([bad, bad, bad]);
    await expect(planDeck({ client }, "brief")).rejects.toThrow(LlmSchemaError);
    expect(calls.length).toBeLessThanOrEqual(MAX_PLANNER_ATTEMPTS);
  });

  it("retry error teknis (timeout) dalam batas attempt lalu throw LlmTransientError", async () => {
    const timeoutErr = new LlmTransientError("timeout");
    const { client, calls } = mockClient([timeoutErr, timeoutErr, timeoutErr]);
    await expect(planDeck({ client }, "brief")).rejects.toThrow(LlmTransientError);
    expect(calls).toHaveLength(MAX_PLANNER_ATTEMPTS); // tidak retry tanpa batas
  });

  it("error teknis lalu sukses → pulih dalam batas attempt", async () => {
    const { client } = mockClient([new LlmTransientError("429 rate limit"), okResult(deckJson)]);
    const deck = await planDeck({ client }, "brief");
    expect(deck.meta.title).toBe("Deck Uji");
  });

  it("error permanen/non-transien → gagal segera TANPA retry", async () => {
    const fatal = new LlmConfigError("Provider menolak request secara permanen (HTTP 401)", 401);
    const { client, calls } = mockClient([fatal]);
    await expect(planDeck({ client }, "brief")).rejects.toThrow(LlmConfigError);
    expect(calls).toHaveLength(1); // tidak dibuang-buang attempt
  });
});

describe("isPermanentLlmHttpError — klasifikasi error provider", () => {
  it("401/400/404 → permanen (tidak boleh di-retry)", () => {
    for (const status of [400, 401, 403, 404]) {
      const err = new APIError(status, undefined, "ditolak", undefined);
      expect(isPermanentLlmHttpError(err)).toBe(true);
    }
  });

  it("429/5xx/network/plain Error → transien (boleh masuk repair-loop)", () => {
    for (const status of [408, 429, 500, 503]) {
      const err = new APIError(status, undefined, "sementara", undefined);
      expect(isPermanentLlmHttpError(err)).toBe(false);
    }
    expect(isPermanentLlmHttpError(new Error("socket hang up"))).toBe(false);
    expect(isPermanentLlmHttpError(null)).toBe(false);
  });
});

describe("reviseDeck — giliran revisi multi-turn", () => {
  it("mengirim Deck saat ini + instruksi sebagai konteks (bukan generate dari nol)", async () => {
    const currentDeck = validDeckFixture();
    const { client, calls } = mockClient([okResult(deckJson)]);
    await reviseDeck({ client }, currentDeck, "ganti warna jadi biru");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("INSTRUKSI REVISI");
    expect(calls[0]).toContain("ganti warna jadi biru");
    expect(calls[0]).toContain(JSON.stringify(currentDeck));
  });

  it("menolak instruksi kosong tanpa memanggil LLM", async () => {
    const { client, calls } = mockClient([]);
    await expect(reviseDeck({ client }, validDeckFixture(), "")).rejects.toThrow(UserInputError);
    expect(calls).toHaveLength(0);
  });

  it("repair-loop revisi juga pulih dari 1x kegagalan dan throw setelah 3x gagal", async () => {
    const invalid = okResult(JSON.stringify({ slides: "banyak" }));
    const { client, calls } = mockClient([invalid, okResult(deckJson)]);
    const deck = await reviseDeck({ client }, validDeckFixture(), "tambah slide penutup");
    expect(deck.meta.title).toBe("Deck Uji");
    expect(calls).toHaveLength(2);

    const { client: client3x } = mockClient([invalid, invalid, invalid]);
    await expect(
      reviseDeck({ client: client3x }, validDeckFixture(), "tambah slide penutup")
    ).rejects.toThrow(LlmSchemaError);
  });
});

describe("extractJsonObject", () => {
  it("mengekstrak objek dari teks bersampul", () => {
    const slice = extractJsonObject('Berikut hasilnya:\n{"a":1}\nSemoga membantu.');
    expect(JSON.parse(slice)).toEqual({ a: 1 });
  });

  it("throw kalau tidak ada objek sama sekali", () => {
    expect(() => extractJsonObject("tidak ada json di sini")).toThrow();
  });
});
