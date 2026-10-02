/**
 * DOM + LayoutBox tree -> Intermediate Representation.
 *
 * This module owns the HTML-to-PPTX element mapping table (PRD section 10) and
 * decides what becomes a native PowerPoint object versus a fallback:
 *
 * ```
 * HTML element  ->  SlideElement
 * h1..h6, p     ->  text
 * ul, ol, li    ->  text with bullets
 * a             ->  text with hyperlink
 * pre, code     ->  text with monospace font
 * img, svg      ->  image
 * table         ->  table
 * div, section  ->  shape, but only when visibly decorated
 * hr            ->  line
 * ```
 *
 * A container with no fill and no border is transparent: it contributes layout
 * but produces no shape. That is what stops a plain `<div>` wrapper from
 * becoming a white rectangle painted over its own children.
 */

import type { ComputedStyle } from "../css/cascade";
import { truncateText } from "../css/metrics";
import type { ResolvedAsset } from "../assets/resolver";
import { toHex } from "../shared/color";
import type {
  Box,
  BorderStyle,
  ElementStyle,
  ImageContent,
  ShapeContent,
  SlideElement,
  TableCell,
  TableContent,
  TextAlign,
  TextContent,
  TextParagraph,
  TextRun,
  VerticalAlign,
} from "../shared/ir";
import { ptToPx, round } from "../shared/units";
import type { DomElement, DomNode } from "../html/dom";
import { collapsedTextContent, isElement } from "../html/dom";
import type { PptxOverrides } from "../html/pptxAttributes";
import type { LayoutBox } from "../layout/layoutEngine";

/** Everything the mapper needs to turn boxes into slide elements. */
export interface MapContext {
  /** Computed styles keyed by element identity, from the cascade pass. */
  styles: Map<DomElement, ComputedStyle>;
  /** Default font family when CSS specifies none. */
  defaultFontFamily: string;
  /** Default text colour. */
  defaultColor: string;
  /** Resolved image bytes keyed by element identity. */
  images: Map<DomElement, ResolvedAsset | null>;
  /** `data-pptx-*` overrides keyed by element identity. */
  overrides: Map<DomElement, PptxOverrides>;
  /** Elements whose subtree must be flattened into one raster image. */
  flatten: Set<DomElement>;
  /**
   * Boxes already emitted as runs inside an ancestor's paragraph.
   *
   * A block child that a text element absorbed (`<li><p>…</p></li>`) must not
   * also become its own slide element, or its text appears twice.
   */
  consumed: Set<LayoutBox>;
  /** Collects warnings raised during mapping. */
  warnings: Array<{ message: string; property?: string; element?: string }>;
}

/** Structural tags that never become shapes on their own. */
const STRUCTURAL_TAGS = new Set([
  "section",
  "article",
  "div",
  "figure",
  "figcaption",
  "colgroup",
  "col",
  "defs",
  "title",
  "desc",
  "g",
  "ul",
  "ol",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
]);

/** Tags that map to a text element. */
const TEXT_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "span", "a", "blockquote", "pre", "code", "kbd", "samp",
  "dt", "dd", "figcaption", "small", "mark", "sub", "sup", "li",
]);

/** Inline tags whose styling becomes a run property rather than its own box. */
const INLINE_TAGS = new Set([
  "span", "a", "strong", "b", "em", "i", "u", "s", "strike",
  "small", "mark", "sub", "sup", "code", "br",
]);

/** Tags rendered with a monospace face. */
const MONO_TAGS = new Set(["pre", "code", "kbd", "samp"]);

/**
 * Map a laid-out slide root to slide elements.
 *
 * Box coordinates are relative to their parent's border-box origin, so the walk
 * accumulates each ancestor's origin plus its border and padding. That is what
 * {@link absoluteBoxOf} computes, and it is the only place absolute slide
 * coordinates are produced.
 */
export function mapSlideElements(rootBox: LayoutBox, context: MapContext): SlideElement[] {
  const elements: SlideElement[] = [];
  const counter: Counter = { next: 0 };

  const visit = (box: LayoutBox, parentBorderX: number, parentBorderY: number, ancestorOpacity: number): void => {
    // Contract: a box's `x`/`y` is relative to its parent's **border-box
    // origin**, so the parent origin propagates unchanged. Border and padding
    // are already inside `box.x` because the layout engine positioned the child
    // at the parent's padding edge.
    const borderX = parentBorderX + box.x;
    const borderY = parentBorderY + box.y;

    const el = box.element;
    if (el === null) {
      // Synthetic line boxes carry no element but still own their children.
      for (const child of box.children) visit(child, borderX, borderY, ancestorOpacity);
      return;
    }

    if (context.overrides.get(el)?.ignore) return;
    if (context.consumed.has(box)) return;

    const effectiveOpacity = ancestorOpacity * box.style.opacity;
    if (effectiveOpacity <= 0) return;

    const absolute: Box = {
      x: round(borderX),
      y: round(borderY),
      width: round(box.width),
      height: round(box.height),
    };

    if (context.flatten.has(el)) {
      const flattened = buildFlattenedElement(box, absolute, context, effectiveOpacity);
      if (flattened) elements.push(flattened);
      return;
    }

    const mapped = mapBox(box, absolute, context, effectiveOpacity, counter);
    if (mapped) elements.push(mapped);
    for (const child of box.children) visit(child, borderX, borderY, effectiveOpacity);
  };

  visit(rootBox, 0, 0, 1);
  return elements;
}

/** Dispatch a single box on its tag name. */
function mapBox(
  box: LayoutBox,
  geometry: Box,
  context: MapContext,
  ancestorOpacity: number,
  counter: Counter,
): SlideElement | null {
  const el = box.element!;
  const overrides = context.overrides.get(el);
  const style = buildStyle(box, context, overrides);

  // An explicit `data-pptx-type` wins over the tag-based mapping.
  if (overrides?.type === "image") return mapImage(box, context, geometry, style, counter);
  if (overrides?.type === "shape") return mapShape(box, context, overrides, geometry, style, counter);
  if (overrides?.type === "line") return mapRule(box, geometry, style, counter);
  if (overrides?.type === "text") return mapText(box, context, overrides, geometry, style, counter, true);

  switch (el.tagName) {
    case "img":
      return mapImage(box, context, geometry, style, counter);
    case "svg":
      return mapSvg(box, context, geometry, style, counter);
    case "hr":
      return mapRule(box, geometry, style, counter);
    case "table":
      return mapTable(box, context, geometry, style, counter);
    case "ul":
    case "ol":
      // The list itself carries no geometry; its `li` children do.
      return null;
    case "td":
    case "th":
      // Consumed by the parent `<table>` element; never emitted on their own.
      return null;
    default:
      break;
  }

  if (isInlineLevel(box.style) && !isReplacedElement(el.tagName)) {
    // Inline-level boxes do not become their own slide element. Their content
    // has already been folded into the runs of the nearest block-level
    // ancestor's paragraph, which is exactly how CSS inline flow behaves.
    return null;
  }

  if (TEXT_TAGS.has(el.tagName)) {
    return mapText(box, context, overrides, geometry, style, counter, true);
  }

  if (STRUCTURAL_TAGS.has(el.tagName)) {
    // Only a decorated container becomes a shape.
    if (style.background !== null || style.border !== null) {
      return mapShape(box, context, overrides, geometry, style, counter);
    }
    // A transparent wrapper emits only its own inline content, because its block
    // children emit themselves. Without that distinction a `<section>` would
    // paint one text frame over everything it contains.
    return mapText(box, context, overrides, geometry, style, counter, false);
  }

  context.warnings.push({
    message: `<${el.tagName}> has no PowerPoint equivalent and was skipped`,
    element: el.tagName,
  });
  return null;
}

/** Replaced inline elements: they render themselves rather than flowing as text. */
function isReplacedElement(tagName: string): boolean {
  return tagName === "img" || tagName === "svg" || tagName === "br";
}

/** Mutable id counter for one slide. */
interface Counter {
  next: number;
}

/** Allocate a stable element id. */
function nextId(counter: Counter): string {
  counter.next += 1;
  return `el-${counter.next}`;
}

/** Resolve the border into IR form, or null when there is no visible border. */
function resolveBorder(style: ComputedStyle): BorderStyle | null {
  const widths = [
    style.borderTopStyle === "none" ? 0 : style.borderTopWidthPx,
    style.borderRightStyle === "none" ? 0 : style.borderRightWidthPx,
    style.borderBottomStyle === "none" ? 0 : style.borderBottomWidthPx,
    style.borderLeftStyle === "none" ? 0 : style.borderLeftWidthPx,
  ];
  if (widths.every((width) => width <= 0)) return null;

  const colors = [
    style.borderTopColor,
    style.borderRightColor,
    style.borderBottomColor,
    style.borderLeftColor,
  ];
  const kinds = [
    style.borderTopStyle,
    style.borderRightStyle,
    style.borderBottomStyle,
    style.borderLeftStyle,
  ];
  const width = Math.max(...widths, 1);
  const kind = kinds.find((candidate) => candidate !== "none") ?? "solid";
  const color = colors[0] ?? "#000000";

  return { color, widthPx: round(width), style: borderStyleToIr(kind) };
}

function borderStyleToIr(kind: string): "solid" | "dashed" | "dotted" | "none" {
  if (kind === "dashed" || kind === "dotted" || kind === "none") return kind;
  return "solid";
}

/** Build the IR style for a box, applying `data-pptx-*` overrides. */
function buildStyle(
  box: LayoutBox,
  context: MapContext,
  overrides: PptxOverrides | undefined,
): ElementStyle {
  const style = box.style;
  const border = resolveBorder(style);

  const fontSizePx =
    overrides?.fontSizePt !== null && overrides?.fontSizePt !== undefined
      ? ptToPx(overrides.fontSizePt)
      : style.fontSizePx;

  const bold = overrides?.fontWeight
    ? /^(bold|bolder|[6-9]00|1000)$/i.test(overrides.fontWeight.trim())
    : style.fontWeight >= 600;

  return {
    fontFamily: overrides?.fontFamily ?? style.fontFamily ?? context.defaultFontFamily,
    fontSizePx,
    bold,
    italic: style.fontStyle === "italic" || style.fontStyle === "oblique",
    underline: style.underline,
    strike: style.strike,
    color: toHex(overrides?.color ?? style.color ?? context.defaultColor),
    background: overrides?.background
      ? toHex(overrides.background)
      : (style.background ?? null),
    textAlign: (overrides?.align as TextAlign | null) ?? normalizeAlign(style.textAlign),
    verticalAlign: normalizeVerticalAlign(style.verticalAlign),
    lineHeight: style.lineHeight,
    border,
    borderRadiusPx: style.borderRadiusPx,
    bullet: overrides?.bullet ?? box.bullet,
    listIndex: box.listIndex,
    listLevel: box.listLevel,
    rotate: overrides?.rotate ?? 0,
    opacity: 1,
    hyperlink: hyperlinkOf(box.element),
  };
}

function normalizeAlign(align: ComputedStyle["textAlign"]): TextAlign {
  return align === "justify" ? "justify" : align;
}

function normalizeVerticalAlign(align: ComputedStyle["verticalAlign"]): VerticalAlign {
  if (align === "middle") return "middle";
  if (align === "bottom") return "bottom";
  return "top";
}

/** Read an `<a href>` for the hyperlink property. */
function hyperlinkOf(el: DomElement | null | undefined): string | null {
  if (!el || el.tagName !== "a") return null;
  const href = el.attributes.href;
  return href !== undefined && href.trim() !== "" ? href : null;
}

/**
 * Build a text element from a block box.
 *
 * `absorbBlocks` decides who owns the block children:
 *
 * - `true` for a real text container (`p`, `h1`, `li`): its block descendants
 *   are folded into its paragraphs and marked consumed, so they are not also
 *   emitted as their own slide elements.
 * - `false` for a transparent structural wrapper (`div`, `section`): only its
 *   own inline content is emitted. Without this distinction a `<section>` would
 *   paint one giant text frame on top of everything it contains.
 */
function mapText(
  box: LayoutBox,
  context: MapContext,
  overrides: PptxOverrides | undefined,
  geometry: Box,
  style: ElementStyle,
  counter: Counter,
  absorbBlocks: boolean,
): SlideElement | null {
  const el = box.element!;
  if (MONO_TAGS.has(el.tagName) && !overrides?.fontFamily) style.fontFamily = "Courier New";

  const paragraphs = collectParagraphs(box, overrides, context, absorbBlocks);
  if (paragraphs.length === 0) return null;

  const content: TextContent = { paragraphs };
  return {
    id: nextId(counter),
    type: "text",
    box: geometry,
    style,
    sourceTag: el.tagName,
    isFallback: false,
    content,
  };
}

/**
 * Collect paragraphs and runs from a laid-out box.
 *
 * Walks the block tree: block-level children start a new paragraph, while
 * inline children and bare text nodes append runs to the paragraph in progress.
 * That is what turns `<p>Otomatis dan <strong>cepat</strong>.</p>` into one
 * paragraph with three runs instead of three separate paragraphs.
 *
 * `absorbBlocks` marks absorbed block children as consumed so the visitor does
 * not emit them again as separate slide elements.
 */
function collectParagraphs(
  box: LayoutBox,
  overrides: PptxOverrides | undefined,
  context: MapContext,
  absorbBlocks: boolean,
): TextParagraph[] {
  const paragraphs: TextParagraph[] = [];
  const bulletOverride = overrides?.bulletDisabled ? null : overrides?.bullet ?? null;
  let pending: TextRun[] = [];

  const flush = (align: TextAlign, listLevel: number, listIndex: number | null, bullet: string | null): void => {
    const runs = trimRunEdges(pending);
    pending = [];
    if (runs.length === 0) return;
    paragraphs.push({
      runs,
      align,
      spaceBeforePx: 0,
      spaceAfterPx: 0,
      bullet: bulletOverride ?? bullet,
      listLevel,
      listIndex,
    });
  };

  const walk = (current: LayoutBox, linkOwner?: DomElement | null): void => {
    if (current.text !== null) {
      pending.push(...runsFromBox(current, linkOwner));
      return;
    }

    if (current.isLineBox) {
      // Line boxes are an implementation detail of inline flow: their runs all
      // belong to the paragraph the surrounding block is building.
      for (const child of current.children) walk(child, linkOwner);
      return;
    }

    if (!current.element) {
      for (const child of current.children) walk(child, linkOwner);
      return;
    }

    if (current.element.tagName === "ul" || current.element.tagName === "ol") {
      // A nested list owns its own `li` elements, which are mapped separately.
      // Absorbing them here would duplicate their text inside the parent item.
      return;
    }

    if (context.overrides.get(current.element)?.ignore) return;

    // An `<a>` is inline-level, so its own box has no lines; the link target
    // has to be handed down to the synthetic text boxes inside it.
    const innerLink =
      current.element.tagName === "a" ? current.element : linkOwner;

    if (isInlineLevel(current.style)) {
      // Inline formatting wraps text but does not start a paragraph. Its own
      // lines, if it produced any, contribute runs in place.
      if (current.lines.length > 0) pending.push(...runsFromBox(current, innerLink));
      else for (const child of current.children) walk(child, innerLink);
      return;
    }

    if (current.element.tagName === "br") {
      pending.push(lineBreakRun());
      return;
    }

    if (!absorbBlocks) {
      // A transparent wrapper emits only its own inline content. Descend into
      // inline children and line boxes, but stop at any block child: that is a
      // separate slide element and must not be duplicated here.
      for (const child of current.children) {
        if (child.isLineBox || child.text !== null || !child.element || isInlineLevel(child.style)) {
          walk(child, linkOwner);
        }
      }
      return;
    }

    // A block-level child owns its own paragraph(s).
    flush(normalizeAlign(current.style.textAlign), current.listLevel, current.listIndex, current.bullet);
    context.consumed.add(current);
    for (const child of current.children) walk(child);
    flush(normalizeAlign(current.style.textAlign), current.listLevel, current.listIndex, current.bullet);
  };

  walk(box);
  flush(normalizeAlign(box.style.textAlign), box.listLevel, box.listIndex, box.bullet);
  return paragraphs;
}

/**
 * Trim whitespace at the edges of a run list.
 *
 * Trailing spaces between inline elements must survive, since
 * `<span>a </span><span>b</span>` needs its space; only the outermost edges are
 * collapsed.
 */
function trimRunEdges(runs: TextRun[]): TextRun[] {
  const out = runs.map((run) => ({ ...run }));
  while (out.length > 0) {
    const first = out[0]!;
    const trimmed = first.text.replace(/^\s+/, "");
    if (trimmed === "" && out.length > 1) {
      out.shift();
      continue;
    }
    first.text = trimmed;
    break;
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed === "" && out.length > 1) {
      out.pop();
      continue;
    }
    last.text = trimmed;
    break;
  }
  return out.filter((run) => run.text !== "");
}

/** Convert a laid-out text box into styled runs, one per visual line. */
function runsFromBox(box: LayoutBox, linkOwner?: DomElement | null): TextRun[] {
  const runs: TextRun[] = [];
  for (const [index, line] of box.lines.entries()) {
    const text = line.tokens.map((token) => token.text).join("");
    if (text.trim() === "") continue;
    if (index > 0 && runs.length > 0) runs.push(lineBreakRun());
    runs.push(runFromNode(box, line.nodes[0]?.node, text, linkOwner));
  }
  return runs;
}

/** True when the box participates in inline flow rather than block flow. */
function isInlineLevel(style: ComputedStyle): boolean {
  return (
    style.display === "inline" ||
    style.display === "inline-block" ||
    style.display === "inline-flex"
  );
}

/** A soft line break inside a single paragraph. */
function lineBreakRun(): TextRun {
  return {
    text: "\n",
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: null,
    highlight: null,
    fontSizePx: null,
    fontFamily: null,
    hyperlink: null,
  };
}

/** Build a run from the DOM node that produced the line. */
/**
 * Build a run from the DOM node that produced the line.
 *
 * `linkOwner` is the nearest enclosing `<a>` in the inline chain. A bare text
 * box has no element of its own — the layout engine gives inline content a
 * synthetic box — so the anchor's `href` can only be found by looking upward,
 * and threading it down the walk is what keeps hyperlinks from being dropped.
 */
function runFromNode(
  box: LayoutBox,
  node: DomNode | undefined,
  text: string,
  linkOwner?: DomElement | null,
): TextRun {
  const source = node && isElement(node) ? node : box.element;
  const inlineStyle = source ? applyInlineTagStyle(source, box.style) : box.style;

  return {
    text: applyTextTransform(text, inlineStyle.textTransform),
    bold: inlineStyle.fontWeight >= 600,
    italic: inlineStyle.fontStyle === "italic" || inlineStyle.fontStyle === "oblique",
    underline: inlineStyle.underline,
    strike: inlineStyle.strike,
    color: inlineStyle.color,
    highlight: inlineStyle.backgroundColor,
    fontSizePx: null,
    fontFamily: source && MONO_TAGS.has(source.tagName) ? "Courier New" : null,
    hyperlink:
      hyperlinkOf(source) ?? hyperlinkOf(linkOwner) ?? hyperlinkOf(box.element),
  };
}

/**
 * Apply inline-tag semantics on top of the inherited style.
 *
 * The cascade already resolves most of this; the table below covers the cases
 * where the tag itself is the only signal.
 */
function applyInlineTagStyle(el: DomElement, base: ComputedStyle): ComputedStyle {
  const style: ComputedStyle = { ...base };
  switch (el.tagName) {
    case "strong":
    case "b":
      style.fontWeight = 700;
      break;
    case "em":
    case "i":
      style.fontStyle = "italic";
      break;
    case "u":
      style.underline = true;
      break;
    case "s":
    case "strike":
      style.strike = true;
      break;
    case "small":
      style.fontSizePx = Math.round(base.fontSizePx * 0.83);
      break;
    case "mark":
      style.backgroundColor = "#FFFF00";
      break;
    default:
      break;
  }
  return style;
}

function applyTextTransform(text: string, transform: ComputedStyle["textTransform"]): string {
  switch (transform) {
    case "uppercase":
      return text.toUpperCase();
    case "lowercase":
      return text.toLowerCase();
    case "capitalize":
      return text.replace(/\b\p{L}/gu, (char) => char.toUpperCase());
    default:
      return text;
  }
}

/** Build an image element from an `<img>` or a forced-image box. */
function mapImage(
  box: LayoutBox,
  context: MapContext,
  geometry: Box,
  style: ElementStyle,
  counter: Counter,
): SlideElement | null {
  const el = box.element!;
  const asset = context.images.get(el) ?? null;
  if (!asset) return null;

  const content: ImageContent = {
    dataUri: asset.dataUri,
    naturalWidthPx: asset.widthPx,
    naturalHeightPx: asset.heightPx,
    alt: el.attributes.alt ?? null,
    fit: resolveFit(el),
  };

  return {
    id: nextId(counter),
    type: "image",
    box: applyIntrinsicRatio(content, geometry),
    style,
    sourceTag: el.tagName,
    isFallback: false,
    content,
  };
}

/** Map an `<img>`-like box, honouring the `object-fit` attribute when present. */
function resolveFit(el: DomElement): "contain" | "cover" | "fill" {
  const objectFit = el.attributes["data-pptx-fit"] ?? el.attributes["object-fit"];
  if (objectFit === "cover") return "cover";
  if (objectFit === "fill" || objectFit === "none") return "fill";
  return "contain";
}

/**
 * Correct an image box whose height was not specified.
 *
 * `<img width="200">` with no height keeps the intrinsic ratio in a browser;
 * matching that here avoids a stretched picture.
 */
function applyIntrinsicRatio(content: ImageContent, geometry: Box): Box {
  if (content.naturalWidthPx <= 0 || content.naturalHeightPx <= 0) return geometry;
  const ratio = content.naturalWidthPx / content.naturalHeightPx;
  if (geometry.height <= 0 && geometry.width > 0) {
    return { ...geometry, height: round(geometry.width / ratio) };
  }
  if (geometry.width <= 0 && geometry.height > 0) {
    return { ...geometry, width: round(geometry.height * ratio) };
  }
  return geometry;
}

/**
 * Map an inline `<svg>`.
 *
 * PowerPoint has no SVG primitive, so an SVG becomes a raster asset supplied by
 * the caller. Without one we warn and skip rather than emitting a broken image.
 */
function mapSvg(
  box: LayoutBox,
  context: MapContext,
  geometry: Box,
  style: ElementStyle,
  counter: Counter,
): SlideElement | null {
  const el = box.element!;
  const asset = context.images.get(el) ?? null;
  if (!asset) {
    context.warnings.push({
      message: "<svg> could not be rasterised and was skipped",
      element: "svg",
    });
    return null;
  }
  const content: ImageContent = {
    dataUri: asset.dataUri,
    naturalWidthPx: asset.widthPx,
    naturalHeightPx: asset.heightPx,
    alt: el.attributes["aria-label"] ?? null,
    fit: "contain",
  };
  return {
    id: nextId(counter),
    type: "image",
    box: geometry,
    style,
    sourceTag: "svg",
    isFallback: false,
    content,
  };
}

/** Map an `<hr>` to a line. */
function mapRule(box: LayoutBox, geometry: Box, style: ElementStyle, counter: Counter): SlideElement {
  const border: BorderStyle = style.border ?? {
    color: "#000000",
    widthPx: Math.max(1, round(box.style.borderTopWidthPx) || 1),
    style: "solid",
  };
  const content: ShapeContent = {
    preset: "line",
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ],
  };
  return {
    id: nextId(counter),
    type: "line",
    box: { ...geometry, height: Math.max(1, border.widthPx) },
    style: { ...style, border, background: null, color: border.color },
    sourceTag: box.element?.tagName ?? "hr",
    isFallback: false,
    content,
  };
}

/** Map a decorated container to a rectangle or preset shape. */
function mapShape(
  box: LayoutBox,
  context: MapContext,
  overrides: PptxOverrides | undefined,
  geometry: Box,
  style: ElementStyle,
  counter: Counter,
): SlideElement | null {
  if (geometry.width <= 0 || geometry.height <= 0) return null;
  if (style.background === null && style.border === null) return null;
  const content: ShapeContent = { preset: resolvePreset(box, overrides) };
  return {
    id: nextId(counter),
    type: "shape",
    box: geometry,
    style,
    sourceTag: box.element?.tagName ?? "div",
    isFallback: false,
    content,
  };
}

/** Map a container that must be flattened into a single raster image. */
function buildFlattenedElement(
  box: LayoutBox,
  geometry: Box,
  context: MapContext,
  ancestorOpacity: number,
): SlideElement | null {
  const el = box.element!;
  const asset = context.images.get(el) ?? null;
  if (!asset) {
    context.warnings.push({
      message: `data-pptx-as-image element <${el.tagName}> has no rasterised asset and was skipped`,
      element: el.tagName,
    });
    return null;
  }
  const content: ImageContent = {
    dataUri: asset.dataUri,
    naturalWidthPx: asset.widthPx,
    naturalHeightPx: asset.heightPx,
    alt: el.attributes["aria-label"] ?? collapsedTextContent(el).slice(0, 200),
    fit: "contain",
  };
  const style = baseStyle(context);
  style.opacity = ancestorOpacity;
  return {
    id: `flatten-${el.attributes.id ?? el.tagName}-${round(geometry.x)}-${round(geometry.y)}`,
    type: "image",
    box: geometry,
    style,
    sourceTag: el.tagName,
    isFallback: true,
    content,
  };
}

/** Pick a pptxgenjs preset from the element's border radius. */
function resolvePreset(box: LayoutBox, overrides: PptxOverrides | undefined): string {
  if (overrides?.shape) return overrides.shape;
  if (box.style.borderRadiusPx > 0) return "roundRect";
  return "rect";
}

/** A neutral style used by generated elements. */
function baseStyle(context: MapContext): ElementStyle {
  return {
    fontFamily: context.defaultFontFamily,
    fontSizePx: 16,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: context.defaultColor,
    background: null,
    textAlign: "left",
    verticalAlign: "top",
    lineHeight: 1.2,
    border: null,
    borderRadiusPx: 0,
    bullet: null,
    listIndex: null,
    listLevel: 0,
    rotate: 0,
    opacity: 1,
    hyperlink: null,
  };
}

/** One `<tr>` with its cells and span information. */
interface TableRow {
  el: DomElement;
  cells: Array<{ el: DomElement; colSpan: number; rowSpan: number }>;
}

/** Flatten `<thead>/<tbody>/<tfoot>` into a single row list. */
function collectTableRows(table: DomElement): TableRow[] {
  const rows: TableRow[] = [];
  const visit = (node: DomElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
        visit(child);
        continue;
      }
      if (child.tagName !== "tr") continue;
      const cells: TableRow["cells"] = [];
      for (const cell of child.children) {
        if (!isElement(cell)) continue;
        if (cell.tagName !== "td" && cell.tagName !== "th") continue;
        cells.push({
          el: cell,
          colSpan: parseSpan(cell.attributes.colspan, 1),
          rowSpan: parseSpan(cell.attributes.rowspan, 1),
        });
      }
      if (cells.length > 0) rows.push({ el: child, cells });
    }
  };
  visit(table);
  return rows;
}

function parseSpan(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Map a `<table>` to a PowerPoint table.
 *
 * Column widths come from the layout pass. Cell text is truncated to fit, since
 * PowerPoint tables do not auto-shrink and would otherwise spill text across
 * neighbouring cells.
 */
function mapTable(
  box: LayoutBox,
  context: MapContext,
  geometry: Box,
  style: ElementStyle,
  counter: Counter,
): SlideElement | null {
  const el = box.element!;
  const rows = collectTableRows(el);
  if (rows.length === 0) return null;

  const columnCount = rows.reduce(
    (max, row) => Math.max(max, row.cells.reduce((sum, cell) => sum + cell.colSpan, 0)),
    0,
  );

  const colWidthsPx = new Array<number>(columnCount).fill(0);
  const rowHeightsPx: number[] = [];
  const grid: TableCell[][] = [];
  const cellBoxes = indexCellBoxes(box);

  let totalHeight = 0;

  for (const row of rows) {
    const gridRow: TableCell[] = [];
    let rowHeight = 0;

    for (const cell of row.cells) {
      const cellStyle = context.styles.get(cell.el) ?? box.style;
      const cellBox = cellBoxes.get(cell.el);
      const width = cellBox?.width ?? Math.max(64, geometry.width / Math.max(1, columnCount));

      for (let i = 0; i < cell.colSpan; i += 1) {
        colWidthsPx[gridRow.length + i] = Math.max(
          colWidthsPx[gridRow.length + i] ?? 0,
          width / cell.colSpan,
        );
      }

      const height = cellBox?.height ?? cellStyle.fontSizePx * cellStyle.lineHeight * 1.6;
      rowHeight = Math.max(rowHeight, height);

      gridRow.push({
        text: truncatedCellText(collapsedTextContent(cell.el), cellStyle, width, height),
        color: cellStyle.color,
        background: cellStyle.backgroundColor ?? null,
        bold: cell.el.tagName === "th" || cellStyle.fontWeight >= 600,
        align: normalizeAlign(cellStyle.textAlign),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      });
    }

    // PowerPoint tables need a rectangular grid, so short rows are padded.
    while (gridRow.length < columnCount) {
      gridRow.push({
        text: "",
        color: style.color,
        background: null,
        bold: false,
        align: "left",
        colSpan: 1,
        rowSpan: 1,
      });
    }

    grid.push(gridRow);
    rowHeightsPx.push(round(rowHeight));
    totalHeight += rowHeight;
  }

  const content: TableContent = {
    rows: grid,
    colWidthsPx: colWidthsPx.map((width) => round(width)),
    rowHeightsPx,
    borderColor: style.border?.color ?? null,
    borderWidthPx: style.border?.widthPx ?? 1,
    hasHeaderRow: rows.some((row) => row.cells.some((cell) => cell.el.tagName === "th")),
    hasFooterRow: false,
  };

  return {
    id: nextId(counter),
    type: "table",
    box: { ...geometry, height: round(Math.max(geometry.height, totalHeight)) },
    style,
    sourceTag: "table",
    isFallback: false,
    content,
  };
}

/** Index every `<td>`/`<th>` box inside a table box by element identity. */
function indexCellBoxes(tableBox: LayoutBox): Map<DomElement, LayoutBox> {
  const out = new Map<DomElement, LayoutBox>();
  const visit = (box: LayoutBox): void => {
    if (box.element && (box.element.tagName === "td" || box.element.tagName === "th")) {
      out.set(box.element, box);
      return;
    }
    for (const child of box.children) visit(child);
  };
  visit(tableBox);
  return out;
}

/**
 * Truncate cell text so it fits its box.
 *
 * At most `maxLines` lines survive, computed from the cell height, so long
 * values shrink to an ellipsis rather than overflowing the table.
 */
function truncatedCellText(
  text: string,
  style: ComputedStyle,
  widthPx: number,
  heightPx: number,
): string {
  if (text === "") return "";
  const lineHeightPx = Math.max(1, style.fontSizePx * style.lineHeight);
  const usableHeight = heightPx - style.paddingTopPx - style.paddingBottomPx;
  const maxLines = Math.max(1, Math.floor(usableHeight / lineHeightPx));
  const usableWidth = widthPx - style.paddingLeftPx - style.paddingRightPx;
  const charsPerLine = Math.max(4, Math.floor(usableWidth / (style.fontSizePx * 0.52)));
  if (text.length <= charsPerLine * maxLines) return text;
  return truncateText(text, charsPerLine * maxLines, style.fontSizePx, style.fontFamily);
}