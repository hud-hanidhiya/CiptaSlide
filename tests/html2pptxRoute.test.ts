import { describe, expect, it, afterAll } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import JSZip from "jszip";

import { createHtmlPptxRouter } from "../src/server/routes/html2pptx";
import { validatePptxStructure } from "../src/qa/validator";

/**
 * Integrasi API HTML -> PPTX (PRD section 30).
 *
 * Pola sama seperti tests/chatRoute.test.ts: aplikasi Express asli di-bind ke
 * 127.0.0.1 port acak, request lewat `fetch` sungguhan, file hasil convert
 * dibersihkan di afterAll. Tidak ada stub LLM di sini — konversi, render PPTX,
 * dan validasi struktural semuanya jalan production code.
 */

const TEST_HTML = `
  <section data-slide style="padding: 40px">
    <h1>Deck dari API</h1>
    <p>Paragraf pembuka.</p>
  </section>
`;

const TWO_SLIDE_HTML = `
  <section data-slide><h1>Slide satu</h1></section>
  <section data-slide><h1>Slide dua</h1></section>
`;

const createdFiles: string[] = [];

function buildApp(): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Sama seperti src/server/app.ts: berkas hasil convert disajikan dari output/.
  app.use("/output", express.static(path.join(process.cwd(), "output")));
  app.use("/api/v1", createHtmlPptxRouter());
  return app;
}

async function listen(app: Express): Promise<string> {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function post(base: string, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v1${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Berkas convert ditulis relatif terhadap CWD proyek (folder output/). */
function outputFilePath(downloadUrl: string): string {
  return path.join(process.cwd(), "output", decodeURIComponent(path.basename(downloadUrl)));
}

afterAll(async () => {
  await Promise.all(createdFiles.map((file) => rm(file, { force: true })));
});

describe("GET /api/v1/health", () => {
  it("liveness probe mengembalikan status ok", async () => {
    const base = await listen(buildApp());
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; maxSlides: number };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("html2pptx");
    expect(body.maxSlides).toBeGreaterThan(0);
  });
});

describe("POST /api/v1/validate", () => {
  it("HTML valid -> 200, valid true, satu slide", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/validate", { html: "<h1>Hi</h1>" });
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.slides).toBe(1);
    expect(body.elements).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("body tanpa field html -> 400 input_tidak_valid", async () => {
    const base = await listen(buildApp());
    const missing = await post(base, "/validate", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("input_tidak_valid");

    const blank = await post(base, "/validate", { html: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe("input_tidak_valid");
  });

  it("options.format tidak dikenal -> 400 dengan pesan jelas", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/validate", {
      html: "<h1>Hi</h1>",
      options: { format: "21:9" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("input_tidak_valid");
    expect(body.message.toLowerCase()).toContain("format");
  });

  it("CSS tak didukung muncul sebagai warning dengan nama property", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/validate", {
      html: "<style>h1 { filter: blur(2px) }</style><h1>Hi</h1>",
    });
    expect(status).toBe(200);
    const filterWarning = (body.warnings as Array<{ property?: string }>).find(
      (warning) => warning.property === "filter",
    );
    expect(filterWarning).toBeDefined();
    expect(body.stats.warnings).toBeGreaterThan(0);
  });

  it("selector tak didukung dan JS inline dilaporkan sebagai warning", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/validate", {
      html: "<script>alert(1)</script><style>div:has(> p) { color: red }</style><h1>Hi</h1>",
    });
    const properties = (body.warnings as Array<{ property?: string; element?: string }>).map((w) => w.property ?? w.element);
    expect(properties).toContain("script");
  });

  it("options.mode tidak dikenal -> 400", async () => {
    const base = await listen(buildApp());
    const { status } = await post(base, "/validate", { html: "<h1>x</h1>", options: { mode: "magic" } });
    expect(status).toBe(400);
  });
});

describe("POST /api/v1/preview", () => {
  it("dua section data-slide -> dua slide", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/preview", { html: TWO_SLIDE_HTML });
    expect(status).toBe(200);
    expect(body.slides).toHaveLength(2);
    expect(body.slides[0].elements[0].text).toBe("Slide satu");
    expect(body.slides[1].elements[0].text).toBe("Slide dua");
  });

  it("format 16:9 default -> slideWidthPx 1280 dan tinggi 720", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/preview", { html: TEST_HTML });
    expect(status).toBe(200);
    expect(body.slideWidthPx).toBeCloseTo(1280, 1);
    expect(body.slideHeightPx).toBeCloseTo(720, 1);
    expect(body.slideWidthInch).toBeCloseTo(13.333, 2);
    expect(body.slideHeightInch).toBeCloseTo(7.5, 2);
  });

  it("format 4:3 menghasilkan slide 10 x 7.5 inci", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/preview", {
      html: TEST_HTML,
      options: { format: "4:3" },
    });
    expect(body.slideWidthPx).toBeCloseTo(960, 1);
    expect(body.slideHeightPx).toBeCloseTo(720, 1);
  });

  it("preview tidak menulis berkas .pptx apa pun", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/preview", { html: TEST_HTML });
    expect(body.filename).toBeUndefined();
    expect(body.downloadUrl).toBeUndefined();
  });
});

describe("POST /api/v1/convert", () => {
  it("happy path -> file .pptx valid yang bisa diunduh", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/convert", { html: TEST_HTML });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.filename).toMatch(/\.pptx$/);
    expect(body.downloadUrl).toMatch(/^\/output\/.+\.pptx$/);
    expect(body.bytes).toBeGreaterThan(0);

    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);

    // Guardrail: file benar-benar valid, bukan sekadar klaim sukses.
    expect(await validatePptxStructure(filePath)).toEqual([]);

    const download = await fetch(`${base}${body.downloadUrl}`);
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(body.bytes);
  });

  it("isi file PPTX memuat slide dengan teks dari HTML", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/convert", { html: TEST_HTML });
    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);

    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slideXml).toContain("Deck dari API");
  });

  it("format custom mengubah ukuran slide pada endpoint preview", async () => {
    const base = await listen(buildApp());
    const custom = { format: "custom", customSize: { widthInch: 10, heightInch: 5.625 } };
    const { status, body } = await post(base, "/preview", { html: TEST_HTML, options: custom });
    expect(status).toBe(200);
    expect(body.slideWidthPx).toBeCloseTo(960, 1); // 10in * 96
    expect(body.slideHeightPx).toBeCloseTo(540, 1); // 5.625in * 96
    expect(body.slideWidthInch).toBeCloseTo(10, 3);
    expect(body.slideHeightInch).toBeCloseTo(5.625, 3);
  });

  it("convert dengan format custom menulis ukuran slide custom ke file", async () => {
    const base = await listen(buildApp());
    const custom = { format: "custom", customSize: { widthInch: 10, heightInch: 5.625 } };
    const { status, body } = await post(base, "/convert", { html: TEST_HTML, options: custom });
    expect(status).toBe(200);

    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);
    expect(await validatePptxStructure(filePath)).toEqual([]);

    const zip = await JSZip.loadAsync(await readFile(filePath));
    const presentationXml = await zip.file("ppt/presentation.xml")!.async("string");
    const sldSz = /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(presentationXml);
    expect(sldSz).not.toBeNull();

    // 1 inch = 914400 EMU, jadi 10in x 5.625in harus muncul persis di sldSz.
    expect(Number(sldSz![1])).toBeCloseTo(10 * 914400, -3);
    expect(Number(sldSz![2])).toBeCloseTo(5.625 * 914400, -3);
  });

  it("template dengan data-pptx-ignore tetap menghasilkan file valid", async () => {
    const base = await listen(buildApp());
    const html = `
      <section data-slide style="padding: 40px">
        <p data-pptx-ignore>Instruksi internal yang tidak boleh muncul</p>
        <h1>Slide bersih</h1>
      </section>
    `;
    const { status, body } = await post(base, "/convert", { html });
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);
    expect(await validatePptxStructure(filePath)).toEqual([]);

    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slideXml).toContain("Slide bersih");
    // `data-pptx-ignore` membuang elemen beserta subtrenya: teks yang di-ignore
    // tidak boleh bocor keluar, bahkan melalui pembungkus transparan.
    expect(slideXml).not.toContain("Instruksi internal");
  });

  it("bullet list dan numbered list benar-benar jadi buChar/buAutoNum di XML", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/convert", {
      html: "<section data-slide><ul><li>Penting</li></ul><ol><li>Pertama</li></ol></section>",
    });
    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);

    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await zip.file("ppt/slides/slide1.xml")!.async("string");

    // pptxgenjs hanya menulis <a:buChar> bila `bullet` ada pada run yang
    // membawa teks; glyph-nya harus berupa kode hex 4 digit.
    expect(slideXml).toContain("<a:buChar char=\"&#x2022;\"/>");
    expect(slideXml).toContain("<a:buAutoNum");
    expect(slideXml).toContain("Penting");
    expect(slideXml).toContain("Pertama");
  });

  it("run dalam paragraf tetap punya hyperlink yang benar-benar ditulis ke XML", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/convert", {
      html: '<section data-slide><p>Baca <a href="https://example.com/x">tautan</a> sekarang</p></section>',
    });
    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);

    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(slideXml).toContain("<a:hlinkClick");

    const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    expect(rels).toContain("https://example.com/x");
  });

  it("convert tanpa html -> 400 dan tidak menulis berkas", async () => {
    const base = await listen(buildApp());
    const { status, body } = await post(base, "/convert", {});
    expect(status).toBe(400);
    expect(body.error).toBe("input_tidak_valid");
    expect(body.downloadUrl).toBeUndefined();
  });

  it("nama file diturunkan dari judul opsi dan tetap aman untuk filesystem", async () => {
    const base = await listen(buildApp());
    const { body } = await post(base, "/convert", {
      html: TEST_HTML,
      options: { title: "Deck Kopi / Susu 2026!" },
    });
    const filePath = outputFilePath(body.downloadUrl);
    createdFiles.push(filePath);
    expect(body.filename).toMatch(/^deck-kopi-susu-2026-[0-9]+\.pptx$/);
    expect(await validatePptxStructure(filePath)).toEqual([]);
  });
});
