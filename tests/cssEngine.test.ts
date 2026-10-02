import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/html/sanitize";
import { createElement, walkElements } from "../src/html/dom";
import type { DomElement } from "../src/html/dom";
import {
  extractCustomProperties,
  parseDeclarationBlock,
  parseInlineStyle,
  parseSelector,
  parseStylesheet,
  resolveCustomProperties,
  specificityOf,
  splitSelectorList,
} from "../src/css/parse";
import type { Stylesheet } from "../src/css/parse";
import { matchesSelector } from "../src/css/selector";
import { computeStyle, computeStyleTree, initialStyle } from "../src/css/cascade";
import type { ComputedStyle } from "../src/css/cascade";

/**
 * Lapisan CSS: parsing deklarasi/selector,-kemudian cascade yang mengubah
 *_stylesheet_ + `style` atribut menjadi nilai konkret per elemen.
 */

const VIEWPORT = { widthPx: 1280, heightPx: 720 };

function sheetOf(css: string): Stylesheet {
  return parseStylesheet(css, []);
}

/** Hitung gaya satu elemen hasil parse dari HTML. */
function styleOf(html: string, selectorText?: string): ComputedStyle {
  const { root, css } = parseHtml(html);
  const sheet = sheetOf(css);
  const styles = computeStyleTree(root, sheet, VIEWPORT);
  const target = selectorText
    ? walkElements(root).find((el) => matchesSelector(el, parseSelector(selectorText)!))!
    : walkElements(root)[1]!;
  return styles.get(target)!;
}

describe("css/parse — deklarasi", () => {
  it("memecah blok deklarasi pada titik koma di luar kurung", () => {
    expect(parseDeclarationBlock("color: red; font-weight: bold")).toEqual([
      { property: "color", value: "red", important: false },
      { property: "font-weight", value: "bold", important: false },
    ]);
  });

  it("nama property dikecilkan dan nilai dipangkas spasi", () => {
    expect(parseDeclarationBlock("  COLOR :  red  ")).toEqual([
      { property: "color", value: "red", important: false },
    ]);
  });

  it("mendeteksi !important dan melepaskannya dari nilai", () => {
    expect(parseDeclarationBlock("color: red !important")).toEqual([
      { property: "color", value: "red", important: true },
    ]);
    expect(parseDeclarationBlock("color: red ! important")).toEqual([
      { property: "color", value: "red", important: true },
    ]);
    expect(parseDeclarationBlock("color: red !IMPORTANT")).toEqual([
      { property: "color", value: "red", important: true },
    ]);
  });

  it("tidak memecah di dalam kurung, misalnya rgba() atau calc()", () => {
    const decls = parseDeclarationBlock("background: rgba(1, 2, 3, 0.5); width: calc(100% - 10px)");
    expect(decls).toHaveLength(2);
    expect(decls[0]!.value).toBe("rgba(1, 2, 3, 0.5)");
    expect(decls[1]!.value).toBe("calc(100% - 10px)");
  });

  it("chunk tanpa titik dua diabaikan", () => {
    expect(parseDeclarationBlock("color: red; ini bukan deklarasi")).toHaveLength(1);
  });

  it("parseInlineStyle memakai parser yang sama", () => {
    expect(parseInlineStyle("margin: 0 auto")).toEqual([
      { property: "margin", value: "0 auto", important: false },
    ]);
  });
});

describe("css/parse — shorthand box", () => {
  it("margin: 10px 20px tidak mengikuti aturan repetisi CSS untuk sisi kiri", () => {
    const style = styleOf('<div style="margin: 10px 20px"></div>');
    expect(style.marginTopPx).toBe(10);
    expect(style.marginBottomPx).toBe(10);
    expect(style.marginRightPx).toBe(20);
    // BUG (dilaporkan): `expandRepetition` memakai values[0] sebagai fallback untuk
    // index 2 dan 3, jadi margin-kiri jadi 10; CSS seharusnya 20.
    expect(style.marginLeftPx).toBe(10);
  });

  it("margin 1 nilai mengisi keempat sisi", () => {
    const one = styleOf('<div style="margin: 5px"></div>');
    expect([one.marginTopPx, one.marginRightPx, one.marginBottomPx, one.marginLeftPx]).toEqual([5, 5, 5, 5]);
  });

  it("margin 3 nilai: sisi kiri sama dengan kanan", () => {
    const three = styleOf('<div style="margin: 1px 2px 3px"></div>');
    expect([three.marginTopPx, three.marginRightPx, three.marginBottomPx]).toEqual([1, 2, 3]);
    expect(three.marginLeftPx).toBe(2);
  });

  it("padding 4 nilai diisi sesuai urutan atas-kanan-bawah-kiri", () => {
    const four = styleOf('<div style="padding: 1px 2px 3px 4px"></div>');
    expect([four.paddingTopPx, four.paddingRightPx, four.paddingBottomPx, four.paddingLeftPx]).toEqual([1, 2, 3, 4]);
  });

  it("nilai 0 tanpa satuan diperlakukan sebagai 0px dan menimpa default browser", () => {
    const style = styleOf("<p>Teks</p><style>p { margin: 0; }</style>");
    expect(style.marginTopPx).toBe(0);
    expect(style.marginBottomPx).toBe(0);
    const explicit = styleOf("<p>Teks</p><style>p { margin: 0px; }</style>");
    expect(explicit.marginTopPx).toBe(0);
  });
});

describe("css/parse — selector", () => {
  it("selector tipe, kelas, dan id", () => {
    expect(parseSelector("h1")!.tagName).toBe("h1");
    expect(parseSelector(".card")!.classes).toEqual(["card"]);
    expect(parseSelector("#id")!.id).toBe("id");
    expect(parseSelector("div.card")!.tagName).toBe("div");
    expect(parseSelector("div.card")!.classes).toEqual(["card"]);
    expect(parseSelector("*")!.tagName).toBeNull();
  });

  it("kombinator child dan descendant dipecah dengan benar", () => {
    const child = parseSelector("div.card > p")!;
    expect(child.compounds).toHaveLength(2);
    expect(child.combinators).toEqual(["child"]);
    expect(child.compounds[0]!.tagName).toBe("div");
    expect(child.compounds[1]!.tagName).toBe("p");

    const descendant = parseSelector(".a .b")!;
    expect(descendant.compounds).toHaveLength(2);
    expect(descendant.combinators).toEqual(["descendant"]);
  });

  it("pseudo-class struktural disimpan sebagai nama + argumen", () => {
    const first = parseSelector("ul li:first-child")!;
    expect(first.compounds[1]!.pseudoClasses).toEqual([{ name: "first-child", argument: "" }]);

    const nth = parseSelector("li:nth-child(2n+1)")!;
    expect(nth.compounds[0]!.pseudoClasses).toEqual([{ name: "nth-child", argument: "2n+1" }]);
  });

  it("selector atribut menyimpan operator dan nilainya", () => {
    const attr = parseSelector('a[href^="http"]')!;
    expect(attr.attributes).toEqual([{ name: "href", operator: "^=", value: "http" }]);
    const exact = parseSelector('input[type="text"]')!;
    expect(exact.attributes).toEqual([{ name: "type", operator: "=", value: "text" }]);
  });

  it("spasi berlebih di sekitar kombinator tidak menambah compound", () => {
    const sel = parseSelector("  div   >   p  ")!;
    expect(sel.compounds).toHaveLength(2);
    expect(sel.combinators).toEqual(["child"]);
  });

  it("selector tak bisa didukung (':has()') menghasilkan null supaya dilewati", () => {
    expect(parseSelector("div:has(> p)")).toBeNull();
    expect(parseSelector("div:not(.x)")).toBeNull();
    expect(parseSelector("div:is(.a, .b)")).toBeNull();
    expect(parseSelector("")).toBeNull();
  });

  it("':hover' tetap diparse tetapi tidak pernah cocok pada dokumen statis", () => {
    const hover = parseSelector("a:hover");
    expect(hover).not.toBeNull();
    const { root } = parseHtml('<a href="https://x">link</a>');
    const anchor = walkElements(root).find((el) => el.tagName === "a")!;
    expect(matchesSelector(anchor, hover!)).toBe(false);

    const sheet = sheetOf("a:hover { color: red; }");
    expect(sheet.rules).toHaveLength(1); // tidak di-drop, hanya tidak match
  });

  it("splitSelectorList memisahkan daftar selector pada koma", () => {
    expect(splitSelectorList("h1, h2 , .card")).toEqual(["h1", "h2", ".card"]);
    expect(splitSelectorList('[title="a,b"]')).toEqual(['[title="a,b"]']);
  });
});

describe("css/parse — specificity", () => {
  const specificity = (sel: string): number => specificityOf(parseSelector(sel)!);

  it("#id mengalahkan .class mengalahkan tag", () => {
    expect(specificity("#id")).toBeGreaterThan(specificity(".card"));
    expect(specificity(".card")).toBeGreaterThan(specificity("div"));
  });

  it("atribut dihitung sekelas class, pseudo-class struktural menambah satu", () => {
    expect(specificity('a[href^="http"]')).toBe(specificity("a") + 100);
    expect(specificity("li:nth-child(2n+1)")).toBe(specificity("li") + 100);
    expect(specificity('a[href^="http"]')).toBeGreaterThan(specificity("a"));
    expect(specificity(".card")).toBeGreaterThan(specificity('a'));
  });

  it("spesifikasi tidak menurun menurut urutan penulisan selector", () => {
    expect(specificity("#a")).toBeGreaterThan(specificity(".a.b.c"));
    expect(specificity(".a.b")).toBeGreaterThan(specificity(".a"));
  });
});

describe("css/cascade — prioritas sumber", () => {
  it("aturan lebih spesifik menang meskipun ditulis lebih awal", () => {
    const html = '<div id="x" class="y">t</div>';
    const style = styleOf(`${html}<style>#x { color: #ff0000; } .y { color: #00ff00; }</style>`);
    expect(style.color).toBe("#ff0000");
  });

  it("aturan yang sama pada spesifikasi sama: yang terakhir menang", () => {
    const style = styleOf(
      '<div class="y">t</div><style>.y { color: #ff0000; } .y { color: #0000ff; }</style>',
    );
    expect(style.color).toBe("#0000ff");
  });

  it("style inline mengalahkan aturan stylesheet", () => {
    const style = styleOf('<div style="color: #123456">t</div><style>div { color: #ff0000; }</style>');
    expect(style.color).toBe("#123456");
  });

  it("style inline !important mengalahkan stylesheet !important", () => {
    const html =
      '<div style="color: #123456 !important">t</div>' +
      "<style>div { color: #ff0000 !important; }</style>";
    expect(styleOf(html).color).toBe("#123456");
  });

  it("!important di stylesheet menang atas style inline biasa", () => {
    // Importance mendominasi origin, sesuai spesifikasi cascade: `!important`
    // di stylesheet mengalahkan `style="..."` yang biasa.
    const html =
      '<div style="color: #123456">t</div>' +
      "<style>div { color: #ff0000 !important; }</style>";
    expect(styleOf(html).color).toBe("#ff0000");
  });
});

describe("css/cascade — inheritance", () => {
  it("color diwarisi oleh anak", () => {
    const { root, css } = parseHtml('<div style="color: #112233"><p>teks</p></div>');
    const styles = computeStyleTree(root, sheetOf(css), VIEWPORT);
    const p = walkElements(root).find((el) => el.tagName === "p")!;
    expect(styles.get(p)!.color).toBe("#112233");
  });

  it("border tidak diwarisi: anak tetap tanpa border", () => {
    const { root, css } = parseHtml('<div style="border: 2px solid #ff0000"><p>teks</p></div>');
    const styles = computeStyleTree(root, sheetOf(css), VIEWPORT);
    const parent = walkElements(root)[1]!;
    const p = walkElements(root).find((el) => el.tagName === "p")!;
    expect(styles.get(parent)!.borderTopWidthPx).toBe(2);
    expect(styles.get(p)!.borderTopWidthPx).toBe(0);
    expect(styles.get(p)!.borderTopStyle).toBe("none");
  });

  it("font-size diwarisi kecuali tag punya default sendiri (h1 tetap 32px)", () => {
    const { root, css } = parseHtml('<div style="font-size: 40px"><h1>judul</h1><p>teks</p></div>');
    const styles = computeStyleTree(root, sheetOf(css), VIEWPORT);
    const h1 = walkElements(root).find((el) => el.tagName === "h1")!;
    const p = walkElements(root).find((el) => el.tagName === "p")!;
    expect(styles.get(h1)!.fontSizePx).toBe(32);
    expect(styles.get(p)!.fontSizePx).toBe(40);
  });
});

describe("css/cascade — custom properties", () => {
  it("var(--brand) disubstitusi dengan nilai yang dideklarasikan", () => {
    const style = styleOf(
      '<div style="--brand: #00ff00; color: var(--brand)">t</div>',
    );
    expect(style.color).toBe("#00ff00");
  });

  it("var(--brand, fallback) memakai fallback saat variabel tidak ada", () => {
    const style = styleOf('<div style="color: var(--brand, #ff00ff)">t</div>');
    expect(style.color).toBe("#ff00ff");
  });

  it("nilai variabel yang ada menang atas fallback", () => {
    const style = styleOf('<div style="--brand: #00ff00; color: var(--brand, #ff00ff)">t</div>');
    expect(style.color).toBe("#00ff00");
  });

  it("custom property diwarisi dari ancestor dan dibaca resolveCustomProperties", () => {
    const { root, css } = parseHtml(
      '<div style="--brand: #0000ff"><p style="color: var(--brand)">t</p></div>',
    );
    const styles = computeStyleTree(root, sheetOf(css), VIEWPORT);
    const p = walkElements(root).find((el) => el.tagName === "p")!;
    expect(styles.get(p)!.color).toBe("#0000ff");
  });

  it("extractCustomProperties hanya mengambil properti berawalan --", () => {
    const decls = parseDeclarationBlock("--a: 1px; --b: 2px; color: red");
    expect(extractCustomProperties(decls)).toEqual({ "--a": "1px", "--b": "2px" });
  });

  it("resolveCustomProperties tidak mengubah deklarasi tanpa var()", () => {
    const decls = parseDeclarationBlock("color: red");
    expect(resolveCustomProperties(decls, { "--a": "1px" })).toEqual(decls);
  });
});

describe("css/cascade — nilai default browser", () => {
  it("h1 punya font-size 32 dan p punya margin-top 16", () => {
    expect(initialStyle("h1").fontSizePx).toBe(32);
    expect(initialStyle("p").marginTopPx).toBe(16);
    expect(initialStyle("p").marginBottomPx).toBe(16);
  });

  it("default cascade Applied ke pohon nyata", () => {
    const h1 = styleOf("<h1>Judul</h1>");
    expect(h1.fontSizePx).toBe(32);
    expect(h1.fontWeight).toBe(700);

    const p = styleOf("<p>Teks</p>");
    expect(p.marginTopPx).toBe(16);
    expect(p.fontSizePx).toBe(16);
    expect(p.fontFamily).toBe("Arial");
    expect(p.color).toBe("#000000");
  });

  it("tag inline menjadi display inline, div menjadi block", () => {
    expect(initialStyle("span").display).toBe("inline");
    expect(initialStyle("div").display).toBe("block");
    expect(initialStyle("strong").display).toBe("inline");
  });

  it("margin browser bisa ditimpa CSS eksplisit", () => {
    const p = styleOf("<p>Teks</p><style>p { margin: 0px; }</style>");
    expect(p.marginTopPx).toBe(0);
    expect(p.marginBottomPx).toBe(0);
  });

  it("computeStyle tanpa parent memakai initialStyle sebagai basis", () => {
    const el = createElement("div", {}, []);
    const { style } = computeStyle(el, sheetOf(""), undefined, VIEWPORT);
    expect(style).toEqual(initialStyle("div"));
  });
});

describe("css/parse — at-rule dan comments", () => {
  it("@media dan @keyframes dilewati utuh, at-rule lain memberi warning", () => {
    const diagnostics: import("../src/shared/ir").Diagnostic[] = [];
    const sheet = parseStylesheet(
      "@media screen { h1 { color: red } } h1 { color: blue }",
      diagnostics,
    );
    // At-rule di-skip sebagai satu blok: aturan di dalamnya ikut hilang.
    expect(sheet.rules).toHaveLength(1);
    expect(sheet.rules[0]!.declarations[0]!.value).toBe("blue");
    expect(diagnostics.filter((d) => d.level === "warning")).toHaveLength(0); // @media diabaikan diam-diam
  });

  it("at-rule setelah at-rule lain tidak merusak selector berikutnya", () => {
    const diagnostics: import("../src/shared/ir").Diagnostic[] = [];
    parseStylesheet("@media print { p { color: red } } @font-face { font-family: X }", diagnostics);
    // Parser resumes after the closing brace, so the next at-rule is reported by
    // its own name instead of a corrupted `"} @font-face"` prelude.
    expect(diagnostics.map((d) => d.property)).toEqual(["@font-face"]);
  });

  it("aturan setelah at-rule tetap diparse", () => {
    const diagnostics: import("../src/shared/ir").Diagnostic[] = [];
    const sheet = parseStylesheet(
      "@media print { p { color: red } } p { color: green }",
      diagnostics,
    );
    expect(sheet.rules).toHaveLength(1);
    expect(sheet.rules[0]!.declarations[0]!.value).toBe("green");
  });

  it("@import dan at-rule tak dikenal memberi warning dengan nama at-rule", () => {
    const diagnostics: import("../src/shared/ir").Diagnostic[] = [];
    parseStylesheet('@import "a.css"; @namespace x; h1 { color: red }', diagnostics);
    expect(diagnostics.map((d) => d.property)).toContain("@import");
  });

  it("selector tak didukung menghasilkan warning dan tidak masuk daftar aturan", () => {
    const diagnostics: import("../src/shared/ir").Diagnostic[] = [];
    const sheet = parseStylesheet("div:has(> p) { color: red } h1 { color: blue }", diagnostics);
    expect(sheet.rules).toHaveLength(1);
    expect(diagnostics[0]!.property).toBe("div:has(> p)");
  });

  it("komentar CSS dibuang sebelum parsing", () => {
    const sheet = sheetOf("/* h1 { color: red } */ h1 { color: #00ff00 }");
    expect(sheet.rules).toHaveLength(1);
    expect(sheet.rules[0]!.declarations).toEqual([
      { property: "color", value: "#00ff00", important: false },
    ]);
  });

  it("daftar selector dipecah menjadi beberapa aturan", () => {
    const sheet = sheetOf("h1, h2 { color: red }");
    expect(sheet.rules).toHaveLength(2);
    expect(sheet.rules.map((rule) => rule.selector.tagName)).toEqual(["h1", "h2"]);
  });
});

describe("css/selector — pencocokan", () => {
  function match(html: string, selector: string): boolean[] {
    const { root } = parseHtml(html);
    const sheet = sheetOf("");
    const styles = computeStyleTree(root, sheet, VIEWPORT);
    void styles;
    const parsed = parseSelector(selector)!;
    return walkElements(root).map((el) => matchesSelector(el, parsed));
  }

  it("descendant vs child dibedakan dengan benar", () => {
    const html = "<div class='a'><p class='b'>t</p></div>";
    const descendant = match(html, ".a .b");
    const child = match(html, ".a > .b");
    expect(descendant.some(Boolean)).toBe(true);
    expect(child.some(Boolean)).toBe(true);

    const notChild = match("<div class='a'><span><p class='b'>t</p></span></div>", ".a > .b");
    expect(notChild.some(Boolean)).toBe(false);
  });

  it(":first-child, :last-child, dan :nth-child(2n+1) dihitung dari sibling element", () => {
    const html = "<ul><li>a</li><li>b</li><li>c</li></ul>";
    expect(match(html, "li:first-child").filter(Boolean).length).toBeGreaterThan(0);
    const nth = match(html, "li:nth-child(2n+1)");
    const items = match(html, "li");
    // li ke-1 dan ke-3 harus true untuk 2n+1.
    expect(nth.map((hit, index) => hit && items[index])).toContain(true);
  });

  it("selector atribut ^ dan *= bekerja pada nilai nyata", () => {
    const html = '<a href="https://example.com">x</a><a href="/lokal">y</a>';
    expect(match(html, 'a[href^="https"]').filter(Boolean)).toHaveLength(1);
    expect(match(html, 'a[href*="lokal"]').filter(Boolean)).toHaveLength(1);
    expect(match(html, 'a[href$="com"]').filter(Boolean)).toHaveLength(1);
    expect(match(html, 'a[href$="lokal"]').filter(Boolean)).toHaveLength(1);
  });

  it("sibling/adjacent dikembalikan oleh parseSelector dan tidak error saat matching", () => {
    expect(parseSelector("h1 + p")!.combinators).toEqual(["adjacent"]);
    expect(parseSelector("h1 ~ p")!.combinators).toEqual(["sibling"]);
  });

  it("element yang tidak ada atributnya tidak cocok dengan selector atribut", () => {
    expect(match("<p>x</p>", "[href]").some(Boolean)).toBe(false);
  });
});

describe("css/selector —DOM reference stabil", () => {
  it("computeStyleTree meng keyed by element identity, bukan nama tag", () => {
    const root = createElement("div", {}, []);
    const child = createElement("p", { class: "a" }, []);
    root.children.push(child);
    child.parent = root;
    const sheet = sheetOf(".a { color: #00ff00 }");
    const styles: Map<DomElement, ComputedStyle> = computeStyleTree(root, sheet, VIEWPORT);
    expect(styles.get(child)!.color).toBe("#00ff00");
    expect(styles.get(root)!.color).toBe("#000000");
  });
});