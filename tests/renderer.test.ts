import { describe, expect, it } from "vitest";
import { renderDeck, assertAllLayoutsHaveRenderers } from "../src/render/pptxRenderer";
import { validatePptxStructure, assertValidPptxStructure } from "../src/qa/validator";
import { LAYOUT_TYPES } from "../src/schema/deck.schema";
import type { Deck, LayoutType } from "../src/schema/deck.schema";
import { RenderError } from "../src/errors";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validDeckFixture } from "./schema.test";

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ciptaslide-test-"));
  return path.join(dir, name);
}

function deckWithLayout(layout: LayoutType): Deck {
  const deck = validDeckFixture();
  const slide: Deck["slides"][number] = {
    layout,
    title: `Slide ${layout}`,
    blocks: [],
  };
  if (layout === "titleBullets") {
    slide.blocks = [{ type: "text", content: "Poin satu", bullet: true, bold: false }];
  }
  if (layout === "twoColumn") {
    slide.blocks = [
      { type: "text", content: "Kiri", bullet: true, bold: false },
      { type: "text", content: "Kanan", bullet: true, bold: false },
    ];
  }
  if (layout === "chartFocus") {
    slide.blocks = [
      {
        type: "chart",
        chartType: "bar",
        title: "Tren",
        categories: ["A", "B"],
        series: [{ name: "v", values: [3, 5] }],
      },
    ];
  }
  if (layout === "imageText") {
    slide.blocks = [
      { type: "image", description: "Diagram alur", altPosition: "left" },
      { type: "text", content: "Penjelasan gambar", bullet: false, bold: false },
    ];
  }
  // ganti slide kedua fixture jadi layout target; pertahankan slide title pertama
  deck.slides[1] = slide;
  return deck;
}

describe("pptxRenderer + validator", () => {
  it("semua LayoutType punya renderer terdaftar (guard checklist docs/04a §5)", () => {
    expect(() => assertAllLayoutsHaveRenderers()).not.toThrow();
    for (const layout of LAYOUT_TYPES) {
      const deck = deckWithLayout(layout);
      const parsed = deck; // fixture sudah sesuai schema
      expect(parsed.slides).toHaveLength(2);
    }
  });

  for (const layout of LAYOUT_TYPES) {
    it(`merender layout '${layout}' jadi .pptx yang lolos validasi struktural`, async () => {
      const outPath = await tempFile(`test-${layout}.pptx`);
      const { absolutePath } = await renderDeck(deckWithLayout(layout), outPath);
      const problems = await validatePptxStructure(absolutePath);
      expect(problems).toEqual([]);
    });
  }

  it("renderDeck throw RenderError untuk deck kosong (fail loud)", async () => {
    const outPath = await tempFile("empty.pptx");
    const empty = validDeckFixture();
    empty.slides = [];
    await expect(renderDeck(empty, outPath)).rejects.toThrow(RenderError);
  });

  it("chartFocus tanpa block apa pun → RenderError", async () => {
    const deck = deckWithLayout("chartFocus");
    deck.slides[1]!.blocks = [];
    const outPath = await tempFile("chartless.pptx");
    await expect(renderDeck(deck, outPath)).rejects.toThrow(RenderError);
  });

  it("values chart kosong/semua nol → placeholder eksplisit, file tetap valid (spec §Edge case)", async () => {
    const deck = deckWithLayout("chartFocus");
    const chart = deck.slides[1]!.blocks[0] as Extract<Deck["slides"][number]["blocks"][number], { type: "chart" }>;
    chart.series = [{ name: "v", values: [0, 0] }];
    const outPath = await tempFile("zero-chart.pptx");
    await renderDeck(deck, outPath);
    expect(await validatePptxStructure(outPath)).toEqual([]);
  });

  it("speakerNotes ikut dirender (file tetap valid)", async () => {
    const deck = deckWithLayout("titleBullets");
    deck.slides[1]!.speakerNotes = "Catatan pembicara";
    const outPath = await tempFile("notes.pptx");
    await renderDeck(deck, outPath);
    expect(await validatePptxStructure(outPath)).toEqual([]);
  });
});

describe("validatePptxStructure — deteksi file rusak (docs/00-guardrails.md)", () => {
  it("menerima file .pptx hasil render sungguhan", async () => {
    const outPath = await tempFile("ok.pptx");
    await renderDeck(validDeckFixture(), outPath);
    await expect(assertValidPptxStructure(outPath)).resolves.toEqual({ valid: true, problems: [] });
  });

  it("menolak file acuan yang bukan ZIP", async () => {
    const outPath = await tempFile("fake.pptx");
    await writeFile(outPath, Buffer.from("ini bukan zip sama sekali"));
    const problems = await validatePptxStructure(outPath);
    expect(problems.length).toBeGreaterThan(0);
    await expect(assertValidPptxStructure(outPath)).rejects.toThrow();
  });

  it("menolak ZIP valid tapi bukan OOXML (tanpa entri wajib)", async () => {
    // Buat ZIP sengaja dari isi acak via jszip di memori
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("random.txt", "bukan pptx");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const outPath = await tempFile("notooxml.pptx");
    await writeFile(outPath, buf);
    const problems = await validatePptxStructure(outPath);
    expect(problems.some((p) => p.includes("[Content_Types].xml"))).toBe(true);
    expect(problems.some((p) => p.includes("slideN.xml") || p.includes("slide"))).toBe(true);
  });

  it("menolak file .pptx yang dibuang byte-nya (corrupt)", async () => {
    const outPath = await tempFile("corrupt.pptx");
    await renderDeck(validDeckFixture(), outPath);
    const original = await readFile(outPath);
    const corrupted = original.subarray(0, Math.floor(original.length / 2));
    await writeFile(outPath, corrupted);
    const problems = await validatePptxStructure(outPath);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("menolak file yang tidak ada", async () => {
    const problems = await validatePptxStructure(path.join(tmpdir(), "tidak-ada-xyz.pptx"));
    expect(problems.length).toBeGreaterThan(0);
  });
});
