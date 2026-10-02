import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { convertHtmlToPresentation } from "../src/convert/pipeline";
import { defaultOptions } from "../src/convert/options";
import type { Presentation, SlideElement, TableContent, TextContent } from "../src/shared/ir";

/**
 * Golden-file tests (PRD section 34).
 *
 * Fixture: `tests/fixtures/<nama>/input.html` + `expected.json`.
 * `expected.json` hanya berisi SUBSET IR yang sudah diverifikasi manual terhadap
 * CSS yang ditulis di `input.html` — bukan dump mentah seluruh IR — supaya
 * perubahan kecil yang tidak disengaja terlihat, dan perubahan yang disengaja
 * diperbarui secara eksplisit.
 *
 * REGENERASI:
 *   $ UPDATE_GOLDEN=1 npm test          (PowerShell: $env:UPDATE_GOLDEN=1; npm test)
 * Menulis ulang `expected.json` dari hasil pipeline saat ini.
 *
 * ATURAN: setelah regenerasi, `expected.json` WAJIB dibaca ulang dan setiap
 * angka diverifikasi terhadap CSS fixture sebelum di-commit.
 */

/** Nama fixture yang diuji, satu direktori perfixture. */
const FIXTURES = ["basic-text", "sections", "table", "cards-flex"] as const;

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures");

const REGENERATE = process.env.UPDATE_GOLDEN === "1" || process.env.UPDATE_GOLDEN === "true";

/** Bentuk yang dibandingkan dengan expected.json. Urutan kunci dijaga stabil. */
interface GoldenStyle {
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string | null;
  background: string | null;
  textAlign: string;
  bullet: string | null;
  listIndex: number | null;
}

interface GoldenElement {
  type: string;
  sourceTag: string;
  box: { x: number; y: number; width: number; height: number };
  style: GoldenStyle;
  text: string;
}

interface GoldenSlide {
  background: string | null;
  elements: GoldenElement[];
}

interface Golden {
  widthPx: number;
  heightPx: number;
  slides: GoldenSlide[];
}

/**
 * Ubah IR menjadi subset yang stabil dan enak dibaca manusia.
 *
 * Wrapper transparan (`div`/`section` tanpa fill dan tanpa border) ikut
 * disertakan: ia hanya memetakan konten inline-nya sendiri, bukan merebut teks
 * blok anaknya, jadi kehadirannya di golden adalah informasi yang berguna.
 */

const WRAPPER_TAGS = new Set(["div", "section", "article", "figure", "figcaption"]);

/** Teks elemen: tiap paragraf digabung run-nya, paragraf dipisah newline. */
function goldenText(element: SlideElement): string {
  const content = element.content as TextContent | TableContent | undefined;
  const paragraphs = (content as TextContent | undefined)?.paragraphs;
  if (!paragraphs) return "";
  return paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n");
}

function isTransparentWrapper(element: SlideElement): boolean {
  return (
    element.type === "text" &&
    WRAPPER_TAGS.has(element.sourceTag) &&
    element.style.background === null &&
    element.style.border === null
  );
}

/** Ubah IR menjadi subset yang stabil dan enak dibaca manusia. */
function serializeIr(presentation: Presentation): Golden {
  return {
    widthPx: presentation.widthPx,
    heightPx: presentation.heightPx,
    slides: presentation.slides.map((slide) => ({
      background: slide.background,
      elements: slide.elements.map((element) => ({
          type: element.type,
          sourceTag: element.sourceTag,
          box: {
            x: element.box.x,
            y: element.box.y,
            width: element.box.width,
            height: element.box.height,
          },
          style: {
            fontFamily: element.style.fontFamily,
            fontSizePx: element.style.fontSizePx,
            bold: element.style.bold,
            italic: element.style.italic,
            underline: element.style.underline,
            color: element.style.color,
            background: element.style.background,
            textAlign: element.style.textAlign,
            bullet: element.style.bullet,
            listIndex: element.style.listIndex,
          },
        text: goldenText(element),
      })),
    })),
  };
}

function fixturePath(name: string, file: string): string {
  return path.join(FIXTURE_DIR, name, file);
}

function readInput(name: string): string {
  return readFileSync(fixturePath(name, "input.html"), "utf8");
}

async function buildGolden(name: string): Promise<Golden> {
  const { presentation } = await convertHtmlToPresentation(readInput(name), defaultOptions());
  return serializeIr(presentation);
}

describe("golden — fixture completeness", () => {
  it("setiap fixture punya input.html", () => {
    for (const name of FIXTURES) {
      expect(existsSync(fixturePath(name, "input.html")), `fixture ${name}/input.html`).toBe(true);
    }
  });

  it("expected.json valid JSON dan punya kunci teratas yang lengkap", () => {
    for (const name of FIXTURES) {
      const file = fixturePath(name, "expected.json");
      if (REGENERATE) continue;
      expect(existsSync(file), `fixture ${name}/expected.json`).toBe(true);
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Golden;
      expect(Object.keys(parsed)).toEqual(["widthPx", "heightPx", "slides"]);
      expect(Array.isArray(parsed.slides)).toBe(true);
    }
  });
});

for (const name of FIXTURES) {
  it(`golden ${name}: IR hasil konversi sama persis dengan expected.json`, async () => {
    const actual = await buildGolden(name);
    const file = fixturePath(name, "expected.json");

    if (REGENERATE) {
      await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
      return;
    }

    const expected = JSON.parse(readFileSync(file, "utf8")) as Golden;
    // Bandingkan sebagai string supaya beda urutan kunci juga terdeteksi.
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });
}

describe("golden — spot check yang tidak bergantung file expected.json", () => {
  it("basic-text: judul 32px bold, paragraf 16px, dan dua butir daftar", async () => {
    const golden = await buildGolden("basic-text");
    const elements = golden.slides[0]!.elements;
    expect(elements.map((el) => el.sourceTag)).toEqual(["h1", "p", "li", "li"]);
    expect(elements[0]!.style.fontSizePx).toBe(32);
    expect(elements[0]!.style.bold).toBe(true);
    expect(elements[0]!.text).toBe("Judul Utama");
    expect(elements[1]!.style.fontSizePx).toBe(16);
    expect(elements[1]!.text).toBe("Paragraf pembuka yang cukup panjang untuk diuji.");
    expect(elements[2]!.style.bullet).not.toBeNull();
    expect(elements[2]!.text).toBe("Poin pertama");
  });

  it("sections: dua slide dengan background berbeda", async () => {
    const golden = await buildGolden("sections");
    expect(golden.slides).toHaveLength(2);
    expect(golden.slides[0]!.background).toBe("#101820");
    expect(golden.slides[1]!.background).toBe("#FFFFFF");
    expect(golden.slides[0]!.elements[0]!.style.color).toBe("#ffffff");
    expect(golden.slides[1]!.elements[0]!.style.color).toBe("#000000");
  });

  it("table: satu elemen table", async () => {
    const golden = await buildGolden("table");
    const tables = golden.slides[0]!.elements.filter((el) => el.type === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.sourceTag).toBe("table");
    expect(tables[0]!.box.width).toBe(600);
  });

  it("cards-flex: dua shape berdampingan dengan jarak horizontal", async () => {
    const golden = await buildGolden("cards-flex");
    const shapes = golden.slides[0]!.elements.filter((el) => el.type === "shape");
    expect(shapes).toHaveLength(2);
    expect(shapes[1]!.box.x).toBe(shapes[0]!.box.x + shapes[0]!.box.width + 24);
    expect(shapes[0]!.style.background).toBe("#f4f4f5");
  });

  it("semua fixture memakai ukuran slide 16:9 yang sama", async () => {
    for (const name of FIXTURES) {
      const golden = await buildGolden(name);
      expect(golden.widthPx).toBeCloseTo(1279.968, 3);
      expect(golden.heightPx).toBe(720);
    }
  });

  it("fixture tidak memuat wrapper transparan sebagai elemen slide", async () => {
    // `<div>Teks <strong>tebal</strong></div>` memang(wrapper ini) adalah elemen
    // teks yang sah. Yang dilarang adalah wrapper yang merebut teks blok
    // anaknya, karena itu menghasilkan teks ganda.
    for (const name of FIXTURES) {
      const golden = await buildGolden(name);
      for (const slide of golden.slides) {
        for (const element of slide.elements) {
          if (element.type !== "text") continue;
          if (!WRAPPER_TAGS.has(element.sourceTag)) continue;
          expect(element.text).not.toBe("");
        }
      }
    }
  });

  it("tidak ada teks yang terduplikasi antar elemen pada fixture mana pun", async () => {
    for (const name of FIXTURES) {
      const golden = await buildGolden(name);
      for (const slide of golden.slides) {
        const texts = slide.elements.map((el) => el.text).filter((text) => text !== "");
        expect(new Set(texts).size).toBe(texts.length);
      }
    }
  });
});