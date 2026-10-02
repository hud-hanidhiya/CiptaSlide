import { describe, expect, it } from "vitest";

import {
  CSS_PX_PER_INCH,
  EMU_PER_INCH,
  POINTS_PER_INCH,
  inchToPx,
  pxToEmu,
  pxToInch,
  pxToPt,
  ptToPx,
  round,
} from "../src/shared/units";
import {
  applyOpacity,
  blend,
  contrastingTextColor,
  namedColorHex,
  parseColor,
  relativeLuminance,
  toHex,
  toHex6,
} from "../src/shared/color";
import {
  absoluteFontSize,
  defaultLengthContext,
  firstFontFamily,
  parseFontShorthand,
  parseLength,
  parseLengthWithBasis,
  splitTopLevel,
} from "../src/css/values";
import { lineWidth, measureText, tokensToText, truncateText, wrapText } from "../src/css/metrics";

/**
 * Unit test untuk helper murni: konversi satuan, parsing panjang CSS, metrik teks,
 * dan warna. Tidak ada I/O di file ini.
 */

const CTX = defaultLengthContext();

describe("units — konversi px <-> inch", () => {
  it("96 px persis 1 inci, 192 px persis 2 inci", () => {
    expect(CSS_PX_PER_INCH).toBe(96);
    expect(pxToInch(96)).toBe(1);
    expect(pxToInch(192)).toBe(2);
  });

  it("inchToPx adalah invers pxToInch untuk nilai umum", () => {
    for (const inches of [0, 0.25, 1, 2.5, 7.5, 13.333, 100]) {
      expect(inchToPx(inches)).toBeCloseTo(inches * 96, 10);
      expect(pxToInch(inchToPx(inches))).toBeCloseTo(inches, 10);
    }
    expect(inchToPx(1)).toBe(96);
    expect(inchToPx(2)).toBe(192);
  });

  it("nilai tidak finit dikembalikan sebagai 0, bukan NaN", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(pxToInch(bad)).toBe(0);
      expect(inchToPx(bad)).toBe(0);
    }
  });
});

describe("units — konversi point dan EMU", () => {
  it("pxToPt memakai 72 point per inci", () => {
    expect(POINTS_PER_INCH).toBe(72);
    expect(pxToPt(96)).toBe(72);
    expect(pxToPt(16)).toBe(12); // 16px = 12pt, ukuran body standar
    expect(pxToPt(24)).toBe(18);
  });

  it("ptToPx adalah invers pxToPt", () => {
    for (const pt of [0, 8, 12, 18, 72, 540]) {
      expect(ptToPx(pt)).toBeCloseTo((pt / 72) * 96, 10);
      expect(pxToPt(ptToPx(pt))).toBeCloseTo(pt, 10);
    }
  });

  it("pxToEmu memakai 914400 EMU per inci dan membulatkan ke integer", () => {
    expect(EMU_PER_INCH).toBe(914400);
    expect(pxToEmu(96)).toBe(914400);
    expect(pxToEmu(192)).toBe(1828800);
    expect(Number.isInteger(pxToEmu(37.5))).toBe(true);
  });
});

describe("units — round", () => {
  it("membulatkan sesuai jumlah desimal dan menghindari -0", () => {
    expect(round(1.23456789)).toBe(1.2346);
    expect(round(1.23456789, 2)).toBe(1.23);
    expect(round(-0.00001)).toBe(0);
    expect(Object.is(round(-0.00001), -0)).toBe(false);
  });

  it("nilai tidak finit menjadi 0", () => {
    expect(round(Number.NaN)).toBe(0);
    expect(round(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("css/values — parseLength", () => {
  it("membaca satuan absolut: px, pt, cm, in, mm", () => {
    expect(parseLength("10px")).toEqual({ kind: "px", value: 10 });
    expect(parseLength("12pt", CTX)).toEqual({ kind: "px", value: 16 });
    expect(parseLength("1in", CTX)).toEqual({ kind: "px", value: 96 });
    expect(parseLength("2.54cm", CTX)?.kind === "px" ? Math.round((parseLength("2.54cm", CTX) as { value: number }).value * 100) / 100 : null).toBe(96);
    expect(parseLength("25.4mm", CTX)?.kind === "px" ? Math.round((parseLength("25.4mm", CTX) as { value: number }).value * 100) / 100 : null).toBe(96);
  });

  it("satuan relatif memakai context: em ikut font size, rem ikut root font size", () => {
    const ctx = { fontSizePx: 24, rootFontSizePx: 10, viewportWidthPx: 1000, viewportHeightPx: 500 };
    expect(parseLength("2em", ctx)).toEqual({ kind: "px", value: 48 });
    expect(parseLength("2rem", ctx)).toEqual({ kind: "px", value: 20 });
    expect(parseLength("1em")).toEqual({ kind: "px", value: 16 }); // default 16px
    expect(parseLength("1rem")).toEqual({ kind: "px", value: 16 });
  });

  it("satuan viewport dihitung dari viewport context", () => {
    expect(parseLength("50vw", CTX)).toEqual({ kind: "px", value: 640 });
    expect(parseLength("50vh", CTX)).toEqual({ kind: "px", value: 360 });
    expect(parseLength("100vmin", CTX)).toEqual({ kind: "px", value: 720 });
  });

  it("persen dikembalikan apa adanya, bukan piksel", () => {
    expect(parseLength("50%")).toEqual({ kind: "percent", value: 50 });
    expect(parseLength("100%")).toEqual({ kind: "percent", value: 100 });
  });

  it("nilai non-length menghasilkan null", () => {
    expect(parseLength("auto")).toBeNull();
    expect(parseLength("none")).toBeNull();
    expect(parseLength("")).toBeNull();
    expect(parseLength("inherit")).toBeNull();
    expect(parseLength("10 px")).toBeNull();
    expect(parseLength("px")).toBeNull();
  });
});

describe("css/values — parseLengthWithBasis", () => {
  it("persen diselesaikan terhadap basis yang diberikan", () => {
    expect(parseLengthWithBasis("50%", 200)).toBe(100);
    expect(parseLengthWithBasis("100%", 1280)).toBe(1280);
    expect(parseLengthWithBasis("12.5%", 800)).toBe(100);
  });

  it("basis null menghasilkan null, bukan tebakan", () => {
    expect(parseLengthWithBasis("50%", null)).toBeNull();
    expect(parseLengthWithBasis("50%", Number.NaN)).toBeNull();
  });

  it("nilai absolut tidak butuh basis", () => {
    expect(parseLengthWithBasis("40px", null)).toBe(40);
  });
});

describe("css/values — absoluteFontSize", () => {
  it("keyword mengikuti skala browser dari root 16px", () => {
    expect(absoluteFontSize("xx-small", CTX)).toBe(9); // 16 * 0.5625
    expect(absoluteFontSize("x-small", CTX)).toBe(10);
    expect(absoluteFontSize("small", CTX)).toBe(13);
    expect(absoluteFontSize("medium", CTX)).toBe(16);
    expect(absoluteFontSize("large", CTX)).toBe(18);
    expect(absoluteFontSize("x-large", CTX)).toBe(24);
    expect(absoluteFontSize("xx-large", CTX)).toBe(32);
    expect(absoluteFontSize("xxx-large", CTX)).toBe(48);
  });

  it("bukan keyword menghasilkan null", () => {
    expect(absoluteFontSize("24px", CTX)).toBeNull();
    expect(absoluteFontSize("1.5em", CTX)).toBeNull();
    expect(absoluteFontSize("", CTX)).toBeNull();
  });
});

describe("css/values — splitTopLevel, font shorthand, firstFontFamily", () => {
  it("splitTopLevel tidak memecah di dalam kurung", () => {
    expect(splitTopLevel("10px solid rgb(1, 2, 3)")).toEqual(["10px", "solid", "rgb(1, 2, 3)"]);
    expect(splitTopLevel("a  b   c")).toEqual(["a", "b", "c"]);
    expect(splitTopLevel("   ")).toEqual([]);
  });

  it("firstFontFamily mengambil keluarga pertama dan membuang kutip", () => {
    expect(firstFontFamily("Arial")).toBe("Arial");
    expect(firstFontFamily("'Arial', sans-serif")).toBe("Arial");
    expect(firstFontFamily('"Arial", Helvetica, sans-serif')).toBe("Arial");
    // Nama keluarga multi-kata tetap utuh; kutip dilepas sebagai satu kesatuan.
    expect(firstFontFamily("'Segoe UI', sans-serif")).toBe("Segoe UI");
    expect(firstFontFamily('"Times New Roman", serif')).toBe("Times New Roman");
  });

  it("parseFontShorthand memecah size dan family", () => {
    const parsed = parseFontShorthand("italic bold 24px/1.2 'Segoe UI'");
    expect(parsed.size).toBe("24px");
    expect(parsed.lineHeight).toBe("1.2");
    expect(parsed.family).toContain("Segoe UI");
  });
});

describe("css/metrics — measureText", () => {
  it("string lebih panjang selalu lebih lebar", () => {
    const short = measureText("ab", 16, "Arial");
    const long = measureText("abcdefgh", 16, "Arial");
    expect(long).toBeGreaterThan(short);
    expect(measureText("a", 16, "Arial")).toBeGreaterThan(0);
    expect(measureText("", 16, "Arial")).toBe(0);
  });

  it("font lebih besar selalu lebih lebar (linear dalam font size)", () => {
    const at16 = measureText("Hello world", 16, "Arial");
    const at32 = measureText("Hello world", 32, "Arial");
    expect(at32).toBeGreaterThan(at16);
    expect(at32 / at16).toBeCloseTo(2, 6);
  });

  it("huruf lebar lebih mahal daripada huruf sempit", () => {
    expect(measureText("WWWW", 16, "Arial")).toBeGreaterThan(measureText("iiii", 16, "Arial"));
  });

  it("families lebar dan monospace memakai tabel berbeda", () => {
    const arial = measureText("mono", 16, "Arial");
    const verdana = measureText("mono", 16, "Verdana");
    const courier = measureText("mono", 16, "Courier New");
    expect(verdana).toBeGreaterThan(arial);
    expect(courier).toBeCloseTo(4 * 0.6 * 16, 10);
  });

  it("bold sedikit lebih lebar dan letter-spacing menambah lebar per karakter", () => {
    expect(measureText("bold", 16, "Arial", 0, true)).toBeGreaterThan(measureText("bold", 16, "Arial", 0, false));
    expect(measureText("abcd", 16, "Arial", 2)).toBe(measureText("abcd", 16, "Arial", 0) + 2 * 4);
  });
});

describe("css/metrics — wrapText", () => {
  const text = "satu dua tiga empat lima enam tujuh delapan";

  it("maxWidth kecil menghasilkan beberapa baris", () => {
    const lines = wrapText(text, 80, 16, "Arial");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(lineWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("maxWidth besar menghasilkan satu baris saja", () => {
    const lines = wrapText(text, 5000, 16, "Arial");
    expect(lines).toHaveLength(1);
    expect(tokensToText(lines[0]!)).toContain("satu");
  });

  it("jumlah baris tidak pernah melebihi jumlah kata", () => {
    const words = text.split(" ").length;
    expect(wrapText(text, 100, 16, "Arial").length).toBeLessThanOrEqual(words);
  });

  it("kata yang lebih lebar dari box tetap satu baris sendiri, tidak dipecah", () => {
    const lines = wrapText("supercalifragilistic a", 20, 16, "Arial");
    expect(tokensToText(lines[0]!)).toBe("supercalifragilistic");
  });

  it("maxWidth 0 menonaktifkan wrapping dan hanya memisah newline eksplisit", () => {
    const lines = wrapText("a b c", 0, 16, "Arial");
    expect(lines).toHaveLength(1);
  });
});

describe("css/metrics — truncateText", () => {
  it("menempelkan elipsis saat teks tidak muat", () => {
    const out = truncateText("satu dua tiga empat lima", 40, 16, "Arial");
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThan("satu dua tiga empat lima".length);
  });

  it("teks yang sudah muat dikembalikan utuh tanpa elipsis", () => {
    expect(truncateText("pendek", 5000, 16, "Arial")).toBe("pendek");
  });

  it("hasil truncation benar-benar muat dalam maxWidth", () => {
    const source = "satu dua tiga empat lima enam tujuh delapan sembilan";
    const out = truncateText(source, 60, 16, "Arial");
    expect(measureText(out, 16, "Arial")).toBeLessThanOrEqual(60);
  });
});

describe("shared/color — parseColor", () => {
  it("hex 3 digit didilakukan dengan menggandakan tiap digit", () => {
    expect(parseColor("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    expect(parseColor("#ABC")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  it("hex 6 digit dibaca langsung", () => {
    expect(parseColor("#1a2b3c")).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c, a: 1 });
    expect(parseColor("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("hex dengan alpha 4/8 digit menyimpan kanal alpha", () => {
    expect(parseColor("#00000080")?.a).toBeCloseTo(128 / 255, 6);
    expect(parseColor("#f00f")?.a).toBe(1);
  });

  it("rgb()/rgba() dengan koma maupun spasi", () => {
    expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseColor("rgb(100% 0% 50%)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
    // Sintaks alpha modern (slash) dan legacy (komma keempat) keduanya didukung.
    expect(parseColor("rgb(1 2 3 / 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("rgba(1,2,3,0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseColor("rgba(0,0,0,0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("hsl()/hsla() dihitung dari hue/saturation/lightness", () => {
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor("hsla(240, 100%, 50%, 0.25)")?.a).toBe(0.25);
    expect(parseColor("hsl(0, 0%, 100%)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("nama warna CSS dikenali, transparent punya alpha 0", () => {
    expect(parseColor("red")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("RebeccaPurple")).toEqual({ r: 0x66, g: 0x33, b: 0x99, a: 1 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("nama tak dikenal dan keyword non-warna menghasilkan null", () => {
    expect(parseColor("notacolor")).toBeNull();
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("inherit")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });

  it("nilai komponen di-clamp ke 0..255", () => {
    expect(parseColor("rgb(300, -20, 3)")).toEqual({ r: 255, g: 0, b: 3, a: 1 });
  });
});

describe("shared/color — toHex / toHex6", () => {
  it("toHex menghasilkan #RRGGBB huruf kecil", () => {
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(toHex("hsl(0,100%,50%)")).toBe("#ff0000");
  });

  it("toHex mengembalikan null untuk transparan penuh dan input tak valid", () => {
    expect(toHex("transparent")).toBeNull();
    expect(toHex("#00000000")).toBeNull();
    expect(toHex("rgb(0 0 0 / 0)")).toBeNull();
    expect(toHex("rgba(0,0,0,0)")).toBeNull();
    expect(toHex("notacolor")).toBeNull();
    expect(toHex(null)).toBeNull();
    expect(toHex(undefined)).toBeNull();
  });

  it("toHex6 melepas # dan menormalkan huruf kecil", () => {
    expect(toHex6("#FF0000")).toBe("ff0000");
    expect(toHex6("rgb(0,0,255)")).toBe("0000ff");
    expect(toHex6("transparent")).toBeNull();
  });
});

describe("shared/color — luminance, blend, opacity, kontras", () => {
  it("relativeLuminance: putih tinggi, hitam rendah", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
    expect(relativeLuminance("rgb(255,255,255)")).toBeGreaterThan(relativeLuminance("#808080"));
  });

  it("contrastingTextColor memilih teks terang di atas latar gelap", () => {
    expect(contrastingTextColor("#000000")).toBe("#FFFFFF");
    expect(contrastingTextColor("#0000ff")).toBe("#FFFFFF");
    expect(contrastingTextColor("#ffffff")).toBe("#000000");
    expect(contrastingTextColor("#ffff00")).toBe("#000000");
  });

  it("blend menumpuk warna atas yang transparan", () => {
    expect(blend("#FF0000", "#000000")).toBe("#ff0000");
    expect(blend("rgb(255 0 0 / 0)", "#00FF00")).toBe("#00ff00");
    expect(blend("rgba(255,0,0,0)", "#00FF00")).toBe("#00ff00");
    // 0.5*0 + 0.5*255 = 127.5 -> clamp+round = 128 = 0x80
    expect(blend("rgb(0 0 0 / 0.5)", "#FFFFFF")).toBe("#808080");
    expect(blend("rgba(0,0,0,0.5)", "#FFFFFF")).toBe("#808080");
  });

  it("applyOpacity mengalikan alpha dan null saat tak terlihat", () => {
    expect(applyOpacity("#FF0000", 1)).toBe("#ff0000");
    expect(applyOpacity("#FF0000", 0.5)).toBe("#ff0000");
    expect(applyOpacity("#FF0000", 0)).toBeNull();
    expect(applyOpacity("rgb(255 0 0 / 0)", 1)).toBeNull();
    expect(applyOpacity(null, 1)).toBeNull();
  });

  it("namedColorHex hanya menerima nama yang dikenal", () => {
    expect(namedColorHex("white")).toBe("#ffffff");
    expect(namedColorHex("  NAVY  ")).toBe("#000080");
    expect(namedColorHex("burgundy")).toBeNull();
  });
});