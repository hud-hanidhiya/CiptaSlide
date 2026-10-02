/**
 * The cascade: turn parsed CSS plus inline styles into a resolved computed
 * style for every element.
 *
 * This is where "computed style" in the PRD becomes concrete. The output is a
 * flat {@link ComputedStyle} with every longhand already resolved to a concrete
 * value in CSS pixels, colour hex, or enum. Nothing downstream re-parses CSS.
 *
 * Inheritance follows the CSS rules for the properties we model; `box-sizing`
 * and positioning properties do not inherit.
 */

import { toHex } from "../shared/color";
import type { DomElement } from "../html/dom";
import { isElement } from "../html/dom";
import type { Declaration, Stylesheet } from "./parse";
import { extractCustomProperties, parseInlineStyle, resolveCustomProperties } from "./parse";
import { matchesSelector } from "./selector";
import {
  absoluteFontSize,
  defaultLengthContext,
  firstFontFamily,
  isBoldWeight,
  parseFontShorthand,
  parseLength,
  splitTopLevel,
  type LengthContext,
} from "./values";

/** Resolved `display` value. */
export type Display = "block" | "flex" | "inline" | "inline-block" | "inline-flex" | "none";

/** Resolved `position` value. */
export type Position = "static" | "relative" | "absolute" | "fixed" | "sticky";

/** Fully resolved element style, in CSS pixels and hex colours. */
export interface ComputedStyle {
  display: Display;
  position: Position;

  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  fontStyle: "normal" | "italic" | "oblique";
  lineHeight: number;
  letterSpacingPx: number;
  textAlign: "left" | "center" | "right" | "justify";
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  whiteSpace: "normal" | "nowrap" | "pre" | "pre-wrap";
  /** Only `top`, `middle` and `bottom` are mapped to PowerPoint; see `ir.ts`. */
  verticalAlign: "baseline" | "top" | "middle" | "bottom";
  color: string;
  /** Background fill as `#RRGGBB`, or null when transparent. */
  background: string | null;
  /** `background-color` resolved before `background` shorthand handling. */
  backgroundColor: string | null;

  underline: boolean;
  strike: boolean;

  opacity: number;
  visibility: "visible" | "hidden";
  zIndex: number | null;
  overflow: "visible" | "hidden";

  /** Inset offsets for positioned elements, in px. Null when unset. */
  topPx: number | null;
  rightPx: number | null;
  bottomPx: number | null;
  leftPx: number | null;

  widthPx: number | null;
  widthPercent: number | null;
  heightPx: number | null;
  heightPercent: number | null;
  minWidthPx: number | null;
  minHeightPx: number | null;
  maxWidthPx: number | null;
  maxHeightPx: number | null;
  boxSizing: "content-box" | "border-box";

  marginTopPx: number | null;
  marginRightPx: number | null;
  marginBottomPx: number | null;
  marginLeftPx: number | null;
  paddingTopPx: number;
  paddingRightPx: number;
  paddingBottomPx: number;
  paddingLeftPx: number;

  borderTopWidthPx: number;
  borderRightWidthPx: number;
  borderBottomWidthPx: number;
  borderLeftWidthPx: number;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
  borderTopStyle: BorderStyleKind;
  borderRightStyle: BorderStyleKind;
  borderBottomStyle: BorderStyleKind;
  borderLeftStyle: BorderStyleKind;
  borderRadiusPx: number;

  flexDirection: "row" | "column";
  flexWrap: "nowrap" | "wrap";
  justifyContent: FlexAlignment;
  alignItems: FlexAlignment;
  alignSelf: FlexAlignment | "auto";
  gapPx: number;
  rowGapPx: number | null;
  columnGapPx: number | null;
  flexGrow: number;
  flexShrink: number;
  flexBasisPx: number | null;
  order: number;

  /** Default browser margins, applied when CSS does not override them. */
  defaultMarginTopPx: number;
  defaultMarginBottomPx: number;

  /** True when the element participates in inline flow. */
  isInline: boolean;
}

/** Border line style keywords. */
export type BorderStyleKind = "none" | "solid" | "dashed" | "dotted" | "double";

/** Flexbox alignment keywords. */
export type FlexAlignment =
  | "flex-start"
  | "flex-end"
  | "center"
  | "space-between"
  | "space-around"
  | "space-evenly"
  | "stretch"
  | "baseline"
  | "start"
  | "end";

/** Browser default font size, matching the CSS initial value. */
export const DEFAULT_FONT_SIZE_PX = 16;

/** Browser default body font family. */
export const DEFAULT_FONT_FAMILY = "Arial";

/**
 * Presentation-element default margins, in px.
 *
 * These come from the browser's default stylesheet. They matter because a bare
 * `<h1>Hello</h1>` looks completely different with and without them.
 */
export const DEFAULT_MARGINS: Record<string, { top: number; bottom: number }> = {
  h1: { top: 21, bottom: 21 },
  h2: { top: 20, bottom: 20 },
  h3: { top: 18, bottom: 18 },
  h4: { top: 21, bottom: 21 },
  h5: { top: 22, bottom: 22 },
  h6: { top: 22, bottom: 22 },
  p: { top: 16, bottom: 16 },
  blockquote: { top: 16, bottom: 16 },
  ul: { top: 16, bottom: 16 },
  ol: { top: 16, bottom: 16 },
  dl: { top: 16, bottom: 16 },
  dd: { top: 0, bottom: 0 },
  dt: { top: 0, bottom: 0 },
  figure: { top: 16, bottom: 16 },
  figcaption: { top: 0, bottom: 0 },
  pre: { top: 13, bottom: 13 },
  hr: { top: 13, bottom: 13 },
  table: { top: 0, bottom: 0 },
  div: { top: 0, bottom: 0 },
  section: { top: 0, bottom: 0 },
  li: { top: 0, bottom: 0 },
  caption: { top: 0, bottom: 0 },
  td: { top: 0, bottom: 0 },
  th: { top: 0, bottom: 0 },
};

/** Browser default font sizes for headings and monospace, in px. */
const DEFAULT_FONT_SIZES: Record<string, number> = {
  h1: 32,
  h2: 24,
  h3: 18.72,
  h4: 16,
  h5: 13.28,
  h6: 10.72,
  small: 13,
  big: 19,
  pre: 13,
  code: 13,
  kbd: 13,
  samp: 13,
};

/**
 * Tags whose default display differs from `block`.
 *
 * Table-internal tags map to `block` because the layout engine handles tables
 * through a dedicated table pass (see `layout/table.ts`), not through generic
 * block flow.
 */
const DEFAULT_DISPLAY: Record<string, Display> = {
  div: "block",
  section: "block",
  article: "block",
  main: "block",
  header: "block",
  footer: "block",
  nav: "block",
  aside: "block",
  p: "block",
  h1: "block",
  h2: "block",
  h3: "block",
  h4: "block",
  h5: "block",
  h6: "block",
  ul: "block",
  ol: "block",
  li: "block",
  dl: "block",
  dt: "block",
  dd: "block",
  blockquote: "block",
  pre: "block",
  figure: "block",
  figcaption: "block",
  hr: "block",
  table: "block",
  caption: "block",
  colgroup: "block",
  thead: "block",
  tbody: "block",
  tfoot: "block",
  tr: "block",
  td: "block",
  th: "block",
  span: "inline",
  a: "inline",
  strong: "inline",
  b: "inline",
  em: "inline",
  i: "inline",
  u: "inline",
  s: "inline",
  strike: "inline",
  small: "inline",
  mark: "inline",
  sub: "inline",
  sup: "inline",
  code: "inline",
  kbd: "inline",
  samp: "inline",
  br: "inline",
  svg: "inline-block",
  img: "inline-block",
};

/** Base font weight implied by the tag. */
const DEFAULT_FONT_WEIGHT: Record<string, number> = {
  h1: 700,
  h2: 700,
  h3: 700,
  h4: 700,
  h5: 700,
  h6: 700,
  strong: 700,
  b: 700,
  th: 700,
};

/** Tags that default to a monospace family. */
const MONOSPACE_TAGS = new Set(["pre", "code", "kbd", "samp"]);

/** Properties that inherit in CSS. Everything else starts fresh per element. */
const INHERITED_PROPERTIES = new Set([
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "white-space",
  "vertical-align",
  "visibility",
  "list-style-type",
  "text-indent",
  "word-spacing",
]);

/** Build the initial (unmatched) computed style for a tag. */
export function initialStyle(tagName: string): ComputedStyle {
  const fontSizePx = DEFAULT_FONT_SIZES[tagName] ?? DEFAULT_FONT_SIZE_PX;
  const margins = DEFAULT_MARGINS[tagName] ?? { top: 0, bottom: 0 };
  const display = DEFAULT_DISPLAY[tagName] ?? "block";

  return {
    display,
    position: "static",

    fontFamily: MONOSPACE_TAGS.has(tagName) ? "Courier New" : DEFAULT_FONT_FAMILY,
    fontSizePx,
    fontWeight: DEFAULT_FONT_WEIGHT[tagName] ?? 400,
    fontStyle: "normal",
    lineHeight: 1.2,
    letterSpacingPx: 0,
    textAlign: "left",
    textTransform: "none",
    whiteSpace: "normal",
    verticalAlign: "baseline" as ComputedStyle["verticalAlign"],
    color: "#000000",
    background: null,
    backgroundColor: null,

    underline: false,
    strike: false,

    opacity: 1,
    visibility: "visible",
    zIndex: null,
    overflow: "visible",

    topPx: null,
    rightPx: null,
    bottomPx: null,
    leftPx: null,

    widthPx: null,
    widthPercent: null,
    heightPx: null,
    heightPercent: null,
    minWidthPx: null,
    minHeightPx: null,
    maxWidthPx: null,
    maxHeightPx: null,
    boxSizing: "content-box",

    marginTopPx: margins.top,
    marginRightPx: 0,
    marginBottomPx: margins.bottom,
    marginLeftPx: 0,
    paddingTopPx: 0,
    paddingRightPx: 0,
    paddingBottomPx: 0,
    paddingLeftPx: 0,

    borderTopWidthPx: 0,
    borderRightWidthPx: 0,
    borderBottomWidthPx: 0,
    borderLeftWidthPx: 0,
    borderTopColor: "#000000",
    borderRightColor: "#000000",
    borderBottomColor: "#000000",
    borderLeftColor: "#000000",
    borderTopStyle: "none",
    borderRightStyle: "none",
    borderBottomStyle: "none",
    borderLeftStyle: "none",
    borderRadiusPx: 0,

    flexDirection: "row",
    flexWrap: "nowrap",
    justifyContent: "flex-start",
    alignItems: "stretch",
    alignSelf: "auto",
    gapPx: 0,
    rowGapPx: null,
    columnGapPx: null,
    flexGrow: 0,
    flexShrink: 1,
    flexBasisPx: null,
    order: 0,

    defaultMarginTopPx: margins.top,
    defaultMarginBottomPx: margins.bottom,

    isInline: display === "inline",
  };
}

/** A cascade entry: property, value, and the weight used for sorting. */
interface CascadeEntry {
  property: string;
  value: string;
  important: boolean;
  weight: number;
}

/**
 * Collect declarations that apply to `el`, sorted by cascade weight.
 *
 * Weight encodes (importance, origin, specificity, source order):
 *
 * | range | meaning |
 * |---|---|
 * | 0 - 99_999 | author stylesheet, ordered by specificity then source order |
 * | 100_000+ | inline `style` attribute (beats any selector specificity) |
 * | 10_000_000+ | author `!important`, from any origin |
 * | 90_000_000+ | inline `!important` |
 *
 * Importance dominates origin: an `!important` declaration in a stylesheet
 * beats a normal inline `style`, which is what the cascade specifies.
 */
function collectDeclarations(
  el: DomElement,
  stylesheet: Stylesheet,
): Map<string, CascadeEntry> {
  const winning = new Map<string, CascadeEntry>();

  const consider = (entry: CascadeEntry): void => {
    const current = winning.get(entry.property);
    if (!current || entry.weight > current.weight) winning.set(entry.property, entry);
  };

  for (const rule of stylesheet.rules) {
    if (!matchesSelector(el, rule.selector)) continue;
    const weight = rule.specificity * 100 + rule.order;
    for (const declaration of rule.declarations) {
      consider({
        property: declaration.property,
        value: declaration.value,
        important: declaration.important,
        weight: declaration.important ? 10_000_000 + weight : weight,
      });
    }
  }

  const inlineStyle = el.attributes.style;
  if (inlineStyle !== undefined) {
    for (const declaration of parseInlineStyle(inlineStyle)) {
      consider({
        property: declaration.property,
        value: declaration.value,
        important: declaration.important,
        weight: declaration.important ? 90_000_000 : 100_000,
      });
    }
  }

  return winning;
}

/** Collect custom properties visible at `el`, walking up the ancestor chain. */
function collectCustomProperties(el: DomElement, stylesheet: Stylesheet): Record<string, string> {
  const chain: DomElement[] = [];
  let current: DomElement | null = el;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  chain.reverse();

  const out: Record<string, string> = {};
  for (const node of chain) {
    const declarations: Declaration[] = [];
    for (const rule of stylesheet.rules) {
      if (!matchesSelector(node, rule.selector)) continue;
      declarations.push(...rule.declarations);
    }
    if (node.attributes.style !== undefined) {
      declarations.push(...parseInlineStyle(node.attributes.style));
    }
    Object.assign(out, extractCustomProperties(declarations));
  }
  return out;
}

/** Presentation hints from HTML attributes (`width`, `align`, `colspan`, ...). */
function applyPresentationalHints(el: DomElement, style: ComputedStyle): ComputedStyle {
  const next = { ...style };

  const widthAttr = el.attributes.width;
  if (widthAttr !== undefined && el.tagName === "img") {
    const parsed = parseLength(widthAttr);
    if (parsed?.kind === "px") next.widthPx = parsed.value;
  }
  const heightAttr = el.attributes.height;
  if (heightAttr !== undefined && el.tagName === "img") {
    const parsed = parseLength(heightAttr);
    if (parsed?.kind === "px") next.heightPx = parsed.value;
  }

  const align = el.attributes.align;
  if (align !== undefined) {
    const value = align.toLowerCase();
    if (value === "left" || value === "right" || value === "center") next.textAlign = value;
  }

  const valign = el.attributes.valign;
  if (valign !== undefined) {
    const value = valign.toLowerCase();
    if (value === "top") next.verticalAlign = "top";
    if (value === "middle") next.verticalAlign = "middle";
    if (value === "bottom") next.verticalAlign = "bottom";
  }

  const bgcolor = el.attributes.bgcolor;
  if (bgcolor !== undefined) {
    const hex = toHex(bgcolor);
    if (hex) {
      next.background = hex;
      next.backgroundColor = hex;
    }
  }

  const border = el.attributes.border;
  if (border !== undefined && (el.tagName === "table" || el.tagName === "img")) {
    const parsed = parseLength(border);
    const width = parsed?.kind === "px" ? parsed.value : 1;
    if (width > 0) {
      next.borderTopWidthPx = width;
      next.borderRightWidthPx = width;
      next.borderBottomWidthPx = width;
      next.borderLeftWidthPx = width;
      next.borderTopStyle = "solid";
      next.borderRightStyle = "solid";
      next.borderBottomStyle = "solid";
      next.borderLeftStyle = "solid";
    }
  }

  if (el.tagName === "strong" || el.tagName === "b") next.fontWeight = 700;
  if (el.tagName === "em" || el.tagName === "i") next.fontStyle = "italic";
  if (el.tagName === "u") next.underline = true;
  if (el.tagName === "s" || el.tagName === "strike") next.strike = true;
  if (el.tagName === "small") next.fontSizePx = Math.round(next.fontSizePx * 0.83);

  // `li` markers are rendered as PowerPoint bullets, so a literal marker in the
  // markup would otherwise be duplicated by the renderer.
  return next;
}

/** Result of {@link computeStyle}, so callers can walk the tree in order. */
export interface StyleResolution {
  style: ComputedStyle;
  /** Length resolution context for this element's own values. */
  context: LengthContext;
}

/**
 * Compute the resolved style for `el`.
 *
 * `parentStyle` supplies inherited values; pass undefined for the root.
 */
export function computeStyle(
  el: DomElement,
  stylesheet: Stylesheet,
  parentStyle: ComputedStyle | undefined,
  viewport: { widthPx: number; heightPx: number },
): StyleResolution {
  const declarations = collectDeclarations(el, stylesheet);
  const customProperties = collectCustomProperties(el, stylesheet);
  const resolved = resolveCustomProperties([...declarations.values()], customProperties);

  const base = parentStyle
    ? inheritFrom(parentStyle, el.tagName)
    : initialStyle(el.tagName);

  const context: LengthContext = {
    ...defaultLengthContext(),
    fontSizePx: base.fontSizePx,
    rootFontSizePx: rootFontSize(stylesheet, viewport),
    viewportWidthPx: viewport.widthPx,
    viewportHeightPx: viewport.heightPx,
  };

  const style = { ...base };
  const pending: Array<() => void> = [];

  for (const declaration of resolved) {
    if (declaration.property.startsWith("--")) continue;
    applyDeclaration(style, declaration, context, pending);
  }

  // Second pass: relative units such as `em` margins and `line-height` in `em`
  // need the final font size, which earlier declarations may have changed.
  for (const run of pending) run();

  const withHints = applyPresentationalHints(el, style);
  withHints.isInline =
    withHints.display === "inline" || (el.tagName === "li" && el.parent?.tagName !== "ul");

  return { style: withHints, context: { ...context, fontSizePx: withHints.fontSizePx } };
}

/** Determine the root font size from `html`/`body` rules, defaulting to 16. */
function rootFontSize(stylesheet: Stylesheet, viewport: { widthPx: number; heightPx: number }): number {
  for (const rule of stylesheet.rules) {
    const compounds = rule.selector.compounds;
    const last = compounds[compounds.length - 1];
    const isRoot = last && (last.tagName === "html" || last.tagName === "body") && compounds.length === 1;
    if (!isRoot) continue;
    for (const declaration of rule.declarations) {
      if (declaration.property !== "font-size") continue;
      const context: LengthContext = { ...defaultLengthContext(), viewportWidthPx: viewport.widthPx, viewportHeightPx: viewport.heightPx };
      const absolute = absoluteFontSize(declaration.value, context);
      if (absolute !== null) return absolute;
      const length = parseLength(declaration.value, context);
      if (length?.kind === "px") return length.value;
      if (length?.kind === "percent") return (length.value / 100) * DEFAULT_FONT_SIZE_PX;
    }
  }
  return DEFAULT_FONT_SIZE_PX;
}

/** Copy inherited properties from the parent style. */
function inheritFrom(parent: ComputedStyle, tagName: string): ComputedStyle {
  const child = initialStyle(tagName);
  // Tag-specific font size only applies when the parent has not set one.
  const inherited: ComputedStyle = {
    ...child,
    color: parent.color,
    fontFamily: parent.fontFamily,
    fontSizePx: parent.fontSizePx,
    fontWeight: parent.fontWeight,
    fontStyle: parent.fontStyle,
    lineHeight: parent.lineHeight,
    letterSpacingPx: parent.letterSpacingPx,
    textAlign: parent.textAlign,
    textTransform: parent.textTransform,
    whiteSpace: parent.whiteSpace,
    verticalAlign: parent.verticalAlign,
    visibility: parent.visibility,
  };

  // Heading defaults still apply when no ancestor changed the font size.
  const defaultSize = DEFAULT_FONT_SIZES[tagName];
  if (defaultSize !== undefined) inherited.fontSizePx = defaultSize;
  const defaultWeight = DEFAULT_FONT_WEIGHT[tagName];
  if (defaultWeight !== undefined) inherited.fontWeight = defaultWeight;
  if (MONOSPACE_TAGS.has(tagName)) inherited.fontFamily = "Courier New";
  const margins = DEFAULT_MARGINS[tagName] ?? { top: 0, bottom: 0 };
  inherited.defaultMarginTopPx = margins.top;
  inherited.defaultMarginBottomPx = margins.bottom;
  inherited.marginTopPx = margins.top;
  inherited.marginBottomPx = margins.bottom;
  return inherited;
}

function toPx(value: string, context: LengthContext): number | null {
  const length = parseLength(value, context);
  return length?.kind === "px" ? length.value : null;
}

function toPercent(value: string): number | null {
  const length = parseLength(value);
  return length?.kind === "percent" ? length.value : null;
}

const BORDER_STYLES = new Set<BorderStyleKind>(["none", "solid", "dashed", "dotted", "double"]);

/** Apply a single declaration to a style object. Long but flat and auditable. */
function applyDeclaration(
  style: ComputedStyle,
  declaration: Declaration,
  context: LengthContext,
  pending: Array<() => void>,
): void {
  const { property, value } = declaration;
  const v = value.trim().toLowerCase();

  switch (property) {
    case "display": {
      if (
        v === "block" || v === "flex" || v === "inline" || v === "inline-block" ||
        v === "inline-flex" || v === "none" || v === "grid" || v === "contents"
      ) {
        style.display = v as Display;
      }
      return;
    }
    case "position": {
      if (v === "static" || v === "relative" || v === "absolute" || v === "fixed" || v === "sticky") {
        style.position = v as Position;
      }
      return;
    }
    case "font-family": {
      style.fontFamily = firstFontFamily(value) || style.fontFamily;
      return;
    }
    case "font-size": {
      const absolute = absoluteFontSize(v, context);
      if (absolute !== null) {
        style.fontSizePx = absolute;
        return;
      }
      const length = parseLength(value, context);
      if (!length) return;
      if (length.kind === "px") {
        style.fontSizePx = length.value;
        return;
      }
      const parentSize = context.fontSizePx;
      pending.push(() => {
        style.fontSizePx = (length.value / 100) * (parentSize || DEFAULT_FONT_SIZE_PX);
      });
      return;
    }
    case "font-weight": {
      style.fontWeight = isBoldWeight(v) ? 700 : 400;
      return;
    }
    case "font-style": {
      if (v === "italic" || v === "oblique") style.fontStyle = v;
      return;
    }
    case "line-height": {
      if (v === "normal") {
        style.lineHeight = 1.2;
        return;
      }
      const length = parseLength(value, context);
      if (!length) return;
      if (length.kind === "px") {
        const size = style.fontSizePx;
        pending.push(() => {
          style.lineHeight = size === 0 ? 1.2 : length.value / size;
        });
        return;
      }
      style.lineHeight = length.value / 100;
      return;
    }
    case "letter-spacing": {
      const px = toPx(value, context);
      if (px !== null) style.letterSpacingPx = px;
      else if (v === "normal") style.letterSpacingPx = 0;
      return;
    }
    case "text-align": {
      if (v === "left" || v === "center" || v === "right" || v === "justify") style.textAlign = v;
      return;
    }
    case "text-transform": {
      if (v === "uppercase" || v === "lowercase" || v === "capitalize" || v === "none") {
        style.textTransform = v;
      }
      return;
    }
    case "white-space": {
      if (v === "normal" || v === "nowrap" || v === "pre" || v === "pre-wrap") style.whiteSpace = v;
      return;
    }
    case "vertical-align": {
      if (v === "top") style.verticalAlign = "top";
      else if (v === "middle") style.verticalAlign = "middle";
      else if (v === "bottom") style.verticalAlign = "bottom";
      return;
    }
    case "color": {
      const hex = toHex(value);
      if (hex) style.color = hex;
      return;
    }
    case "background": {
      applyBackground(style, value, context);
      return;
    }
    case "background-color": {
      const hex = toHex(value);
      if (hex) {
        style.backgroundColor = hex;
        style.background = hex;
      }
      return;
    }
    case "text-decoration":
    case "text-decoration-line": {
      const parts = v.split(/\s+/);
      style.underline = parts.includes("underline");
      style.strike = parts.includes("line-through");
      return;
    }
    case "text-decoration-color": {
      return;
    }
    case "opacity": {
      const numeric = parseFloat(v);
      if (Number.isFinite(numeric)) style.opacity = Math.min(1, Math.max(0, numeric));
      return;
    }
    case "visibility": {
      if (v === "visible" || v === "hidden") style.visibility = v;
      return;
    }
    case "z-index": {
      if (v === "auto") style.zIndex = null;
      else {
        const numeric = parseInt(v, 10);
        if (Number.isFinite(numeric)) style.zIndex = numeric;
      }
      return;
    }
    case "top":
    case "right":
    case "bottom":
    case "left": {
      if (v === "auto") {
        if (property === "top") style.topPx = null;
        if (property === "right") style.rightPx = null;
        if (property === "bottom") style.bottomPx = null;
        if (property === "left") style.leftPx = null;
        return;
      }
      const px = toPx(value, context);
      if (px === null) return;
      if (property === "top") style.topPx = px;
      if (property === "right") style.rightPx = px;
      if (property === "bottom") style.bottomPx = px;
      if (property === "left") style.leftPx = px;
      return;
    }
    case "overflow": {
      if (v === "visible" || v === "hidden") style.overflow = v;
      return;
    }
    case "width": {
      if (v === "auto") {
        style.widthPx = null;
        style.widthPercent = null;
        return;
      }
      const percent = toPercent(value);
      if (percent !== null) {
        style.widthPercent = percent;
        style.widthPx = null;
        return;
      }
      const px = toPx(value, context);
      if (px !== null) {
        style.widthPx = px;
        style.widthPercent = null;
      }
      return;
    }
    case "height": {
      if (v === "auto") {
        style.heightPx = null;
        style.heightPercent = null;
        return;
      }
      const percent = toPercent(value);
      if (percent !== null) {
        style.heightPercent = percent;
        style.heightPx = null;
        return;
      }
      const px = toPx(value, context);
      if (px !== null) {
        style.heightPx = px;
        style.heightPercent = null;
      }
      return;
    }
    case "min-width": {
      style.minWidthPx = v === "none" || v === "0" ? null : toPx(value, context);
      return;
    }
    case "max-width": {
      style.maxWidthPx = v === "none" ? null : toPx(value, context);
      return;
    }
    case "min-height": {
      style.minHeightPx = v === "none" || v === "0" ? null : toPx(value, context);
      return;
    }
    case "max-height": {
      style.maxHeightPx = v === "none" ? null : toPx(value, context);
      return;
    }
    case "box-sizing": {
      if (v === "border-box" || v === "content-box") style.boxSizing = v;
      return;
    }
    case "margin": {
      const values = expandBox(value, context);
      if (!values) return;
      Object.assign(style, {
        marginTopPx: values.top,
        marginRightPx: values.right,
        marginBottomPx: values.bottom,
        marginLeftPx: values.left,
      });
      return;
    }
    case "margin-top":
    case "margin-right":
    case "margin-bottom":
    case "margin-left": {
      if (v === "auto") {
        if (property === "margin-left") style.marginLeftPx = Number.NaN;
        if (property === "margin-right") style.marginRightPx = Number.NaN;
        return;
      }
      const px = toPx(value, context);
      if (px === null) return;
      if (property === "margin-top") style.marginTopPx = px;
      if (property === "margin-right") style.marginRightPx = px;
      if (property === "margin-bottom") style.marginBottomPx = px;
      if (property === "margin-left") style.marginLeftPx = px;
      return;
    }
    case "padding": {
      const values = expandBox(value, context);
      if (!values) return;
      Object.assign(style, {
        paddingTopPx: values.top,
        paddingRightPx: values.right,
        paddingBottomPx: values.bottom,
        paddingLeftPx: values.left,
      });
      return;
    }
    case "padding-top":
    case "padding-right":
    case "padding-bottom":
    case "padding-left": {
      const px = toPx(value, context);
      if (px === null) return;
      if (property === "padding-top") style.paddingTopPx = px;
      if (property === "padding-right") style.paddingRightPx = px;
      if (property === "padding-bottom") style.paddingBottomPx = px;
      if (property === "padding-left") style.paddingLeftPx = px;
      return;
    }
    case "border": {
      applyBorderShorthand(style, value, context);
      return;
    }
    case "border-width": {
      const values = expandBox(value, context);
      if (!values) return;
      style.borderTopWidthPx = values.top;
      style.borderRightWidthPx = values.right;
      style.borderBottomWidthPx = values.bottom;
      style.borderLeftWidthPx = values.left;
      return;
    }
    case "border-style": {
      const parts = v.split(/\s+/).filter((p) => BORDER_STYLES.has(p as BorderStyleKind));
      if (parts.length === 0) return;
      const [top, right, bottom, left] = expandRepetition(parts) as [
        BorderStyleKind,
        BorderStyleKind,
        BorderStyleKind,
        BorderStyleKind,
      ];
      style.borderTopStyle = top;
      style.borderRightStyle = right;
      style.borderBottomStyle = bottom;
      style.borderLeftStyle = left;
      return;
    }
    case "border-color": {
      const colors = splitTopLevel(value)
        .map((token) => toHex(token))
        .filter((token): token is string => token !== null);
      if (colors.length === 0) return;
      const [top, right, bottom, left] = expandRepetition(colors);
      style.borderTopColor = top;
      style.borderRightColor = right;
      style.borderBottomColor = bottom;
      style.borderLeftColor = left;
      return;
    }
    case "border-radius": {
      applyBorderRadius(style, value, context);
      return;
    }
    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left": {
      applyBorderSide(style, property, value, context);
      return;
    }
    case "border-top-width":
    case "border-right-width":
    case "border-bottom-width":
    case "border-left-width": {
      const px = toPx(value, context);
      if (px === null) return;
      const side = property.slice(-6) as "top" | "right" | "bottom" | "left";
      if (side === "top") style.borderTopWidthPx = px;
      if (side === "right") style.borderRightWidthPx = px;
      if (side === "bottom") style.borderBottomWidthPx = px;
      if (side === "left") style.borderLeftWidthPx = px;
      return;
    }
    case "border-top-color":
    case "border-right-color":
    case "border-bottom-color":
    case "border-left-color": {
      const hex = toHex(value);
      if (!hex) return;
      const side = property.slice(-6) as "top" | "right" | "bottom" | "left";
      if (side === "top") style.borderTopColor = hex;
      if (side === "right") style.borderRightColor = hex;
      if (side === "bottom") style.borderBottomColor = hex;
      if (side === "left") style.borderLeftColor = hex;
      return;
    }
    case "border-top-style":
    case "border-right-style":
    case "border-bottom-style":
    case "border-left-style": {
      if (!BORDER_STYLES.has(v as BorderStyleKind)) return;
      const side = property.slice(-5) as "top" | "right" | "bottom" | "left";
      const kind = v as BorderStyleKind;
      if (side === "top") style.borderTopStyle = kind;
      if (side === "right") style.borderRightStyle = kind;
      if (side === "bottom") style.borderBottomStyle = kind;
      if (side === "left") style.borderLeftStyle = kind;
      return;
    }
    case "flex-direction": {
      if (v === "row" || v === "column") style.flexDirection = v;
      if (v === "row-reverse" || v === "column-reverse") {
        style.flexDirection = v.startsWith("row") ? "row" : "column";
      }
      return;
    }
    case "flex-wrap": {
      if (v === "nowrap" || v === "wrap") style.flexWrap = v;
      return;
    }
    case "justify-content": {
      if (isFlexAlignment(v)) style.justifyContent = v;
      return;
    }
    case "align-items": {
      if (isFlexAlignment(v)) style.alignItems = v;
      return;
    }
    case "align-self": {
      if (v === "auto") style.alignSelf = "auto";
      else if (isFlexAlignment(v)) style.alignSelf = v;
      return;
    }
    case "gap": {
      const px = toPx(value, context);
      style.gapPx = px ?? 0;
      style.rowGapPx = null;
      style.columnGapPx = null;
      return;
    }
    case "row-gap": {
      style.rowGapPx = toPx(value, context);
      return;
    }
    case "column-gap": {
      style.columnGapPx = toPx(value, context);
      return;
    }
    case "flex-grow": {
      const numeric = parseFloat(v);
      if (Number.isFinite(numeric)) style.flexGrow = Math.max(0, numeric);
      return;
    }
    case "flex-shrink": {
      const numeric = parseFloat(v);
      if (Number.isFinite(numeric)) style.flexShrink = Math.max(0, numeric);
      return;
    }
    case "flex-basis": {
      style.flexBasisPx = v === "auto" ? null : toPx(value, context);
      return;
    }
    case "order": {
      const numeric = parseInt(v, 10);
      if (Number.isFinite(numeric)) style.order = numeric;
      return;
    }
    case "font": {
      const parsed = parseFontShorthand(value);
      if (parsed.family) style.fontFamily = firstFontFamily(parsed.family);
      if (parsed.size) {
        const length = parseLength(parsed.size, context);
        if (length?.kind === "px") style.fontSizePx = length.value;
      }
      if (parsed.weight) style.fontWeight = isBoldWeight(parsed.weight) ? 700 : 400;
      if (parsed.style && (parsed.style === "italic" || parsed.style === "oblique")) {
        style.fontStyle = parsed.style;
      }
      return;
    }
    case "list-style-type": {
      return;
    }
    case "text-indent": {
      return;
    }
    default:
      return;
  }
}

function isFlexAlignment(value: string): value is FlexAlignment {
  return (
    value === "flex-start" || value === "flex-end" || value === "center" ||
    value === "space-between" || value === "space-around" || value === "space-evenly" ||
    value === "stretch" || value === "baseline" || value === "start" || value === "end"
  );
}

/** Expand a 1-4 value shorthand into a full box. */
function expandBox(value: string, context: LengthContext): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} | null {
  const tokens = splitTopLevel(value);
  if (tokens.length === 0 || tokens.length > 4) return null;
  const px = tokens.map((token) => toPx(token, context));
  if (px.some((token) => token === null)) return null;
  const [top, right, bottom, left] = expandRepetition(px as number[]);
  return { top, right, bottom, left };
}

/**
 * Expand a 1-4 value list into `[top, right, bottom, left]`.
 *
 * Follows the CSS box shorthand rules exactly:
 *
 * ```text
 * a          -> a    a    a    a
 * a b        -> a    b    a    b
 * a b c      -> a    b    c    b
 * a b c d    -> a    b    c    d
 * ```
 *
 * The 2-value and 3-value cases are where a naive "fill missing with the first
 * value" implementation goes wrong, silently putting `margin: 10px 20px`'s left
 * edge at 10px instead of 20px.
 */
function expandRepetition<T>(values: T[]): [T, T, T, T] {
  const first = values[0]!;
  const second = values[1] ?? first;
  const third = values[2] ?? first;
  const fourth = values[3] ?? (values[2] !== undefined ? second : first);
  return [first, second, third, fourth];
}

/** Extract the colour from a `background` shorthand when it is a plain colour. */
function applyBackground(style: ComputedStyle, value: string, context: LengthContext): void {
  const tokens = splitTopLevel(value);
  const colorToken = tokens.find((token) => toHex(token) !== null);
  if (colorToken) {
    const hex = toHex(colorToken);
    if (hex) {
      style.backgroundColor = hex;
      style.background = hex;
    }
  }
  const position = tokens.find((token) => /^-?\d/.test(token));
  if (position) {
    const length = parseLength(position, context);
    if (length?.kind === "px") {
      style.background = tokens.some((t) => /gradient/i.test(t)) ? style.background : style.background;
    }
  }
}

function applyBorderRadius(style: ComputedStyle, value: string, context: LengthContext): void {
  const tokens = splitTopLevel(value);
  const px = tokens.map((token) => toPx(token, context) ?? 0);
  if (px.length === 0) return;
  const [topLeft] = expandRepetition(px);
  style.borderRadiusPx = Math.max(0, topLeft);
}

function applyBorderShorthand(style: ComputedStyle, value: string, context: LengthContext): void {
  const tokens = splitTopLevel(value);
  let width = 0;
  let color = "#000000";
  let kind: BorderStyleKind = "solid";
  for (const token of tokens) {
    const hex = toHex(token);
    if (hex) {
      color = hex;
      continue;
    }
    const length = parseLength(token, context);
    if (length?.kind === "px") {
      width = length.value;
      continue;
    }
    if (BORDER_STYLES.has(token.toLowerCase() as BorderStyleKind)) {
      kind = token.toLowerCase() as BorderStyleKind;
    }
  }
  if (kind === "none") width = 0;
  style.borderTopWidthPx = width;
  style.borderRightWidthPx = width;
  style.borderBottomWidthPx = width;
  style.borderLeftWidthPx = width;
  style.borderTopColor = color;
  style.borderRightColor = color;
  style.borderBottomColor = color;
  style.borderLeftColor = color;
  style.borderTopStyle = kind;
  style.borderRightStyle = kind;
  style.borderBottomStyle = kind;
  style.borderLeftStyle = kind;
}

function applyBorderSide(
  style: ComputedStyle,
  property: string,
  value: string,
  context: LengthContext,
): void {
  const tokens = splitTopLevel(value);
  let width = 0;
  let color = "#000000";
  let kind: BorderStyleKind = "solid";
  for (const token of tokens) {
    const hex = toHex(token);
    if (hex) {
      color = hex;
      continue;
    }
    const length = parseLength(token, context);
    if (length?.kind === "px") {
      width = length.value;
      continue;
    }
    if (BORDER_STYLES.has(token.toLowerCase() as BorderStyleKind)) {
      kind = token.toLowerCase() as BorderStyleKind;
    }
  }
  if (kind === "none") width = 0;
  const side = property.slice("border-".length) as "top" | "right" | "bottom" | "left";
  if (side === "top") {
    style.borderTopWidthPx = width;
    style.borderTopColor = color;
    style.borderTopStyle = kind;
  }
  if (side === "right") {
    style.borderRightWidthPx = width;
    style.borderRightColor = color;
    style.borderRightStyle = kind;
  }
  if (side === "bottom") {
    style.borderBottomWidthPx = width;
    style.borderBottomColor = color;
    style.borderBottomStyle = kind;
  }
  if (side === "left") {
    style.borderLeftWidthPx = width;
    style.borderLeftColor = color;
    style.borderLeftStyle = kind;
  }
}

/**
 * Compute styles for an entire subtree, depth-first.
 *
 * Returns a map so callers can look up any element without threading the
 * recursive return value through their own traversal. Only the resolved
 * {@link ComputedStyle} is exposed; the per-element {@link LengthContext} stays
 * internal because layout works purely in px.
 */
export function computeStyleTree(
  root: DomElement,
  stylesheet: Stylesheet,
  viewport: { widthPx: number; heightPx: number },
): Map<DomElement, ComputedStyle> {
  const out = new Map<DomElement, ComputedStyle>();
  const visit = (el: DomElement, parentStyle: ComputedStyle | undefined): void => {
    const resolution = computeStyle(el, stylesheet, parentStyle, viewport);
    out.set(el, resolution.style);
    for (const child of el.children) {
      if (isElement(child)) visit(child, resolution.style);
    }
  };
  visit(root, undefined);
  return out;
}

export { INHERITED_PROPERTIES };