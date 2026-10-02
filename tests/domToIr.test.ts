import { describe, expect, it } from "vitest";

import { convertHtmlToPresentation } from "../src/convert/pipeline";
import { defaultOptions, type ConversionOptions } from "../src/convert/options";
import type { Presentation, SlideElement, TableContent, TextContent } from "../src/shared/ir";

/**
 * Pemetaan DOM -> IR: tag HTML apa yang menjadi objek PowerPoint apa, dan
 * bagaimana struktur teks (paragraf/run) dibentuk.
 */

async function convert(html: string, options?: Partial<ConversionOptions>): Promise<Presentation> {
  const { presentation } = await convertHtmlToPresentation(html, { ...defaultOptions(), ...options });
  return presentation;
}

async function elementsOf(html: string): Promise<SlideElement[]> {
  return (await convert(html)).slides[0]!.elements;
}

function textOf(element: SlideElement): TextContent {
  return element.content as TextContent;
}

function tableOf(element: SlideElement): TableContent {
  return element.content as TableContent;
}

/** Elemen pertama dengan sourceTag tertentu (a Mighty wrapper bisa ikut muncul). */
function byTag(elements: SlideElement[], sourceTag: string): SlideElement {
  const found = elements.find((el) => el.sourceTag === sourceTag);
  if (!found) throw new Error(`tidak ada elemen dari <${sourceTag}>`);
  return found;
}

describe("domToIr — judul", () => {
  it("<h1>Hello</h1> jadi satu elemen text dengan satu paragraf dan satu run", async () => {
    const elements = await elementsOf("<h1>Hello</h1>");
    const h1 = byTag(elements, "h1");

    expect(h1.type).toBe("text");
    expect(h1.sourceTag).toBe("h1");
    expect(h1.isFallback).toBe(false);
    expect(h1.id).toMatch(/^el-\d+$/);

    const content = textOf(h1);
    expect(content.paragraphs).toHaveLength(1);
    expect(content.paragraphs[0]!.runs).toHaveLength(1);
    expect(content.paragraphs[0]!.runs[0]!.text).toBe("Hello");

    expect(h1.style.bold).toBe(true);
    expect(h1.style.fontSizePx).toBe(32);
    expect(h1.style.fontFamily).toBe("Arial");
    expect(h1.style.color).toBe("#000000");
    expect(h1.style.background).toBeNull();
    expect(h1.style.bullet).toBeNull();
  });

  it("geometry h1 memakai koordinat absolut px", async () => {
    const h1 = byTag(await elementsOf("<h1>Hello</h1>"), "h1");
    expect(h1.box.x).toBe(0);
    expect(h1.box.y).toBe(21); // margin-top default h1
    expect(h1.box.width).toBeCloseTo(1279.968, 3); // 13.333in * 96px
    expect(h1.box.height).toBeCloseTo(38.4, 3); // 32px * line-height 1.2
  });

  it("wrapper transparan tidak ikut memetakan teks anak -> tidak ada teks dobel", async () => {
    // Wrapper struktural yang transparan hanya memetakan konten inline-nya
    // sendiri; blok anak memetakan dirinya sendiri. Tanpa pemisahan ini,
    // "Hello" muncul dua kali di slide.
    const elements = await elementsOf("<h1>Hello</h1>");
    const withHello = elements.filter(
      (el) => el.type === "text" && textOf(el).paragraphs[0]?.runs[0]?.text === "Hello",
    );
    expect(elements).toHaveLength(1);
    expect(withHello).toHaveLength(1);
  });

  it("wrapper transparan tetap memetakan konten inline-nya sendiri", async () => {
    // `<div>Teks <strong>tebal</strong></div>` tidak punya elemen blok anak,
    // jadi wrapper-nya yang memiliki teks tersebut.
    const elements = await elementsOf("<div>Teks <strong>tebal</strong></div>");
    expect(elements).toHaveLength(1);
    const div = byTag(elements, "div");
    expect(div.type).toBe("text");
    expect(textOf(div).paragraphs[0]!.runs.map((r) => r.text)).toEqual(["Teks ", "tebal"]);
  });
});

describe("domToIr — penggabungan run inline (regresi penting)", () => {
  it('<p>Hello <strong>world</strong></p> menghasilkan SATU paragraf dengan dua run', async () => {
    const elements = await elementsOf("<p>Hello <strong>world</strong></p>");
    const p = byTag(elements, "p");
    expect(p.type).toBe("text");

    const paragraphs = textOf(p).paragraphs;
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.runs.map((run) => run.text)).toEqual(["Hello ", "world"]);

    expect(paragraphs[0]!.runs[0]!.bold).toBe(false);
    expect(paragraphs[0]!.runs[1]!.bold).toBe(true);
  });

  it("tiga run inline tetap satu paragraf dan bold hanya pada <strong>", async () => {
    const paragraphs = textOf(
      byTag(await elementsOf("<p>Otomatis dan <strong>cepat</strong>.</p>"), "p"),
    ).paragraphs;
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.runs.map((run) => [run.text, run.bold])).toEqual([
      ["Otomatis dan ", false],
      ["cepat", true],
      [".", false],
    ]);
  });

  it("<em> jadi run italic, bukan elemen terpisah", async () => {
    const elements = await elementsOf("<p>Normal <em>miring</em></p>");
    const p = byTag(elements, "p");
    const runs = textOf(p).paragraphs[0]!.runs;
    expect(runs.map((run) => run.text)).toEqual(["Normal ", "miring"]);
    expect(runs[1]!.italic).toBe(true);
    expect(elements.filter((el) => el.sourceTag === "em")).toHaveLength(0);
  });
});

describe("domToIr — daftar", () => {
  it("<ul> menghasilkan dua elemen text dengan bullet", async () => {
    const elements = (await elementsOf("<ul><li>a</li><li>b</li></ul>")).filter((el) => el.type === "text");
    expect(elements).toHaveLength(2);
    expect(elements.map((el) => el.sourceTag)).toEqual(["li", "li"]);
    for (const element of elements) {
      expect(element.style.bullet).not.toBeNull();
      expect(textOf(element).paragraphs[0]!.bullet).not.toBeNull();
      expect(element.style.listIndex).toBeNull();
    }
    expect(elements.map((el) => textOf(el).paragraphs[0]!.runs[0]!.text)).toEqual(["a", "b"]);
  });

  it("<ol> memberi listIndex 1 dan 2 tanpa bullet", async () => {
    const elements = (await elementsOf("<ol><li>a</li><li>b</li></ol>")).filter((el) => el.type === "text");
    expect(elements).toHaveLength(2);
    expect(elements.map((el) => el.style.listIndex)).toEqual([1, 2]);
    for (const element of elements) {
      expect(element.style.bullet).toBeNull();
      expect(textOf(element).paragraphs[0]!.bullet).toBeNull();
    }
  });

  it("<ol start=\"3\"> melanjutkan penomoran", async () => {
    const elements = (await elementsOf('<ol start="3"><li>a</li><li>b</li></ol>')).filter(
      (el) => el.type === "text",
    );
    expect(elements.map((el) => el.style.listIndex)).toEqual([3, 4]);
  });

  it("container <ul>/<ol> sendiri tidak menjadi elemen slide", async () => {
    const elements = await elementsOf("<ul><li>a</li></ul>");
    expect(elements.map((el) => el.type)).toEqual(["text"]);
  });
});

describe("domToIr — tabel", () => {
  const html =
    "<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>";

  const twoColumns =
    '<table style="width: 600px"><thead><tr><th>Item</th><th>Harga</th></tr></thead>' +
    "<tbody><tr><td>Kopi</td><td>18.000</td></tr></tbody></table>";

  it("satu elemen table dengan hasHeaderRow true", async () => {
    const elements = await elementsOf(html);
    const tables = elements.filter((el) => el.type === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0]!.sourceTag).toBe("table");

    const table = tableOf(tables[0]!);
    expect(table.hasHeaderRow).toBe(true);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]![0]!.text).toBe("H");
    expect(table.rows[1]![0]!.text).toBe("C");
  });

  it("grid bersifat persegi panjang dan lebar kolom dibagi rata", async () => {
    const tables = (await elementsOf(twoColumns)).filter((el) => el.type === "table");
    const table = tableOf(tables[0]!);

    expect(new Set(table.rows.map((row) => row.length)).size).toBe(1);
    expect(table.rows[0]).toHaveLength(2);
    expect(table.colWidthsPx).toHaveLength(2);
    // Tabel 600px dengan 2 kolom tanpa width eksplisit -> 300px per kolom.
    expect(table.colWidthsPx).toEqual([300, 300]);
    // Tinggi baris = max(tinggi isi, fontSize * lineHeight * 1.4) = 16 * 1.2 * 1.4.
    expect(table.rowHeightsPx).toEqual([26.88, 26.88]);
    expect(table.rows[0]![0]!.text).toBe("Item");
    expect(table.rows[1]![1]!.text).toBe("18.000");
  });

  it("sel header ditandai bold dan sel td tidak", async () => {
    const tables = (await elementsOf(html)).filter((el) => el.type === "table");
    const table = tableOf(tables[0]!);
    expect(table.rows[0]![0]!.bold).toBe(true);
    expect(table.rows[1]![0]!.bold).toBe(false);
  });

  it("tabel tanpa thead -> hasHeaderRow false", async () => {
    const tables = (await elementsOf("<table><tr><td>a</td></tr></table>")).filter((el) => el.type === "table");
    const table = tableOf(tables[0]!);
    expect(table.hasHeaderRow).toBe(false);
    expect(table.rows).toHaveLength(1);
  });

  it("tabel kosong tidak menghasilkan elemen table", async () => {
    expect((await elementsOf("<table></table>")).filter((el) => el.type === "table")).toHaveLength(0);
  });
});

describe("domToIr — shape dan line", () => {
  it('div dengan background:#ff0000 jadi shape dengan background "#ff0000"', async () => {
    const elements = await elementsOf('<div style="background:#ff0000; height: 40px">x</div>');
    const shape = elements.find((el) => el.type === "shape")!;
    expect(shape).toBeDefined();
    expect(shape.style.background).toBe("#ff0000");
    expect(shape.sourceTag).toBe("div");
    expect((shape.content as { preset: string }).preset).toBe("rect");
  });

  it("div tanpa background dan tanpa border tidak menghasilkan shape", async () => {
    const elements = await elementsOf("<div><p>teks</p></div>");
    expect(elements.filter((el) => el.type === "shape")).toHaveLength(0);
    expect(byTag(elements, "p").type).toBe("text");
  });

  it("div dengan border saja tetap menjadi shape", async () => {
    const elements = await elementsOf('<div style="border: 1px solid #000000; height: 40px">x</div>');
    const shape = elements.find((el) => el.type === "shape")!;
    expect(shape.style.background).toBeNull();
    expect(shape.style.border).toEqual({ color: "#000000", widthPx: 1, style: "solid" });
  });

  it("border-radius memilih preset roundRect", async () => {
    const elements = await elementsOf(
      '<div style="background:#00ff00; border-radius: 8px; height: 40px">x</div>',
    );
    const shape = elements.find((el) => el.type === "shape")!;
    expect((shape.content as { preset: string }).preset).toBe("roundRect");
  });

  it("<hr> menjadi elemen line", async () => {
    const elements = await elementsOf("<hr>");
    expect(elements).toHaveLength(1);
    expect(elements[0]!.type).toBe("line");
    expect(elements[0]!.sourceTag).toBe("hr");
    expect((elements[0]!.content as { preset: string }).preset).toBe("line");
    expect(elements[0]!.box.height).toBeGreaterThan(0);
  });
});

describe("domToIr — gambar", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9QzzCKRsEoGgWjAABkQPhfOZj0kAAAAASUVORK5CYII=";

  it("img data URI menjadi elemen image dengan dataUri yang benar", async () => {
    const elements = await elementsOf(`<img src="${png}" alt="Logo">`);
    expect(elements).toHaveLength(1);
    expect(elements[0]!.type).toBe("image");
    expect(elements[0]!.sourceTag).toBe("img");

    const content = elements[0]!.content as { dataUri: string; naturalWidthPx: number; alt: string | null };
    expect(content.dataUri.startsWith("data:image/png")).toBe(true);
    expect(content.alt).toBe("Logo");
    expect(content.naturalWidthPx).toBe(10); // PNG 10x10 di header
    expect(content.naturalHeightPx).toBe(10);
  });

  it("img dengan src yang tidak bisa diselesaikan dilewati dan diberi warning", async () => {
    const presentation = await convert('<img src="https://tidak-ada.example/a.png">');
    expect(presentation.slides[0]!.elements).toHaveLength(0);
  });
});

describe("domToIr — hyperlink", () => {
  it("hyperlink pada elemen <a> melekat ke run", async () => {
    // Kotak teks mewarisi element dari line box sintetis (null), jadi target
    // tautan harus diteruskan turun walk inline, bukan dibaca dari kotak itu.
    const elements = await elementsOf('<a href="https://example.com">link</a>');
    const runs = textOf(elements[0]!).paragraphs[0]!.runs;
    expect(runs.map((run) => run.text)).toEqual(["link"]);
    expect(runs[0]!.hyperlink).toBe("https://example.com");
  });

  it("hyperlink di dalam paragraf menempel pada run yang tepat saja", async () => {
    const elements = await elementsOf('<p>Baca <a href="https://x.test">sini</a> sekarang</p>');
    const runs = textOf(byTag(elements, "p")).paragraphs[0]!.runs;
    // Spasi di antara dua run inline dipertahankan persis seperti di markup.
    expect(runs.map((run) => run.text)).toEqual(["Baca ", "sini", " sekarang"]);
    expect(runs.map((run) => run.hyperlink)).toEqual([null, "https://x.test", null]);
  });
});

describe("domToIr — data-pptx-ignore", () => {
  it("menghapus elemen dari hasil slide", async () => {
    const elements = await elementsOf(
      '<div><p data-pptx-ignore>rahasia <strong>sekali</strong></p><p>publik</p></div>',
    );
    expect(elements.filter((el) => el.sourceTag === "p")).toHaveLength(1);
    expect(byTag(elements, "p").type).toBe("text");
  });

  it("teks yang di-ignore tidak bocor ke elemen mana pun pada slide", async () => {
    const elements = await elementsOf(
      '<div><p data-pptx-ignore>rahasia <strong>sekali</strong></p><p>publik</p></div>',
    );
    // Wrapper transparannya tidak punya konten inline sendiri, jadi ia tidak
    // menjadi elemen; konten yang tampil hanyalah paragraf yang tidak di-ignore.
    expect(elements.filter((el) => el.sourceTag === "p")).toHaveLength(1);
    expect(byTag(elements, "p").type).toBe("text");

    const allText = elements
      .map((el) => JSON.stringify(textOf(el)))
      .join("|");
    expect(allText).not.toContain("rahasia");
    expect(allText).not.toContain("sekali");
    expect(allText).toContain("publik");
  });
});

describe("domToIr — slide splitting dan background", () => {
  it('data-background="#123456" pada section dipakai sebagai background slide', async () => {
    // `data-background` di-whitelist eksplisit karena pipeline membacanya dan
    // konvensinya tidak memakai namespace.
    const presentation = await convert('<section data-slide data-background="#123456"><h1>Judul</h1></section>');
    expect(presentation.slides[0]!.background).toBe("#123456");
  });

  it('data-slide-background="#123456" dipakai sebagai background slide', async () => {
    const presentation = await convert(
      '<section data-slide data-slide-background="#123456"><h1>Judul</h1></section>',
    );
    expect(presentation.slides[0]!.background).toBe("#123456");
  });

  it("dua <section data-slide> menghasilkan dua slide", async () => {
    const presentation = await convert(
      '<section data-slide><h1>Satu</h1></section><section data-slide><h1>Dua</h1></section>',
    );
    expect(presentation.slides).toHaveLength(2);
    expect(presentation.slides.map((slide) => slide.sourceIndex)).toEqual([0, 1]);
    expect(textOf(byTag(presentation.slides[0]!.elements, "h1")).paragraphs[0]!.runs[0]!.text).toBe("Satu");
    expect(textOf(byTag(presentation.slides[1]!.elements, "h1")).paragraphs[0]!.runs[0]!.text).toBe("Dua");
  });

  it("tanpa data-slide hasilnya tepat satu slide", async () => {
    const presentation = await convert("<h1>Satu</h1><p>Dua</p>");
    expect(presentation.slides).toHaveLength(1);
    expect(presentation.slides[0]!.elements.filter((el) => el.sourceTag === "h1")).toHaveLength(1);
    expect(presentation.slides[0]!.elements.filter((el) => el.sourceTag === "p")).toHaveLength(1);
  });

  it("background default deck dipakai ketika section tidak menetapkannya", async () => {
    const presentation = await convert("<section data-slide><h1>Judul</h1></section>", {
      background: "#123456",
    });
    expect(presentation.slides[0]!.background).toBe("#123456");
    expect(presentation.defaultBackground).toBe("#123456");
  });

  it("slide dimensions mengikuti format 16:9 default (13.333in x 7.5in)", async () => {
    const presentation = await convert("<h1>x</h1>");
    expect(presentation.widthPx).toBeCloseTo(1279.968, 3); // 13.333 * 96
    expect(presentation.heightPx).toBe(720); // 7.5 * 96
  });
});

describe("domToIr — robustness", () => {
  it("HTML tidak tertutup tidak melempar exception", async () => {
    await expect(convert("<h1>Hello<p>World")).resolves.toBeDefined();
    await expect(convert("<div><span>tidak ditutup")).resolves.toBeDefined();
  });

  it("elemen tanpa konten tidak menghasilkan elemen slide kosong", async () => {
    expect((await elementsOf("<div></div>")).filter((el) => el.sourceTag === "div")).toHaveLength(0);
    expect((await elementsOf("<p></p>")).filter((el) => el.sourceTag === "p")).toHaveLength(0);
  });

  it("id elemen unik dan berurutan dalam satu slide", async () => {
    const elements = await elementsOf("<h1>a</h1><h2>b</h2><p>c</p>");
    const ids = elements.map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("el-1");
    expect(ids).toEqual([...ids].sort());
  });
});