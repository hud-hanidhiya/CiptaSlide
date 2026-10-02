/**
 * Colour parsing and conversion.
 *
 * Everything upstream of the PPTX writer may use CSS colour syntax; everything
 * downstream expects `#RRGGBB`. `toHex()` is the single conversion point, and
 * it returns `null` for anything unresolvable rather than guessing black.
 */

/** A colour with an alpha channel, components 0-255. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Alpha 0-1. */
  a: number;
}

const NAMED_COLORS: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkblue: "#00008b",
  darkred: "#8b0000",
  darkgreen: "#006400",
  gold: "#ffd700",
  beige: "#f5f5dc",
  coral: "#ff7f50",
  crimson: "#dc143c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  salmon: "#fa8072",
  tan: "#d2b48c",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  plum: "#dda0dd",
  orchid: "#da70d6",
  tomato: "#ff6347",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  royalblue: "#4169e1",
  midnightblue: "#191970",
  seagreen: "#2e8b57",
  forestgreen: "#228b22",
  firebrick: "#b22222",
  chocolate: "#d2691e",
  goldenrod: "#daa520",
  hotpink: "#ff69b4",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  sienna: "#a0522d",
  peru: "#cd853f",
  linen: "#faf0e6",
  snow: "#fffafa",
  mintcream: "#f5fffa",
  honeydew: "#f0fff0",
  whitesmoke: "#f5f5f5",
  ghostwhite: "#f8f8ff",
  aliceblue: "#f0f8ff",
  lavenderblush: "#fff0f5",
  mistyrose: "#ffe4e1",
  gainsboro: "#dcdcdc",
  slategray: "#708090",
  slategrey: "#708090",
  dimgray: "#696969",
  dimgrey: "#696969",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  darkcyan: "#008b8b",
  darkmagenta: "#8b008b",
  darkviolet: "#9400d3",
  darkorange: "#ff8c00",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightyellow: "#ffffe0",
  lightsteelblue: "#b0c4de",
  mediumblue: "#0000cd",
  mediumaquamarine: "#66cdaa",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  darkorangealt: "#ff8c00",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  greenyellow: "#adff2f",
  springgreen: "#00ff7f",
  olivedrab: "#6b8e23",
  darkolivegreen: "#556b2f",
  darkseagreen: "#8fbc8f",
  lightcoral: "#f08080",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  cadetblue: "#5f9ea0",
  darkkhaki: "#bdb76b",
  lightgoldenrodyellow: "#fafad2",
  lemonchiffon: "#fffacd",
  navajowhite: "#ffdead",
  papayawhip: "#ffefd5",
  seashell: "#fff5ee",
  cornsilk: "#fff8dc",
  oldlace: "#fdf5e6",
  floralwhite: "#fffaf0",
  mintcream2: "#f5fffa",
  azure: "#f0ffff",
  rebeccapurple: "#663399",
};

/** Look up a CSS colour keyword. Returns null for unknown names. */
export function namedColorHex(name: string): string | null {
  const key = name.trim().toLowerCase();
  return NAMED_COLORS[key] ?? null;
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseHex(body: string): Rgba | null {
  const hex = body.trim();
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = parseInt(hex[0]! + hex[0]!, 16);
    const g = parseInt(hex[1]! + hex[1]!, 16);
    const b = parseInt(hex[2]! + hex[2]!, 16);
    return { r, g, b, a: 1 };
  }
  if (/^[0-9a-fA-F]{4}$/.test(hex)) {
    const r = parseInt(hex[0]! + hex[0]!, 16);
    const g = parseInt(hex[1]! + hex[1]!, 16);
    const b = parseInt(hex[2]! + hex[2]!, 16);
    const a = parseInt(hex[3]! + hex[3]!, 16) / 255;
    return { r, g, b, a };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  if (/^[0-9a-fA-F]{8}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16) / 255,
    };
  }
  return null;
}

function parseFunctional(body: string): Rgba | null {
  const inner = body.trim();
  const slashIndex = inner.indexOf("/");
  const rgbPart = slashIndex >= 0 ? inner.slice(0, slashIndex) : inner;
  const alphaPart = slashIndex >= 0 ? inner.slice(slashIndex + 1) : null;

  const components = rgbPart
    .replace(/^rgba?\(/, "")
    .split(/[,/\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");

  if (components.length < 3) return null;

  const channel = (token: string): number => {
    if (token.endsWith("%")) return clamp(Math.round((parseFloat(token) / 100) * 255), 0, 255);
    const value = parseFloat(token);
    return Number.isFinite(value) ? clamp(Math.round(value), 0, 255) : 0;
  };

  // The legacy comma form carries alpha as a fourth component, so both it and
  // the modern slash form must be read.
  const rawAlpha = alphaPart ?? components[3];
  const alpha = (() => {
    if (rawAlpha === undefined) return 1;
    const trimmed = rawAlpha.trim();
    if (trimmed.endsWith("%")) return clamp(parseFloat(trimmed) / 100, 0, 1);
    const value = parseFloat(trimmed);
    return Number.isFinite(value) ? clamp(value, 0, 1) : 1;
  })();

  return {
    r: channel(components[0]!),
    g: channel(components[1]!),
    b: channel(components[2]!),
    a: alpha,
  };
}

/**
 * Parse any CSS colour value into {@link Rgba}.
 *
 * Supports `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` with
 * comma or space syntax, `hsl()`, `hsla()` and the full colour keyword table.
 * Returns null when the value is not a colour.
 */
export function parseColor(input: string): Rgba | null {
  const value = input.trim();
  if (value === "") return null;
  const lower = value.toLowerCase();

  if (lower === "currentcolor" || lower === "inherit" || lower === "initial") return null;

  if (lower.startsWith("#")) return parseHex(value.slice(1));

  if (/^rgba?\(/i.test(value)) {
    const open = value.indexOf("(");
    return parseFunctional(value.slice(open + 1, value.lastIndexOf(")")));
  }

  if (/^hsla?\(/i.test(value)) {
    const open = value.indexOf("(");
    const body = value.slice(open + 1, value.lastIndexOf(")"));
    const parts = body.split(/[,/\s]+/).map((t) => t.trim()).filter((t) => t !== "");
    if (parts.length < 3) return null;
    const hue = ((parseFloat(parts[0]!) % 360) + 360) % 360;
    const saturation = clamp(parseFloat(parts[1]!) / 100, 0, 1);
    const lightness = clamp(parseFloat(parts[2]!) / 100, 0, 1);
    const alpha = parts[3] === undefined
      ? 1
      : parts[3].endsWith("%")
        ? clamp(parseFloat(parts[3]) / 100, 0, 1)
        : clamp(parseFloat(parts[3]), 0, 1);
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lightness - c / 2;
    const sector = Math.floor(hue / 60) % 6;
    const table: Array<[number, number, number]> = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ];
    const [r, g, b] = table[sector] ?? [0, 0, 0];
    return {
      r: clamp(Math.round((r + m) * 255), 0, 255),
      g: clamp(Math.round((g + m) * 255), 0, 255),
      b: clamp(Math.round((b + m) * 255), 0, 255),
      a: alpha,
    };
  }

  return namedColorHex(lower) ? parseColor(namedColorHex(lower)!) : null;
}

/** Two-digit zero-padded hex. */
function hex2(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

/**
 * Convert a CSS colour to `#RRGGBB`.
 *
 * Fully transparent colours return null, because PowerPoint has no equivalent
 * of `rgba(0,0,0,0)` for text and a null fill means "no fill" instead.
 */
export function toHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const rgba = parseColor(input);
  if (!rgba) return null;
  if (rgba.a === 0) return null;
  return `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`;
}

/** Strip a leading `#`, lowercasing the rest. pptxgenjs wants no `#`. */
export function toHex6(input: string | null | undefined): string | null {
  const hex = toHex(input);
  return hex ? hex.slice(1).toLowerCase() : null;
}

/** Relative luminance per WCAG 2.x, used to pick readable placeholder text. */
export function relativeLuminance(input: string | null | undefined): number {
  const rgba = input ? parseColor(input) : null;
  if (!rgba) return 1;
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgba.r) + 0.7152 * channel(rgba.g) + 0.0722 * channel(rgba.b);
}

/** True when a dark background needs light foreground text. */
export function needsLightText(background: string | null | undefined): boolean {
  return relativeLuminance(background) < 0.5;
}

/** Pick black or white text depending on background luminance. */
export function contrastingTextColor(background: string | null | undefined): string {
  return needsLightText(background) ? "#FFFFFF" : "#000000";
}

/** Blend `top` over `bottom` using `top`'s alpha. Returns `#RRGGBB`. */
export function blend(top: string, bottom: string): string {
  const a = parseColor(top);
  const b = parseColor(bottom);
  if (!a) return toHex(bottom) ?? "#000000";
  if (!b) return toHex(top) ?? "#000000";
  if (a.a >= 1) return `#${hex2(a.r)}${hex2(a.g)}${hex2(a.b)}`;
  const mix = (over: number, under: number): number =>
    clamp(Math.round(over * a.a + under * (1 - a.a)), 0, 255);
  return `#${hex2(mix(a.r, b.r))}${hex2(mix(a.g, b.g))}${hex2(mix(a.b, b.b))}`;
}

/** Multiply alpha into a hex colour, returning `#RRGGBB` or null when invisible. */
export function applyOpacity(color: string | null, opacity: number): string | null {
  const rgba = color ? parseColor(color) : null;
  if (!rgba) return null;
  const effective = rgba.a * clamp(opacity, 0, 1);
  if (effective <= 0) return null;
  return `#${hex2(rgba.r)}${hex2(rgba.g)}${hex2(rgba.b)}`;
}