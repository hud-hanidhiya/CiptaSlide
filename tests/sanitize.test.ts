import { describe, expect, it } from "vitest";

import { isSafeUrl, parseHtml, sanitizeCss } from "../src/html/sanitize";
import { collapsedTextContent, walkElements } from "../src/html/dom";
import type { DomElement, DomNode } from "../src/html/dom";
import type { Diagnostic } from "../src/shared/ir";

/**
 * Sanitasi adalah area paling sensitif: apa pun yang lolos di sini akan sampai
 * ke PPTX sebagai objek PowerPoint. Semua test memakai `parseHtml` sungguhan
 * (parse5) supaya yang diuji adalah perilaku produksi, bukan mock.
 */

function tagsOf(html: string): string[] {
  return walkElements(parseHtml(html).root).map((el) => el.tagName);
}

/** Semua elemen kecuali root sintetis `<div>` yang dibuat parser. */
function elements(html: string): DomElement[] {
  return walkElements(parseHtml(html).root).slice(1);
}

/** Semua nilai atribut di dalam subtree, untuk memeriksa kebocoran string. */
function attributeValues(node: DomNode, out: string[] = []): string[] {
  if (node.kind === "text") {
    out.push(node.value);
    return out;
  }
  if (node.kind === "comment") {
    out.push(node.value);
    return out;
  }
  out.push(...Object.values(node.attributes));
  for (const child of node.children) attributeValues(child, out);
  return out;
}

function warningsOf(html: string): Diagnostic[] {
  return parseHtml(html).diagnostics.filter((d) => d.level === "warning");
}

describe("sanitize — tag berbahaya dihapus beserta subtreesnya", () => {
  it("<script> dibuang dan menghasilkan diagnostic warning", () => {
    const { root, diagnostics } = parseHtml("<div>sebelum<script>alert(1)</script>sesudah</div>");
    expect(tagsOf("<div><script>x</script></div>")).not.toContain("script");
    expect(collapsedTextContent(root)).not.toContain("alert");
    // Teks di luar <script> tetap utuh.
    expect(collapsedTextContent(root)).toBe("sebelumsesudah");

    const warning = diagnostics.find((d) => d.element === "script");
    expect(warning).toBeDefined();
    expect(warning!.level).toBe("warning");
    expect(warning!.stage).toBe("sanitize");
    expect(warning!.message).toContain("<script>");
  });

  it("iframe, object, embed, form, input, link, meta semuanya hilang", () => {
    const html = [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x.swf"><param name="a"></object>',
      "<embed src=\"x.swf\">",
      "<form><p>form</p></form>",
      '<input type="text" value="rahasia">',
      '<link rel="stylesheet" href="https://evil.example/a.css">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    ].join("");
    const tags = tagsOf(html);
    for (const forbidden of ["iframe", "object", "embed", "form", "input", "link", "meta", "param"]) {
      expect(tags).not.toContain(forbidden);
    }
    // Subtree ikut hilang: teks di dalam <form> tidak boleh bocor.
    expect(tagsOf(html)).not.toContain("p");
  });

  it("setiap tag terlarang memunculkan diagnostic element yang sesuai", () => {
    const diagnostics = parseHtml('<iframe src="x"></iframe><form></form>').diagnostics;
    const elements = diagnostics.map((d) => d.element);
    expect(elements).toContain("iframe");
    expect(elements).toContain("form");
    expect(diagnostics.every((d) => d.level === "warning")).toBe(true);
  });
});

describe("sanitize — atribut", () => {
  it("atribut event handler on* dibuang dengan warning", () => {
    const { diagnostics } = parseHtml(
      '<div onclick="steal()" onerror="x()" onmouseover="y()" id="aman">teks</div>',
    );
    const div = elements('<div onclick="steal()" onerror="x()" onmouseover="y()" id="aman">teks</div>')[0]!;
    expect(div.attributes.onclick).toBeUndefined();
    expect(div.attributes.onerror).toBeUndefined();
    expect(div.attributes.onmouseover).toBeUndefined();
    expect(div.attributes.id).toBe("aman"); // atribut aman tetap ada

    const removed = diagnostics.filter((d) => d.property?.startsWith("on"));
    expect(removed.length).toBe(3);
    expect(removed.every((d) => d.level === "warning" && d.stage === "sanitize")).toBe(true);
  });

  it("atribut yang tidak ada di whitelist dibuang tanpa warning", () => {
    const html = '<div data-nova="1" bogus="2" style="color:red">x</div>';
    const { diagnostics } = parseHtml(html);
    const div = elements(html)[0]!;
    expect(div.attributes["data-nova"]).toBeUndefined();
    expect(div.attributes.bogus).toBeUndefined();
    expect(div.attributes.style).toBe("color:red");
    expect(diagnostics.filter((d) => d.property === "bogus")).toHaveLength(0);
  });

  it("<img src=\"javascript:...\"> kehilangan atribut src", () => {
    const { root, diagnostics } = parseHtml('<img src="javascript:alert(1)" alt="x">');
    const img = walkElements(root).find((el) => el.tagName === "img")!;
    expect(img.attributes.src).toBeUndefined();
    expect(img.attributes.alt).toBe("x");
    expect(diagnostics.some((d) => d.property === "src" && d.level === "warning")).toBe(true);
  });

  it("atribut data-pptx-* tetap diizinkan untuk kontrol eksplisit", () => {
    const html = '<div data-pptx-x="1.5" data-pptx-ignore data-slide>slide</div>';
    const div = elements(html)[0]!;
    expect(div.attributes["data-pptx-x"]).toBe("1.5");
    expect(div.attributes["data-pptx-ignore"]).toBe("");
    expect(div.attributes["data-slide"]).toBe("");
  });
});

describe("isSafeUrl", () => {
  it("menolak skema eksekutable dan payload data: berbahaya", () => {
    const rejected = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      " javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=",
      "file:///etc/passwd",
      "FILE:///etc/passwd",
    ];
    for (const url of rejected) {
      expect(isSafeUrl(url), `harus ditolak: ${JSON.stringify(url)}`).toBe(false);
    }
  });

  it("menerima URL aman termasuk data: gambar raster, relatif, dan fragmen", () => {
    const accepted = [
      "https://x/a.png",
      "http://x",
      "mailto:a@b.c",
      "tel:+62123",
      "images/logo.png",
      "../assets/logo.png",
      "#anchor",
      "data:image/png;base64,AAAA",
      "data:image/jpeg;base64,AAAA",
      "data:image/gif;base64,AAAA",
      "",
    ];
    for (const url of accepted) {
      expect(isSafeUrl(url), `harus diterima: ${JSON.stringify(url)}`).toBe(true);
    }
  });
});

describe("sanitize — elemen tidak dikenal dan hidden", () => {
  it("tag tidak dikenal di-unwrap tetapi teksnya bertahan", () => {
    const { root, diagnostics } = parseHtml("<div><marquee>halo dunia</marquee></div>");
    const tags = walkElements(root).map((el) => el.tagName);
    expect(tags).not.toContain("marquee");
    expect(collapsedTextContent(root)).toBe("halo dunia");

    const info = diagnostics.find((d) => d.element === "marquee");
    expect(info?.level).toBe("info");
    expect(info?.message).toContain("unwrapped");
  });

  it("atribut hidden menghapus elemen beserta subtreesnya", () => {
    const { root } = parseHtml('<div><p hidden>rahasia</p><p>publik</p></div>');
    const tags = walkElements(root).map((el) => el.tagName);
    expect(tags.filter((tag) => tag === "p")).toHaveLength(1);
    expect(collapsedTextContent(root)).toBe("publik");
  });

  it("komentar HTML dibuang", () => {
    const { root } = parseHtml("<div><!-- rahasia komentar --><p>teks</p></div>");
    const strings = attributeValues(root);
    expect(strings.join("|")).not.toContain("rahasia komentar");
    expect(collapsedTextContent(root)).toBe("teks");
  });
});

describe("sanitize — <style> di-hoist ke css, tidak masuk tree", () => {
  it("isi <style> pindah ke css yang dikembalikan dan hilang dari tree", () => {
    const { root, css } = parseHtml('<style>h1 { color: red; }</style><h1>Judul</h1>');
    expect(css).toContain("h1");
    expect(css).toContain("color: red");
    expect(walkElements(root).map((el) => el.tagName)).not.toContain("style");
    expect(attributeValues(root).join("|")).not.toContain("color: red");
    expect(collapsedTextContent(root)).toBe("Judul");
  });

  it("<style> kosong tidak menambah css", () => {
    const { css } = parseHtml("<style>   </style><p>x</p>");
    expect(css.trim()).toBe("");
  });
});

describe("sanitizeCss — construction berbahaya di stylesheet", () => {
  it("menghapus @import", () => {
    const out = sanitizeCss('@import url("https://evil.example/a.css");\nh1 { color: red; }');
    expect(out).not.toContain("@import");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color: red");
  });

  it("menetralkan expression()", () => {
    const out = sanitizeCss("div { width: expression(alert(1)); }");
    expect(out).not.toMatch(/expression\s*\(/i);
    expect(out).toContain("void(");
  });

  it("menetralkan javascript: di dalam url()", () => {
    const out = sanitizeCss('div { background: url("javascript:alert(1)"); }');
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out).toContain("url(about:blank)");
  });

  it("menetralkan vbscript: dan behavior/-moz-binding", () => {
    expect(sanitizeCss("a { background: url(vbscript:msgbox) }").toLowerCase()).not.toContain("vbscript:");
    expect(sanitizeCss("a { behavior: url(x.htc); }").toLowerCase()).not.toContain("behavior:");
    expect(sanitizeCss("a { -moz-binding: url(x.xml#y); }")).not.toContain("-moz-binding");
  });

  it("stylesheet bersih tidak diubah", () => {
    const css = "h1 { font-size: 32px; color: #123456; }\n.card { padding: 10px; }";
    expect(sanitizeCss(css)).toBe(css);
  });

  it("CSS yang di-hoist dari <style> sudah disanitasi", () => {
    const { css } = parseHtml('<style>@import "x.css"; p { color: blue; }</style>');
    expect(css).not.toContain("@import");
    expect(css).toContain("color: blue");
  });
});

describe("sanitize — robustness input", () => {
  it("HTML rusak tidak melempar exception", () => {
    for (const html of ["<h1>Hello<p>World", "<div><span>", "</p>", "<<<>>>", "<p>a<p>b<p>c"]) {
      expect(() => parseHtml(html)).not.toThrow();
    }
  });

  it("input kosong memberi diagnostic warning dan tree tanpa elemen", () => {
    const { root, diagnostics } = parseHtml("");
    expect(walkElements(root)).toHaveLength(1); // hanya root sintetis
    expect(diagnostics.some((d) => d.level === "warning")).toBe(true);
  });
});

describe("sanitize — input kosong pada <img>", () => {
  it("src kosong tidak dianggap URL berbahaya dan tetap diteruskan ke resolver", () => {
    const { root, diagnostics } = parseHtml('<img src="" alt="a">');
    const img = walkElements(root).find((el) => el.tagName === "img")!;
    expect(img.attributes.src).toBe("");
    expect(warningsOf('<img src="">')).toHaveLength(0);
    expect(diagnostics.every((d) => d.stage === "sanitize" || d.stage === "parse")).toBe(true);
  });
});