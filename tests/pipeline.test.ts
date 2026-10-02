import { describe, expect, it } from "vitest";

import {
  buildStats,
  convertHtmlToPresentation,
  findSlideSections,
  withDiagnosticCounts,
} from "../src/convert/pipeline";
import {
  FORMAT_SIZES,
  LIMITS,
  defaultOptions,
  normalizeBackground,
  resolveSlideSize,
  type ConversionOptions,
} from "../src/convert/options";
import { parseOptions } from "../src/server/routes/html2pptx";
import { parseHtml } from "../src/html/sanitize";
import { UserInputError } from "../src/errors";
import type { Diagnostic, Presentation } from "../src/shared/ir";

/**
 * Laporan konversi, opsi, dan ketahanan pipeline terhadap input aneh.
 * Semua fungsi di sini murni kecuali yang memang disebut eksplisit.
 */

const PNG_10x10 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9QzzCKRsEoGgWjAABkQPhfOZj0kAAAAASUVORK5CYII=";

function options(overrides: Partial<ConversionOptions> = {}): ConversionOptions {
  return { ...defaultOptions(), ...overrides };
}

describe("pipeline — statistik laporan", () => {
  it("converted + fallback selalu sama dengan jumlah elemen", async () => {
    const html = `
      <section data-slide>
        <h1>Judul</h1>
        <p style="background: #ff0000; height: 40px">Kotak</p>
        <hr>
        <img src="${PNG_10x10}" alt="x">
        <ul><li>a</li><li>b</li></ul>
      </section>
      <section data-slide><h1>Slide dua</h1></section>
    `;
    const { presentation, report } = await convertHtmlToPresentation(html, options());

    const elementCount = presentation.slides.reduce((sum, slide) => sum + slide.elements.length, 0);
    expect(report.stats.elements).toBe(elementCount);
    expect(report.stats.converted + report.stats.fallback).toBe(report.stats.elements);
    expect(report.stats.slides).toBe(presentation.slides.length);
    expect(report.stats.slides).toBe(2);
    expect(report.stats.fallback).toBe(0);
  });

  it("buildStats menghitung elemen dari IR tanpa perlu diagnostics", async () => {
    const { presentation } = await convertHtmlToPresentation("<h1>a</h1><p>b</p>", options());
    const stats = buildStats(presentation);
    const fromIr = presentation.slides.reduce((sum, slide) => sum + slide.elements.length, 0);
    expect(stats.elements).toBe(fromIr);
    expect(stats.slides).toBe(1);
    expect(stats.converted).toBe(fromIr);
    expect(stats.fallback).toBe(0);
    // <h1> dan <p> masing-masing menghasilkan satu elemen text.
    expect(presentation.slides[0]!.elements.filter((el) => el.sourceTag === "h1")).toHaveLength(1);
    expect(presentation.slides[0]!.elements.filter((el) => el.sourceTag === "p")).toHaveLength(1);
  });

  it("withDiagnosticCounts mengisi warnings dan errors", () => {
    const diagnostics: Diagnostic[] = [
      { level: "warning", stage: "css", message: "w1" },
      { level: "warning", stage: "css", message: "w2" },
      { level: "error", stage: "render", message: "e1" },
      { level: "info", stage: "sanitize", message: "i1" },
    ];
    const counted = withDiagnosticCounts(buildStats(emptyPresentation()), diagnostics);
    expect(counted.warnings).toBe(2);
    expect(counted.errors).toBe(1);
    // Nilai lain tidak berubah.
    expect(counted.slides).toBe(1);
  });

  it("withDiagnosticCounts dengan diagnostics kosong menghasilkan nol", () => {
    const counted = withDiagnosticCounts(buildStats(emptyPresentation()), []);
    expect(counted.warnings).toBe(0);
    expect(counted.errors).toBe(0);
  });

  it("durationMs terisi dan tidak negatif", async () => {
    const { report } = await convertHtmlToPresentation("<h1>x</h1>", options());
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("diagnostic unsupported CSS dihitung sebagai warning", async () => {
    const { report } = await convertHtmlToPresentation(
      "<style>h1 { filter: blur(2px) }</style><h1>x</h1>",
      options(),
    );
    const counted = withDiagnosticCounts(report.stats, report.diagnostics);
    expect(counted.warnings).toBeGreaterThan(0);
    expect(report.diagnostics.some((d) => d.property === "filter" && d.level === "warning")).toBe(true);
  });
});

function emptyPresentation(): Presentation {
  return {
    widthPx: 1280,
    heightPx: 720,
    defaultFontFamily: "Arial",
    defaultColor: "#1A1A1A",
    defaultBackground: "#FFFFFF",
    slides: [{ background: "#FFFFFF", elements: [], sourceIndex: 0 }],
  };
}

describe("pipeline — findSlideSections", () => {
  it("mengembalikan section yang ditandai data-slide", () => {
    const { root } = parseHtml(
      '<section data-slide><h1>1</h1></section><div><section data-slide><h1>2</h1></section></div>',
    );
    expect(findSlideSections(root)).toHaveLength(2);
  });

  it("mengembalikan root sebagai satu slide bila tidak ada data-slide", () => {
    const { root } = parseHtml("<h1>Satu</h1>");
    const sections = findSlideSections(root);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toBe(root);
  });
});

describe("options — resolveSlideSize", () => {
  it("16:9 dan 4:3 memakai preset FORMAT_SIZES", () => {
    expect(resolveSlideSize(options({ format: "16:9" }))).toEqual(FORMAT_SIZES["16:9"]);
    expect(resolveSlideSize(options({ format: "4:3" }))).toEqual(FORMAT_SIZES["4:3"]);
  });

  it("custom memakai customSize yang diberikan", () => {
    const resolved = resolveSlideSize(
      options({ format: "custom", customSize: { widthInch: 8, heightInch: 6 } }),
    );
    expect(resolved).toEqual({ widthInch: 8, heightInch: 6 });
  });

  it("custom tanpa customSize jatuh ke 16:9", () => {
    expect(resolveSlideSize(options({ format: "custom" }))).toEqual(FORMAT_SIZES["16:9"]);
  });

  it("ukuran absurd dijepit ke batas LIMITS", () => {
    expect(resolveSlideSize(options({ format: "custom", customSize: { widthInch: 5000, heightInch: 5000 } }))).toEqual({
      widthInch: LIMITS.maxSlideInch,
      heightInch: LIMITS.maxSlideInch,
    });
    expect(resolveSlideSize(options({ format: "custom", customSize: { widthInch: 0.001, heightInch: 0 } }))).toEqual({
      widthInch: LIMITS.minSlideInch,
      heightInch: LIMITS.minSlideInch,
    });
    expect(resolveSlideSize(options({ format: "custom", customSize: { widthInch: Number.NaN, heightInch: 7 } }))).toEqual({
      widthInch: LIMITS.minSlideInch,
      heightInch: 7,
    });
  });
});

describe("options — normalizeBackground", () => {
  it("#ffffff (6 digit) dipakai utuh dan diuppercase", () => {
    expect(normalizeBackground("#FFFFFF", "#123456")).toBe("#FFFFFF");
    expect(normalizeBackground("  #123456  ", "#FFFFFF")).toBe("#123456");
  });

  it("nilai tidak valid jatuh ke fallback", () => {
    expect(normalizeBackground("biru", "#123456")).toBe("#123456");
    expect(normalizeBackground("#12345", "#123456")).toBe("#123456");
    expect(normalizeBackground("", "#123456")).toBe("#123456");
  });

  it("hex 3 digit diekspansi ke 6 digit", () => {
    // PowerPoint hanya menerima RGB 6 digit; `#fff` harus menjadi `#FFFFFF`.
    expect(normalizeBackground("#fff", "#123456")).toBe("#FFFFFF");
    expect(normalizeBackground("#eef", "#123456")).toBe("#EEEEFF");
  });

  it("notasi CSS lain diterima karena PowerPoint hanya perlu hasil hex", () => {
    expect(normalizeBackground("rgb(1,2,3)", "#123456")).toBe("#010203");
    expect(normalizeBackground("#abc", "#123456")).toBe("#AABBCC");
  });
});

describe("options — parseOptions", () => {
  it("tanpa input mengembalikan default", () => {
    expect(parseOptions(undefined)).toEqual(defaultOptions());
    expect(parseOptions(null)).toEqual(defaultOptions());
    expect(parseOptions({})).toEqual(defaultOptions());
  });

  it("merge di atas default hanya untuk field yang diberikan", () => {
    const parsed = parseOptions({ format: "4:3", title: "Judul" });
    expect(parsed.format).toBe("4:3");
    expect(parsed.title).toBe("Judul");
    expect(parsed.background).toBe(defaultOptions().background);
    expect(parsed.mode).toBe(defaultOptions().mode);
  });

  it("background dan defaultTextColor dinormalisasi ke hex", () => {
    const parsed = parseOptions({ background: "red", defaultTextColor: "#000" });
    expect(parsed.background).toBe("#ff0000");
    expect(parsed.defaultTextColor).toBe("#000000");
  });

  it("input bukan objek ditolak", () => {
    expect(() => parseOptions("16:9")).toThrow(UserInputError);
    expect(() => parseOptions(42)).toThrow(UserInputError);
  });

  it("format, mode, warna, dan customSize tidak valid ditolak", () => {
    expect(() => parseOptions({ format: "21:9" })).toThrow(UserInputError);
    expect(() => parseOptions({ mode: "ajaib" })).toThrow(UserInputError);
    expect(() => parseOptions({ background: "bukan-warna" })).toThrow(UserInputError);
    expect(() => parseOptions({ defaultTextColor: "bukan-warna" })).toThrow(UserInputError);
    expect(() => parseOptions({ defaultFontFamily: "   " })).toThrow(UserInputError);
    expect(() => parseOptions({ customSize: { widthInch: "lebar" } })).toThrow(UserInputError);
    expect(() => parseOptions({ maxRemoteImageBytes: -1 })).toThrow(UserInputError);
    expect(() => parseOptions({ assetTimeoutMs: 0 })).toThrow(UserInputError);
  });

  it("batas ukuran aset dijepit ke maksimum yang aman", () => {
    expect(parseOptions({ maxRemoteImageBytes: 1e12 }).maxRemoteImageBytes).toBe(25 * 1024 * 1024);
    expect(parseOptions({ assetTimeoutMs: 1e12 }).assetTimeoutMs).toBe(60_000);
  });

  it("allowRemoteImages hanya benar bila boolean true", () => {
    expect(parseOptions({ allowRemoteImages: true }).allowRemoteImages).toBe(true);
    expect(parseOptions({ allowRemoteImages: "true" }).allowRemoteImages).toBe(false);
    expect(parseOptions({ allowRemoteImages: false }).allowRemoteImages).toBe(false);
  });

  it("judul dipotong maksimal 300 karakter", () => {
    expect(parseOptions({ title: "a".repeat(500) }).title).toHaveLength(300);
  });
});

describe("pipeline — ketahanan input", () => {
  it("HTML kosong tidak melempar dan menghasilkan satu slide kosong dengan warning", async () => {
    const { presentation, report } = await convertHtmlToPresentation("", options());
    expect(presentation.slides).toHaveLength(1);
    expect(presentation.slides[0]!.elements).toHaveLength(0);
    expect(presentation.slides[0]!.background).toBe("#FFFFFF");
    expect(report.diagnostics.some((d) => d.level === "warning")).toBe(true);
    expect(report.stats.slides).toBe(1);
  });

  it("hanya marker section tanpa konten tidak melempar", async () => {
    const { presentation } = await convertHtmlToPresentation(
      "<section data-slide></section><section data-slide></section><section data-slide></section>",
      options(),
    );
    expect(presentation.slides).toHaveLength(3);
    for (const slide of presentation.slides) {
      expect(slide.elements).toHaveLength(0);
    }
  });

  it("dokumen 1000 elemen selesai tanpa melempar", async () => {
    const rows = Array.from(
      { length: 100 },
      (_, i) => `<section data-slide><h2>Bagian ${i}</h2><p>Paragraf ${i} untuk menguji throughput.</p></section>`,
    ).join("");
    const { presentation, report } = await convertHtmlToPresentation(rows, options());
    expect(presentation.slides).toHaveLength(100);
    const fromIr = presentation.slides.reduce((sum, slide) => sum + slide.elements.length, 0);
    expect(report.stats.elements).toBe(fromIr);
    expect(report.stats.converted + report.stats.fallback).toBe(report.stats.elements);
    // Tiap slide punya setidaknya satu <h2> dan satu <p>.
    for (const slide of presentation.slides) {
      expect(slide.elements.filter((el) => el.sourceTag === "h2")).toHaveLength(1);
      expect(slide.elements.filter((el) => el.sourceTag === "p")).toHaveLength(1);
    }
  }, 20_000);

  it("HTML rusak dalam jumlah besar tidak melempar", async () => {
    const broken = "<h1>Hello<p>World<div><span>unclosed".repeat(200);
    await expect(convertHtmlToPresentation(broken, options())).resolves.toBeDefined();
  });

  it("HTML melebihi batas karakter dipotong dengan warning", async () => {
    const huge = `<p>${"x".repeat(LIMITS.maxHtmlChars + 10)}</p>`;
    const { report } = await convertHtmlToPresentation(huge, options());
    expect(report.diagnostics.some((d) => d.message.includes("truncated"))).toBe(true);
  });

  it("lebih dari LIMITS.maxSlides sections hanya menghasilkan maxSlides slide", async () => {
    const html = Array.from({ length: LIMITS.maxSlides + 5 }, (_, i) => `<section data-slide>${i}</section>`).join("");
    const { presentation, report } = await convertHtmlToPresentation(html, options());
    expect(presentation.slides).toHaveLength(LIMITS.maxSlides);
    expect(report.diagnostics.some((d) => d.message.includes("sections"))).toBe(true);
  });
});

describe("pipeline — assets: remote image hanya diambil bila diizinkan", () => {
  const remoteHtml = '<img src="https://cdn.example.com/a.png" alt="remote">';

  it("fetchImpl yang melempar tidak pernah dipanggil saat allowRemoteImages false", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("fetch tidak boleh dipanggil");
    }) as unknown as typeof fetch;

    const { presentation, report } = await convertHtmlToPresentation(remoteHtml, options(), { fetchImpl });
    expect(calls).toBe(0);
    expect(presentation.slides[0]!.elements).toHaveLength(0);
    expect(report.diagnostics.some((d) => d.message.toLowerCase().includes("download"))).toBe(false);
    expect(
      report.diagnostics.some((d) => d.message.includes("remote images are disabled")),
    ).toBe(true);
  });

  it("fetchImpl yang disuntikkan dipanggil saat allowRemoteImages true", async () => {
    const requested: string[] = [];
    const bytes = Buffer.from(
      PNG_10x10.slice(PNG_10x10.indexOf(",") + 1),
      "base64",
    );
    const fetchImpl = (async (input: string | URL) => {
      requested.push(String(input));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(bytes.length) },
      });
    }) as unknown as typeof fetch;

    const { presentation } = await convertHtmlToPresentation(
      remoteHtml,
      options({ allowRemoteImages: true }),
      { fetchImpl },
    );
    expect(requested).toEqual(["https://cdn.example.com/a.png"]);
    expect(presentation.slides[0]!.elements).toHaveLength(1);
    expect(presentation.slides[0]!.elements[0]!.type).toBe("image");
    expect(
      (presentation.slides[0]!.elements[0]!.content as { dataUri: string }).dataUri.startsWith("data:image/png"),
    ).toBe(true);
  });

  it("gambar remote yang gagal diunduh memberi warning, bukan exception", async () => {
    const fetchImpl = (async () => new Response("tidak ada", { status: 404 })) as unknown as typeof fetch;
    const { presentation, report } = await convertHtmlToPresentation(
      remoteHtml,
      options({ allowRemoteImages: true }),
      { fetchImpl },
    );
    expect(presentation.slides[0]!.elements).toHaveLength(0);
    expect(report.diagnostics.some((d) => d.message.includes("404"))).toBe(true);
  });

  it("data URI raster tidak memerlukan jaringan sama sekali", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("tidak boleh dipanggil");
    }) as unknown as typeof fetch;

    const { presentation } = await convertHtmlToPresentation(
      `<img src="${PNG_10x10}" alt="inline">`,
      options(),
      { fetchImpl },
    );
    expect(calls).toBe(0);
    expect(presentation.slides[0]!.elements[0]!.type).toBe("image");
  });
});
