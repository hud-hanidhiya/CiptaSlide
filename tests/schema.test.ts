import { describe, expect, it } from "vitest";
import {
  DeckSchema,
  LAYOUT_TYPES,
  MAX_SLIDES,
  type Deck,
} from "../src/schema/deck.schema";

/** Deck valid minimal sebagai dasar mutasi test. */
export function validDeckFixture(): Deck {
  return {
    meta: { title: "Deck Uji", palette: { primary: "1A2B3C", secondary: "ABCDEF" } },
    slides: [
      {
        layout: "title",
        title: "Deck Uji",
        subtitle: "Subtitle",
        blocks: [],
      },
      {
        layout: "titleBullets",
        title: "Slide isi",
        blocks: [
          { type: "text", content: "Poin pertama", bullet: true, bold: false },
        ],
      },
    ],
  };
}

describe("DeckSchema — happy path", () => {
  it("menerima deck valid", () => {
    const result = DeckSchema.safeParse(validDeckFixture());
    expect(result.success).toBe(true);
  });

  it("memberi default palette background/text", () => {
    const result = DeckSchema.parse(validDeckFixture());
    expect(result.meta.palette.background).toBe("FFFFFF");
    expect(result.meta.palette.text).toBe("1A1A1A");
  });

  it("menerima semua LayoutType yang terdaftar", () => {
    for (const layout of LAYOUT_TYPES) {
      const deck = validDeckFixture();
      deck.slides[1]!.layout = layout;
      expect(DeckSchema.safeParse(deck).success).toBe(true);
    }
  });
});

describe("DeckSchema — penolakan field invalid", () => {
  it("menolak hex palette dengan '#'", () => {
    const deck = validDeckFixture();
    (deck.meta.palette.primary as string) = "#1A2B3C";
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });

  it("menolak hex palette bukan 6 digit", () => {
    const deck = validDeckFixture();
    deck.meta.palette.secondary = "ABC";
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });

  it("menolak layout tak dikenal", () => {
    const deck = validDeckFixture();
    (deck.slides[1] as { layout: string }).layout = "hologram";
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });

  it("menolak slide pertama bukan layout title", () => {
    const deck = validDeckFixture();
    deck.slides[0]!.layout = "closing";
    const result = DeckSchema.safeParse(deck);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("slide pertama");
    }
  });

  it(`menolak lebih dari ${MAX_SLIDES} slide`, () => {
    const deck = validDeckFixture();
    const filler = deck.slides[1]!;
    while (deck.slides.length <= MAX_SLIDES) {
      deck.slides.push(structuredClone(filler));
    }
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });

  it("menolak deck tanpa slide", () => {
    const deck = validDeckFixture();
    deck.slides = [];
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });

  it("menolak block text kosong", () => {
    const deck = validDeckFixture();
    deck.slides[1]!.blocks = [{ type: "text", content: "", bullet: true, bold: false }];
    expect(DeckSchema.safeParse(deck).success).toBe(false);
  });
});

describe("DeckSchema — guardrail chart (docs/00-guardrails.md)", () => {
  function deckWithChart(chartType: "bar" | "line" | "pie" | "doughnut", values: number[]): Deck {
    const deck = validDeckFixture();
    deck.slides[1]!.blocks = [
      {
        type: "chart",
        chartType,
        title: "Penjualan",
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values }],
      },
    ];
    return deck;
  }

  it("AC-03: menolak pie dengan nilai negatif", () => {
    const result = DeckSchema.safeParse(deckWithChart("pie", [100, -20, 50]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("negatif"))).toBe(true);
    }
  });

  it("menolak doughnut dengan nilai negatif", () => {
    expect(DeckSchema.safeParse(deckWithChart("doughnut", [-1, 2, 3])).success).toBe(false);
  });

  it("menerima bar dengan nilai negatif (bar boleh negatif)", () => {
    expect(DeckSchema.safeParse(deckWithChart("bar", [100, -20, 50])).success).toBe(true);
  });

  it("menolak panjang series.values != panjang categories", () => {
    const result = DeckSchema.safeParse(deckWithChart("bar", [1, 2]));
    expect(result.success).toBe(false);
  });

  it("menolak chart tanpa kategori / tanpa series", () => {
    const noCategories = deckWithChart("bar", [1, 2, 3]);
    (noCategories.slides[1]!.blocks[0] as { categories: string[] }).categories = [];
    expect(DeckSchema.safeParse(noCategories).success).toBe(false);

    const noSeries = deckWithChart("bar", [1, 2, 3]);
    (noSeries.slides[1]!.blocks[0] as { series: unknown[] }).series = [];
    expect(DeckSchema.safeParse(noSeries).success).toBe(false);
  });
});
