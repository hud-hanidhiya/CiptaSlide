/**
 * Text measurement for the layout engine.
 *
 * PowerPoint does its own line breaking with real font metrics, so any estimate
 * we compute here is approximate by nature. What matters for correctness is
 * being *consistent*: boxes must be big enough that PowerPoint does not clip
 * text, and stable across runs so golden files do not drift.
 *
 * The approach is a per-character advance-width table for the common sans-serif
 * faces, scaled by font size. Monospace faces use a flat advance. Unknown
 * families fall back to the sans table.
 */

/** Advance width per 1em of font size, in arbitrary but stable units. */
type AdvanceTable = Record<string, number>;

/**
 * Relative advance widths for a Helvetica-like sans-serif face.
 *
 * Values are fractions of the font size. Narrow characters (i, l, j, t, f, r)
 * sit around 0.22-0.36, wide ones (m, w, M, W) around 0.83-1.0.
 */
const SANS_ADVANCE: AdvanceTable = {
  " ": 0.278,
  "!": 0.278,
  '"': 0.355,
  "#": 0.556,
  $: 0.556,
  "%": 0.889,
  "&": 0.667,
  "'": 0.191,
  "(": 0.333,
  ")": 0.333,
  "*": 0.389,
  "+": 0.584,
  ",": 0.278,
  "-": 0.333,
  ".": 0.278,
  "/": 0.278,
  "0": 0.556,
  "1": 0.556,
  "2": 0.556,
  "3": 0.556,
  "4": 0.556,
  "5": 0.556,
  "6": 0.556,
  "7": 0.556,
  "8": 0.556,
  "9": 0.556,
  ":": 0.278,
  ";": 0.278,
  "<": 0.584,
  "=": 0.584,
  ">": 0.584,
  "?": 0.556,
  "@": 1.015,
  A: 0.667,
  B: 0.667,
  C: 0.722,
  D: 0.722,
  E: 0.667,
  F: 0.611,
  G: 0.778,
  H: 0.722,
  I: 0.278,
  J: 0.5,
  K: 0.667,
  L: 0.556,
  M: 0.833,
  N: 0.722,
  O: 0.778,
  P: 0.667,
  Q: 0.778,
  R: 0.722,
  S: 0.667,
  T: 0.611,
  U: 0.722,
  V: 0.667,
  W: 0.944,
  X: 0.667,
  Y: 0.667,
  Z: 0.611,
  "[": 0.278,
  "\\": 0.278,
  "]": 0.278,
  "^": 0.469,
  _: 0.556,
  "`": 0.333,
  a: 0.556,
  b: 0.556,
  c: 0.5,
  d: 0.556,
  e: 0.556,
  f: 0.278,
  g: 0.556,
  h: 0.556,
  i: 0.222,
  j: 0.222,
  k: 0.5,
  l: 0.222,
  m: 0.833,
  n: 0.556,
  o: 0.556,
  p: 0.556,
  q: 0.556,
  r: 0.333,
  s: 0.5,
  t: 0.278,
  u: 0.556,
  v: 0.5,
  w: 0.722,
  x: 0.5,
  y: 0.5,
  z: 0.5,
  "{": 0.334,
  "|": 0.26,
  "}": 0.334,
  "~": 0.584,
};

/** Average advance for characters absent from the table. */
const DEFAULT_ADVANCE = 0.556;

/** Monospace families use a uniform advance. */
const MONOSPACE_FAMILIES = new Set([
  "courier",
  "courier new",
  "consolas",
  "lucida console",
  "monaco",
  "menlo",
  "monospace",
]);

/** Monospace advance width relative to font size. */
const MONOSPACE_ADVANCE = 0.6;

/** Families that are wider than the default sans metrics. */
const WIDE_FAMILIES = new Set(["verdana", "tahoma", "trebuchet ms", "segoe ui", "calibri"]);

/** Widening factor applied to the sans table for wide families. */
const WIDE_FACTOR = 1.06;

/**
 * Measure a single line of text.
 *
 * `fontSizePx` and `letterSpacingPx` are applied per character, matching how
 * browsers add tracking after every glyph.
 */
export function measureText(
  text: string,
  fontSizePx: number,
  fontFamily: string,
  letterSpacingPx = 0,
  bold = false,
): number {
  if (text === "") return 0;
  const family = fontFamily.trim().toLowerCase();
  const isMono = MONOSPACE_FAMILIES.has(family);
  const width = isMono
    ? text.length * MONOSPACE_ADVANCE
    : sumAdvances(text, WIDE_FAMILIES.has(family) ? WIDE_FACTOR : 1);
  // Bold text is optically wider; browsers use the bold face metrics.
  const boldFactor = bold ? 1.03 : 1;
  return width * fontSizePx * boldFactor + letterSpacingPx * text.length;
}

function sumAdvances(text: string, factor: number): number {
  let total = 0;
  for (const char of text) {
    total += (SANS_ADVANCE[char] ?? DEFAULT_ADVANCE) * factor;
  }
  return total;
}

/** One measured word plus the space that may follow it. */
export interface Token {
  text: string;
  width: number;
  /** True for a line-break opportunity, i.e. whitespace. */
  breakable: boolean;
}

/**
 * Split text into break opportunities.
 *
 * Words are atomic; each carries the width of the word plus one trailing space
 * so the line-breaking loop can place it without a second measurement pass.
 */
export function tokenize(
  text: string,
  fontSizePx: number,
  fontFamily: string,
  letterSpacingPx = 0,
  bold = false,
): Token[] {
  const tokens: Token[] = [];
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (part === "") continue;
    tokens.push({
      text: part,
      width: measureText(part, fontSizePx, fontFamily, letterSpacingPx, bold),
      breakable: /^\s+$/.test(part),
    });
  }
  return tokens;
}

/**
 * Break text into lines that fit `maxWidthPx`.
 *
 * Returns the token span of each line rather than its rendered text, so callers
 * can map lines back to styled runs. A single word wider than the box is kept
 * on its own line rather than split mid-word, matching browser behaviour for
 * `overflow-wrap: normal`.
 *
 * `maxWidthPx` of 0 or less disables wrapping, producing one line per explicit
 * newline only.
 */
export function wrapText(
  text: string,
  maxWidthPx: number,
  fontSizePx: number,
  fontFamily: string,
  letterSpacingPx = 0,
  bold = false,
): Token[][] {
  const lines: Token[][] = [];
  const explicitLines = text.split("\n");

  for (const [explicitIndex, explicitLine] of explicitLines.entries()) {
    const tokens = tokenize(explicitLine, fontSizePx, fontFamily, letterSpacingPx, bold);
    if (maxWidthPx <= 0) {
      lines.push(tokens);
      continue;
    }

    let current: Token[] = [];
    let currentWidth = 0;

    for (const token of tokens) {
      if (currentWidth + token.width <= maxWidthPx) {
        current.push(token);
        currentWidth += token.width;
        continue;
      }
      if (current.length === 0) {
        // Word alone exceeds the line: place it and move on.
        lines.push([token]);
        currentWidth = 0;
        current = [];
        continue;
      }
      lines.push(current);
      if (token.breakable) {
        current = [];
        currentWidth = 0;
        continue;
      }
      current = [token];
      currentWidth = token.width;
    }

    if (current.length > 0 || lines.length === 0) lines.push(current);

    if (explicitIndex < explicitLines.length - 1) {
      // An explicit newline always ends the line.
      if (lines[lines.length - 1]?.length === 0) lines.pop();
    }
  }

  return lines;
}

/** Total width of a wrapped line, ignoring trailing whitespace. */
export function lineWidth(tokens: Token[]): number {
  let width = 0;
  for (const [index, token] of tokens.entries()) {
    if (token.breakable && index === tokens.length - 1) continue;
    width += token.width;
  }
  return width;
}

/** Rendered text of a token list, with whitespace runs collapsed at line ends. */
export function tokensToText(tokens: Token[]): string {
  let text = tokens.map((token) => token.text).join("");
  text = text.replace(/[\s ]+$/, "");
  return text;
}

/** Truncate text to fit `maxWidthPx`, appending an ellipsis when it does not fit. */
export function truncateText(
  text: string,
  maxWidthPx: number,
  fontSizePx: number,
  fontFamily: string,
  letterSpacingPx = 0,
  bold = false,
): string {
  if (measureText(text, fontSizePx, fontFamily, letterSpacingPx, bold) <= maxWidthPx) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}...`;
    if (measureText(candidate, fontSizePx, fontFamily, letterSpacingPx, bold) <= maxWidthPx) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}...`;
}