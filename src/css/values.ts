/**
 * CSS value parsing: lengths, percentages, keywords and shorthand expansion.
 *
 * The layout engine works in CSS pixels. This module converts every CSS length
 * token to pixels using a resolution context (root font size, parent font size,
 * and a percentage basis supplied by the caller).
 */

/** Absolute length units, in pixels. */
const ABSOLUTE_UNITS: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/** Font-relative length units, resolved against a font size. */
const FONT_RELATIVE_UNITS = new Set([
  "em",
  "rem",
  "ex",
  "ch",
  "vw",
  "vh",
  "vmin",
  "vmax",
  "cap",
  "ic",
  "lh",
  "rlh",
]);

/** Resolution inputs for relative units. */
export interface LengthContext {
  /** Font size of the current element, in px. */
  fontSizePx: number;
  /** Font size of the root element, in px. */
  rootFontSizePx: number;
  /** Viewport size in px, used by `vw`/`vh`/`vmin`/`vmax`. */
  viewportWidthPx: number;
  viewportHeightPx: number;
}

/** Default context: 16px root, matching the browser default. */
export function defaultLengthContext(): LengthContext {
  return {
    fontSizePx: 16,
    rootFontSizePx: 16,
    viewportWidthPx: 1280,
    viewportHeightPx: 720,
  };
}

/** A parsed length: either an absolute pixel amount or a percentage. */
export type Length =
  | { kind: "px"; value: number }
  | { kind: "percent"; value: number };

/**
 * Parse a CSS length token to pixels.
 *
 * Returns null when the value is not a length (`auto`, `none`, a keyword, or
 * malformed input). Percentages are returned as-is; the caller supplies the
 * basis, because "100% width" means different things in different axes.
 */
export function parseLength(input: string, context: LengthContext = defaultLengthContext()): Length | null {
  const value = input.trim().toLowerCase();
  if (value === "" || value === "auto" || value === "none") return null;

  const match = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(value);
  if (!match) return null;
  const amount = parseFloat(match[1]!);
  if (!Number.isFinite(amount)) return null;
  // A bare number is only valid as a zero length in CSS, but treating any
  // unitless number as px is harmless and matches what authors expect from
  // `width: 0`. Without this, `margin: 0` parses as null and is dropped.
  const unit = match[2] ?? "px";
  if (unit === "") return { kind: "px", value: amount };

  if (unit === "%") return { kind: "percent", value: amount };

  if (unit === "px") return { kind: "px", value: amount };

  const absolute = ABSOLUTE_UNITS[unit];
  if (absolute !== undefined) return { kind: "px", value: amount * absolute };

  if (!FONT_RELATIVE_UNITS.has(unit)) return null;

  switch (unit) {
    case "em":
      return { kind: "px", value: amount * context.fontSizePx };
    case "rem":
      return { kind: "px", value: amount * context.rootFontSizePx };
    case "ex":
      // Average glyph height is roughly 0.5em in most sans-serif faces.
      return { kind: "px", value: amount * context.fontSizePx * 0.5 };
    case "ch":
      // Advance width of "0" is roughly 0.5em.
      return { kind: "px", value: amount * context.fontSizePx * 0.5 };
    case "cap":
      return { kind: "px", value: amount * context.fontSizePx * 0.7 };
    case "ic":
      return { kind: "px", value: amount * context.fontSizePx * 1 };
    case "lh":
      return { kind: "px", value: amount * context.fontSizePx * 1.2 };
    case "rlh":
      return { kind: "px", value: amount * context.fontSizePx * 1.2 };
    case "vw":
      return { kind: "px", value: (amount / 100) * context.viewportWidthPx };
    case "vh":
      return { kind: "px", value: (amount / 100) * context.viewportHeightPx };
    case "vmin":
      return {
        kind: "px",
        value: (amount / 100) * Math.min(context.viewportWidthPx, context.viewportHeightPx),
      };
    case "vmax":
      return {
        kind: "px",
        value: (amount / 100) * Math.max(context.viewportWidthPx, context.viewportHeightPx),
      };
    default:
      return null;
  }
}

/**
 * Parse a length and resolve percentages against `basisPx`.
 *
 * `basisPx` is the containing block dimension for the axis being measured. A
 * null `basisPx` means the percentage cannot be resolved (auto-sized parent),
 * in which case null is returned rather than a guessed value.
 */
export function parseLengthWithBasis(
  input: string,
  basisPx: number | null,
  context: LengthContext = defaultLengthContext(),
): number | null {
  const length = parseLength(input, context);
  if (!length) return null;
  if (length.kind === "px") return length.value;
  if (basisPx === null || !Number.isFinite(basisPx)) return null;
  return (length.value / 100) * basisPx;
}

/** Resolve a percentage string against a basis. Returns null when unparseable. */
export function resolvePercent(input: string, basisPx: number): number | null {
  const value = parseFloat(input);
  if (!Number.isFinite(value) || !input.trim().endsWith("%")) return null;
  return (value / 100) * basisPx;
}

/** True when the value is the keyword `auto`. */
export function isAuto(input: string | undefined): boolean {
  return input !== undefined && input.trim().toLowerCase() === "auto";
}

/** True when the value is `none` or empty. */
export function isNone(input: string | undefined): boolean {
  return input === undefined || input.trim().toLowerCase() === "none" || input.trim() === "";
}

/** Four whitespace-separated numbers, e.g. a `border-radius` shorthand. */
export function parseFourValues(input: string): [string, string, string, string] | null {
  const parts = splitTopLevel(input);
  if (parts.length < 1 || parts.length > 4) return null;
  const values: [string, string, string, string] = [
    parts[0]!,
    parts[0]!,
    parts[0]!,
    parts[0]!,
  ];
  if (parts.length === 2) {
    values[1] = parts[1]!;
    values[2] = parts[0]!;
    values[3] = parts[1]!;
  } else if (parts.length === 3) {
    values[1] = parts[1]!;
    values[2] = parts[2]!;
    values[3] = parts[1]!;
  }
  return values;
}

/** Two whitespace-separated numbers, e.g. a `padding` shorthand. */
export function parseTwoValues(input: string): [string, string] | null {
  const parts = splitTopLevel(input);
  if (parts.length !== 2) return null;
  return [parts[0]!, parts[1]!];
}

/** Parse `font-size` keywords to px, matching the browser default scale. */
export function absoluteFontSize(input: string, context: LengthContext): number | null {
  const key = input.trim().toLowerCase();
  switch (key) {
    case "xx-small":
      return Math.round(context.rootFontSizePx * 0.5625);
    case "x-small":
      return Math.round(context.rootFontSizePx * 0.625);
    case "small":
      return Math.round(context.rootFontSizePx * 0.8125);
    case "medium":
      return Math.round(context.rootFontSizePx);
    case "large":
      return Math.round(context.rootFontSizePx * 1.125);
    case "x-large":
      return Math.round(context.rootFontSizePx * 1.5);
    case "xx-large":
      return Math.round(context.rootFontSizePx * 2);
    case "xxx-large":
      return Math.round(context.rootFontSizePx * 3);
    default:
      return null;
  }
}

/** Named font weights that map to `bold` or `normal`. */
export function isBoldWeight(input: string): boolean {
  const value = input.trim().toLowerCase();
  return value === "bold" || value === "bolder" || Number.parseInt(value, 10) >= 600;
}

/** Split on whitespace while respecting parentheses. */
export function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of input) {
    if (char === "(") {
      depth += 1;
      current += char;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (depth === 0 && /\s/.test(char)) {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * Parse a `font` shorthand into its component longhands.
 *
 * Only the parts we can represent are extracted: family, size, weight, style.
 * `line-height` in the shorthand is also extracted.
 */
export function parseFontShorthand(
  input: string,
): { family: string; size: string | null; weight: string | null; style: string | null; lineHeight: string | null } {
  const familiesMatch = /(.+?)\s+(\d[\d.]*[a-z%]*|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)\s*(?:\/\s*([\d.]+))?\s+(.+)$/i.exec(
    input.trim(),
  );
  if (familiesMatch) {
    return {
      family: familiesMatch[4]!.trim(),
      size: familiesMatch[2]!,
      weight: null,
      style: null,
      lineHeight: familiesMatch[3] ?? null,
    };
  }

  // Fallback: size must appear before the family, so split on the last token run.
  const parts = input.trim().split(/\s+/);
  const family = parts.pop() ?? "";
  const sizeIndex = parts.findIndex((part) => /^\d/.test(part) || /small|large|medium/i.test(part));
  if (sizeIndex < 0) return { family, size: null, weight: null, style: null, lineHeight: null };
  const size = parts[sizeIndex]!.split("/")[0]!;
  const weight = parts.findIndex((p) => /^(bold|bolder|[5-9]00|1000)$/i.test(p));
  const style = parts.findIndex((p) => /^(italic|oblique)$/i.test(p));
  return {
    family,
    size,
    weight: weight >= 0 ? parts[weight]! : null,
    style: style >= 0 ? parts[style]! : null,
    lineHeight: null,
  };
}

/**
 * Take the first family from a `font-family` list.
 *
 * Multi-word families are quoted (`'Segoe UI'`, `"Times New Roman"`), so the
 * first comma-separated part must be unquoted as a whole rather than split on
 * whitespace — otherwise `'Segoe UI'` would become the truncated `Segoe`.
 */
export function firstFontFamily(input: string): string {
  const first = input.split(",")[0] ?? "";
  return first.trim().replace(/^['"]|['"]$/g, "").trim();
}

/** Extract every font family from a comma-separated list, unquoted. */
export function fontFamilyList(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ""))
    .filter((part) => part !== "");
}