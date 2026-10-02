import { describe, expect, it } from "vitest";

import { parseHtml } from "../src/html/sanitize";
import { parseStylesheet } from "../src/css/parse";
import { computeStyleTree } from "../src/css/cascade";
import { absoluteBoxOf, layoutTree, walkBoxes, type LayoutBox } from "../src/layout/layoutEngine";
import { elementChildren } from "../src/html/dom";
import type { DomElement } from "../src/html/dom";
import { readOverrides } from "../src/html/pptxAttributes";
import { inchToPx, pxToInch } from "../src/shared/units";

/**
 * Layout engine: DOM + computed style -> tree LayoutBox dalam CSS pixel.
 *
 * Helper di bawah menjalankan_pipeline_ secara manual (parse -> cascade -> layout)
 * supaya test bisa memeriksa kotak yang dikembalikan, bukan hanya IR akhir.
 */

const SLIDE_W = 1280;
const SLIDE_H = 720;

function layoutOf(html: string, width = SLIDE_W, height = SLIDE_H): LayoutBox {
  const { root, css } = parseHtml(html);
  const sheet = parseStylesheet(css, []);
  const styles = computeStyleTree(root, sheet, { widthPx: width, heightPx: height });

  // Sama seperti pipeline: data-pptx-x/y dibaca sebagai inci lalu dikonversi ke px.
  const overrides = new Map<DomElement, { x?: number; y?: number }>();
  const visit = (el: DomElement): void => {
    const overrides_ = readOverrides(el.attributes);
    if (overrides_.x !== null || overrides_.y !== null) {
      overrides.set(el, {
        x: overrides_.x !== null ? inchToPx(overrides_.x) : undefined,
        y: overrides_.y !== null ? inchToPx(overrides_.y) : undefined,
      });
    }
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);

  return layoutTree(root, {
    slideWidthPx: width,
    slideHeightPx: height,
    styles,
    overrides,
    diagnostics: [],
    slideIndex: 0,
  });
}

/** Anak langsung dari root yang punya element (line box & text box dilewati). */
function elementChildrenOf(box: LayoutBox): LayoutBox[] {
  return box.children.filter((child) => child.element !== null);
}

/** Semua kotak dengan tag tertentu, kecuali root sintetis. */
function findBoxes(root: LayoutBox, tagName: string): LayoutBox[] {
  const out: LayoutBox[] = [];
  walkBoxes(root, (box) => {
    if (box !== root && box.element?.tagName === tagName) out.push(box);
  });
  return out;
}

/** Kotak pertama dengan tag tertentu (root sintetis diabaikan). */
function findBox(root: LayoutBox, tagName: string): LayoutBox {
  const found = findBoxes(root, tagName)[0];
  if (!found) throw new Error(`tidak menemukan <${tagName}> di pohon layout`);
  return found;
}

/** Kotak yang mewakili sebuah text node (bukan line box, bukan elemen). */
function findTextBox(root: LayoutBox): LayoutBox {
  let found: LayoutBox | null = null;
  walkBoxes(root, (box) => {
    if (!found && box.text !== null) found = box;
  });
  if (!found) throw new Error("tidak menemukan kotak teks");
  return found;
}

describe("layout — ukuran eksplisit", () => {
  it('<div style="width: 192px"> menghasilkan kotak selebar 192px = 2 inci', () => {
    const root = layoutOf('<div style="width: 192px">x</div>');
    const div = elementChildrenOf(root)[0]!;
    expect(div.width).toBe(192);
    expect(pxToInch(192)).toBe(2);
    expect(pxToInch(div.width)).toBe(2);
  });

  it("root layout mengisi seluruh lebar slide", () => {
    const root = layoutOf("<p>x</p>");
    expect(root.width).toBe(SLIDE_W);
  });

  it("width dalam inci dikonversi memakai inchToPx", () => {
    const div = findBox(layoutOf('<div style="width: 2in"></div>'), "div");
    expect(div.width).toBeCloseTo(192, 6);
  });
});

describe("layout — block flow dan margin collapsing", () => {
  it("h1 lalu p menumpuk vertikal dengan margin terlipat (max, bukan jumlah)", () => {
    const root = layoutOf("<h1>Judul</h1><p>Paragraf</p>");
    const [h1, p] = elementChildrenOf(root);

    // Default browser: h1 margin 21/21, font 32px, line-height 1.2 -> 38.4px.
    expect(h1!.marginTop).toBe(21);
    expect(h1!.height).toBeCloseTo(38.4, 6);
    expect(h1!.y).toBe(21);

    // p default margin-top 16px < 21px, jadi terlipat ke max(21, 16) = 21.
    expect(p!.marginTop).toBe(16);
    expect(p!.y).toBeCloseTo(21 + 38.4 + 21, 6);

    // Tinggi root = posisi p + tinggi p + margin bawah p.
    expect(root.height).toBeCloseTo(p!.y + p!.height + 16, 6);
  });

  it("margin nol authored (dengan satuan) membuat tidak ada jarak", () => {
    const root = layoutOf('<div style="margin: 0px">a</div><div style="margin: 0px">b</div>');
    const children = elementChildrenOf(root);
    expect(children[0]!.marginTop).toBe(0);
    expect(children[1]!.y).toBe(children[0]!.height);
  });

  it("jarak vertikal berasal dari margin, bukan padding", () => {
    const root = layoutOf('<div style="margin-bottom: 40px">a</div><div>b</div>');
    const children = elementChildrenOf(root);
    expect(children[1]!.y).toBe(children[0]!.height + 40);
  });
});

describe("layout — box-sizing", () => {
  it("content-box tidak menambahkan padding ke lebar yang dideklarasikan (BUG)", () => {
    const div = findBox(layoutOf('<div style="width: 100px; padding: 10px">x</div>'), "div");
    // Perilaku aktual: LayoutBox.width adalah border-box, sehingga konten =
    // 100 - 20 = 80px. CSS content-box seharusnya membuat border-box 120px.
    expect(div.width).toBe(100);
    expect(div.paddingLeft).toBe(10);
    expect(div.paddingRight).toBe(10);
    // BUG (dilaporkan): src/layout/layoutEngine.ts ~baris 285 memakai
    // explicitWidth apa adanya untuk content-box, sama seperti border-box.
  });

  it("border-box membuat width dideklarasikan termasuk padding dan border", () => {
    const div = findBox(
      layoutOf('<div style="box-sizing: border-box; width: 120px; padding: 10px; border: 2px solid #000000">x</div>'),
      "div",
    );
    expect(div.width).toBeCloseTo(120 - (10 + 10 + 2 + 2), 6);
    expect(div.borderLeft).toBe(2);
    expect(div.paddingLeft).toBe(10);
  });

  it("lebar percentual diselesaikan terhadap containing block", () => {
    const div = findBox(layoutOf('<div style="width: 50%">x</div>'), "div");
    expect(div.width).toBeCloseTo(SLIDE_W * 0.5, 6);
  });
});

describe("layout — flex", () => {
  it("flex row menaruh anak kedua setelah anak pertama ditambah gap", () => {
    const root = layoutOf(
      '<div style="display: flex; gap: 10px"><div style="width: 100px">a</div><div style="width: 50px">b</div></div>',
    );
    const flexBox = elementChildrenOf(root)[0]!;
    const [first, second] = elementChildrenOf(flexBox);

    expect(flexBox.style.flexDirection).toBe("row");
    expect(first!.x).toBe(0);
    expect(first!.width).toBe(100);
    expect(second!.x).toBe(first!.x + first!.width + 10);
    expect(second!.width).toBe(50);
  });

  it("flex column menumpuk anak secara vertikal", () => {
    const root = layoutOf(
      '<div style="display: flex; flex-direction: column"><div>a</div><div>b</div></div>',
    );
    const flexBox = elementChildrenOf(root)[0]!;
    const [first, second] = elementChildrenOf(flexBox);

    expect(flexBox.style.flexDirection).toBe("column");
    expect(first!.y).toBe(0);
    expect(second!.y).toBeCloseTo(first!.y + first!.height, 6);
  });

  it("justify-content: center menggeser anak sebesar setengah ruang kosong", () => {
    const root = layoutOf(
      '<div style="display: flex; justify-content: center"><div style="width: 100px">a</div><div style="width: 100px">b</div></div>',
    );
    const flexBox = elementChildrenOf(root)[0]!;
    const [first, second] = elementChildrenOf(flexBox);

    const free = SLIDE_W - 100 - 100;
    expect(free).toBe(1080);
    expect(first!.x).toBe(free / 2);
    expect(second!.x).toBe(free / 2 + 100);
  });

  it("row-gap dan column-gap dipakai sesuai arah", () => {
    const row = elementChildrenOf(
      elementChildrenOf(
        layoutOf(
          '<div style="display: flex; column-gap: 24px"><div style="width: 10px">a</div><div style="width: 10px">b</div></div>',
        ),
      )[0]!,
    );
    expect(row[1]!.x).toBe(34);

    const column = elementChildrenOf(
      elementChildrenOf(
        layoutOf(
          '<div style="display: flex; flex-direction: column; row-gap: 7px"><div>a</div><div>b</div></div>',
        ),
      )[0]!,
    );
    expect(column[1]!.y).toBeCloseTo(column[0]!.height + 7, 6);
  });

  it("align-items: center tidak menggeser anak meski container punya cross size (BUG)", () => {
    const root = layoutOf(
      '<div style="display: flex; align-items: center; height: 100px"><div style="height: 20px">a</div></div>',
    );
    const flexBox = elementChildrenOf(root)[0]!;
    const child = elementChildrenOf(flexBox)[0]!;
    // CSS akan memusatkan anak pada 100px -> y = 40.
    // BUG (dilaporkan): layoutFlex memakai lineCrossSize = tinggi item (bukan
    // tinggi container), sehingga align-items:center selalu tanpa efek.
    expect(child.height).toBe(20);
    expect(child.y).toBe(0);
  });
});

describe("layout — pembungkusan teks", () => {
  const long = "kata ".repeat(20);

  it("teks panjang di dalam flex membungkus menjadi beberapa baris dan tinggi kotak bertambah", () => {
    const root = layoutOf(`<div style="display: flex; width: 200px">${long}</div>`);
    const flexBox = elementChildrenOf(root)[0]!;
    const textBox = flexBox.children[0]!;

    expect(textBox.lines.length).toBeGreaterThan(1);
    const lineHeight = 16 * 1.2; // font 16px, line-height normal = 1.2
    expect(textBox.height).toBeCloseTo(textBox.lines.length * lineHeight, 6);
    expect(flexBox.height).toBeCloseTo(textBox.height, 6);
  });

  it("paragraf panjang pada block flow membungkus pada lebar konten", () => {
    const root = layoutOf(`<div style="width: 200px">${long}</div>`);
    const div = elementChildrenOf(root)[0]!;

    // Inline text is packed into line boxes that respect the content edge.
    const lineBoxes = div.children.filter((box) => box.isLineBox);
    expect(lineBoxes.length).toBeGreaterThan(1);
    for (const line of lineBoxes) expect(line.width).toBeLessThanOrEqual(200);
    // Tinggi = jumlah baris x line-height, bukan lebar.
    expect(div.height).toBeCloseTo(lineBoxes.length * 19.2, 6);
  });

  it("campuran teks dan elemen inline berbagi satu baris bila muat", () => {
    const root = layoutOf("<p>Hello <strong>world</strong>!</p>");
    const p = elementChildrenOf(root)[0]!;
    const lineBoxes = p.children.filter((box) => box.isLineBox);

    // One line box holding the text, the <strong>, and the trailing text.
    expect(lineBoxes).toHaveLength(1);
    expect(lineBoxes[0]!.children).toHaveLength(3);
    expect(lineBoxes[0]!.height).toBeCloseTo(16 * 1.2, 6);

    // The <strong> keeps its own box, positioned after the leading text.
    const strong = lineBoxes[0]!.children[1]!;
    expect(strong.element?.tagName).toBe("strong");
    expect(strong.x).toBeCloseTo(36.4, 1);
  });

  it("baris tinggi bertambah saat ada newline eksplisit", () => {
    const root = layoutOf('<div style="width: 200px">satu\ndua</div>');
    const textBox = findTextBox(root);
    expect(textBox.lines.length).toBe(2);
    expect(textBox.height).toBeCloseTo(2 * 19.2, 6);
  });

  it("teks polos tanpa elemen inline tetap satu baris", () => {
    const plain = layoutOf("<p>Hello dunia</p>", 1280);
    expect(findBox(plain, "p").children.filter((child) => child.isLineBox)).toHaveLength(1);
  });
});

describe("layout — koordinat absolut", () => {
  it("absoluteBoxOf menjumlahkan offset setiap ancestor tanpa menghitung padding dua kali", () => {
    const root = layoutOf('<div style="padding: 20px"><div style="padding: 10px"><p>x</p></div></div>');
    const p = findBox(root, "p");

    // `p.x` sudah memuat offset padding ancestor-nya karena layout engine
    // menaruh anak di tepi padding parent. Jadi x absolut cukup menjumlahkan
    // offset: div luar 20 + div dalam 10 + margin-kiri p 0 = 30.
    expect(absoluteBoxOf(root, p).x).toBe(30);
    // y: 20 + 10 + margin-top p 16 = 46
    expect(absoluteBoxOf(root, p).y).toBe(46);
  });

  it("absoluteBoxOf(root, root) mengembalikan kotak root apa adanya", () => {
    const root = layoutOf('<div style="padding: 20px">x</div>');
    const abs = absoluteBoxOf(root, root);
    expect(abs.x).toBe(0);
    expect(abs.y).toBe(0);
    expect(abs.width).toBe(root.width);
  });

  it("absoluteBoxOf stabil dengan padding bertingkat dan membulatkan ke 4 desimal", () => {
    const root = layoutOf('<div style="padding: 3px"><div style="padding: 7px"><p>x</p></div></div>');
    const abs = absoluteBoxOf(root, findBox(root, "p"));
    // x: 3 (offset div luar) + 7 (offset div dalam) + 0 (margin-kiri p) = 10
    expect(abs.x).toBe(10);
    // y: 3 + 7 + margin-top p 16 = 26
    expect(abs.y).toBe(26);
    expect(Number.isInteger(abs.x * 10000)).toBe(true);
  });
});

describe("layout — data-pptx-x / data-pptx-y", () => {
  it("posisi inch dipindahkan ke koordinat absolut memakai inchToPx", () => {
    const root = layoutOf('<div style="padding: 20px"><p data-pptx-x="2" data-pptx-y="1">x</p></div>');
    const p = findBox(root, "p");
    const abs = absoluteBoxOf(root, p);

    expect(inchToPx(2)).toBe(192);
    expect(inchToPx(1)).toBe(96);
    expect(abs.x).toBe(192);
    expect(abs.y).toBe(96);
    expect(pxToInch(abs.x)).toBe(2);
    expect(pxToInch(abs.y)).toBe(1);
  });

  it("hanya data-pptx-x menggeser sumbu horizontal, vertikal tetap ikut flow", () => {
    const root = layoutOf('<div><p data-pptx-x="3">x</p></div>');
    const p = findBox(root, "p");
    expect(absoluteBoxOf(root, p).x).toBe(288);
    expect(absoluteBoxOf(root, p).y).toBe(16); // margin-top default <p>
  });

  it("position: absolute memakai inset terhadap slide", () => {
    const root = layoutOf(
      '<div style="padding: 20px"><p style="position: absolute; left: 100px; top: 50px">x</p></div>',
    );
    const abs = absoluteBoxOf(root, findBox(root, "p"));
    expect(abs.x).toBe(100);
    expect(abs.y).toBe(50);
  });
});

describe("layout — walkBoxes dan urutan kedalaman", () => {
  it("walkBoxes mengunjungi setiap kotak tepat sekali, depth-first", () => {
    const root = layoutOf("<div><h1>Judul</h1><p>Teks <strong>tebal</strong></p></div>");
    const visited: LayoutBox[] = [];
    const tags: string[] = [];
    walkBoxes(root, (box) => {
      visited.push(box);
      if (box.element) tags.push(box.element.tagName);
    });
    // Tidak ada kotak yang dikunjungi dua kali.
    expect(new Set(visited).size).toBe(visited.length);
    // Urutan element: root sintetis, lalu anak dalam urutan dokumen.
    expect(tags).toEqual(["div", "div", "h1", "p", "strong"]);

    // 5 element (root, div, h1, p, strong) + 3 line box (satu per blok yang
    // punya konten inline: h1, p, dan strong) + 3 text box = 11.
    expect(visited.length).toBe(11);
  });

  it("elemen display: none tidak masuk pohon layout", () => {
    const root = layoutOf('<div><p style="display: none">rahasia</p><p>publik</p></div>');
    const inner = findBox(root, "div");
    expect(findBoxes(root, "p")).toHaveLength(1);
    expect(inner.height).toBeGreaterThan(0);
  });
});