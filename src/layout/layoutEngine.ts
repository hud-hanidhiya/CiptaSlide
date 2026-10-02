/**
 * The layout engine.
 *
 * ```
 * DOM + ComputedStyle -> LayoutBox tree -> ElementBox (absolute px)
 * ```
 *
 * This is the PRD's most critical component. It implements a deliberate subset
 * of CSS box layout:
 *
 * - Block flow: children stack vertically, adjacent margins collapse.
 * - Inline flow: inline children and bare text flow horizontally and wrap at the
 *   container's content edge.
 * - Flex: `row`/`column` with `justify-content`, `align-items`, `gap`,
 *   `flex-grow`/`flex-shrink`, and `flex-wrap` as multi-line flow.
 * - Tables: explicit widths win, remaining columns share the space equally.
 * - Positioned: `position: absolute|fixed` resolves `top`/`right`/`bottom`/`left`
 *   against the slide, and `data-pptx-x/y` overrides it entirely.
 *
 * Coordinate contract: a box's `x`/`y` are relative to its parent's **border-box
 * origin**, and the parent is responsible for adding its own border and padding.
 * Converting the tree to absolute slide coordinates is
 * {@link absoluteBoxOf}'s job.
 *
 * Anything the engine cannot represent is reported as a diagnostic rather than
 * silently mislaid, so fidelity loss is always visible.
 */

import type { ComputedStyle } from "../css/cascade";
import { lineWidth, tokensToText, wrapText, type Token } from "../css/metrics";
import type { Diagnostic } from "../shared/ir";
import type { Box } from "../shared/ir";
import type { DomElement, DomNode, DomText } from "../html/dom";
import { elementChildren, isElement, isText } from "../html/dom";

/**
 * Sentinel width used when measuring intrinsic (max-content) size.
 *
 * Large enough that no realistic content wraps, small enough to stay precise
 * in float arithmetic.
 */
const MAX_CONTENT_WIDTH = 100_000;

/** A box in the layout tree, before it becomes a slide element. */
export interface LayoutBox {
  element: DomElement | null;
  /** A text node's own content, when this box represents a run of text. */
  text: string | null;
  style: ComputedStyle;
  children: LayoutBox[];
  /** Border-box geometry relative to the parent's border-box origin. */
  x: number;
  y: number;
  width: number;
  height: number;
  borderTop: number;
  borderRight: number;
  borderBottom: number;
  borderLeft: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  /** Bulleted list depth, 0 for non-list content. */
  listLevel: number;
  /** Ordered-list position, or null for unordered items. */
  listIndex: number | null;
  /** Bullet glyph for `ul` items, null otherwise. */
  bullet: string | null;
  /**
   * True for synthetic boxes that hold one line of inline content.
   *
   * A line box has no element of its own and always belongs to the paragraph
   * its parent is building, which is how the mapper knows not to start a new
   * paragraph for it.
   */
  isLineBox: boolean;
  /** Line boxes inside a block container, in local coordinates. */
  lines: LayoutLine[];
}

/** One laid-out line of text inside a block container. */
export interface LayoutLine {
  /** Horizontal offset from the content edge. */
  x: number;
  /** Vertical offset from the content edge, i.e. the top of the line box. */
  y: number;
  height: number;
  width: number;
  tokens: Token[];
  /** DOM nodes contributing to this line, in document order. */
  nodes: Array<{ node: DomNode; style: ComputedStyle; text: string }>;
}

/** Input to {@link layoutTree}. */
export interface LayoutOptions {
  /** Slide width in CSS px. */
  slideWidthPx: number;
  /** Slide height in CSS px. */
  slideHeightPx: number;
  /** Computed styles keyed by element identity. */
  styles: Map<DomElement, ComputedStyle>;
  /** `data-pptx-*` geometry overrides keyed by element identity, in CSS px. */
  overrides?: Map<DomElement, LayoutOverride>;
  /** Collects warnings raised during layout. */
  diagnostics: Diagnostic[];
  /** 0-based slide index, stamped onto diagnostics. */
  slideIndex: number;
}

/** How a box should resolve an unspecified width. */
type Sizing = "fill" | "max-content";

/** Position and size forced by `data-pptx-*`, already converted to px. */
export interface LayoutOverride {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ignore?: boolean;
}

/** A child node paired with the style that applies to it. */
interface LayoutChild {
  node: DomNode;
  style: ComputedStyle;
}

/** Margin value with `auto` resolved to 0 for layout maths. */
function marginOrZero(value: number | null): number {
  return value === null || Number.isNaN(value) ? 0 : value;
}

/** True when the value is `NaN`, which marks an `auto` margin. */
function isAutoMargin(value: number | null): boolean {
  return value === null || Number.isNaN(value);
}

/** Resolve an element's explicit width, or null when it depends on content. */
function resolveWidth(style: ComputedStyle, availablePx: number): number | null {
  if (style.widthPx !== null) return style.widthPx;
  if (style.widthPercent !== null) return (style.widthPercent / 100) * availablePx;
  return null;
}

/** Resolve an element's explicit height, or null when it depends on content. */
function resolveHeight(style: ComputedStyle, basisPx: number): number | null {
  if (style.heightPx !== null) return style.heightPx;
  if (style.heightPercent !== null) return (style.heightPercent / 100) * basisPx;
  return null;
}

/** Apply min/max clamping to a resolved size. */
function clampSize(style: ComputedStyle, value: number, axis: "width" | "height"): number {
  let out = value;
  const min = axis === "width" ? style.minWidthPx : style.minHeightPx;
  const max = axis === "width" ? style.maxWidthPx : style.maxHeightPx;
  if (min !== null && min > 0) out = Math.max(out, min);
  if (max !== null && max > 0) out = Math.min(out, max);
  return out;
}

/** Total horizontal border + padding of a box. */
function horizontalExtra(box: LayoutBox): number {
  return box.paddingLeft + box.paddingRight + box.borderLeft + box.borderRight;
}

/** Total vertical border + padding of a box. */
function verticalExtra(box: LayoutBox): number {
  return box.paddingTop + box.paddingBottom + box.borderTop + box.borderBottom;
}

/** The content width of a box. */
function contentWidth(box: LayoutBox): number {
  return Math.max(0, box.width - horizontalExtra(box));
}

/** The content height of a box. */
function contentHeight(box: LayoutBox): number {
  return Math.max(0, box.height - verticalExtra(box));
}

/** Build an empty box for an element. */
function makeBox(element: DomElement | null, style: ComputedStyle, text: string | null): LayoutBox {
  return {
    element,
    text,
    style,
    children: [],
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    borderTop: style.borderTopStyle === "none" ? 0 : style.borderTopWidthPx,
    borderRight: style.borderRightStyle === "none" ? 0 : style.borderRightWidthPx,
    borderBottom: style.borderBottomStyle === "none" ? 0 : style.borderBottomWidthPx,
    borderLeft: style.borderLeftStyle === "none" ? 0 : style.borderLeftWidthPx,
    paddingTop: style.paddingTopPx,
    paddingRight: style.paddingRightPx,
    paddingBottom: style.paddingBottomPx,
    paddingLeft: style.paddingLeftPx,
    marginTop: marginOrZero(style.marginTopPx),
    marginRight: marginOrZero(style.marginRightPx),
    marginBottom: marginOrZero(style.marginBottomPx),
    marginLeft: marginOrZero(style.marginLeftPx),
    listLevel: 0,
    listIndex: null,
    bullet: null,
    isLineBox: false,
    lines: [],
  };
}

/** True when the element produces an inline-level box. */
function isInlineLevel(style: ComputedStyle): boolean {
  return (
    style.display === "inline" ||
    style.display === "inline-block" ||
    style.display === "inline-flex"
  );
}

/**
 * Lay out a subtree and return its root box.
 *
 * The root's `x`/`y` are 0; absolute slide coordinates are derived from it with
 * {@link absoluteBoxOf}.
 */
export function layoutTree(root: DomElement, options: LayoutOptions): LayoutBox {
  const rootStyle = options.styles.get(root);
  if (!rootStyle) {
    throw new Error(`layoutTree: no computed style for root element <${root.tagName}>`);
  }
  const box = layoutElement(root, rootStyle, options, options.slideWidthPx, "fill");
  applyPositioning(box, options);
  return box;
}

/**
 * Compute a box's absolute slide coordinates.
 *
 * Accumulates each ancestor's `x`/`y` only. Border and padding are deliberately
 * *not* re-added here: the layout engine already positions a child against its
 * parent's padding edge, so `child.x` already contains the parent's border and
 * padding. Adding them again would shift every padded subtree twice over.
 */
export function absoluteBoxOf(root: LayoutBox, box: LayoutBox): Box {
  const chain: LayoutBox[] = [];
  const find = (current: LayoutBox): boolean => {
    chain.push(current);
    if (current === box) return true;
    for (const child of current.children) {
      if (find(child)) return true;
    }
    return false;
  };
  find(root);

  let x = 0;
  let y = 0;
  for (const node of chain) {
    x += node.x;
    y += node.y;
  }
  return {
    x: round4(x),
    y: round4(y),
    width: round4(box.width),
    height: round4(box.height),
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Lay out one element and its subtree. */
function layoutElement(
  el: DomElement,
  style: ComputedStyle,
  options: LayoutOptions,
  availableWidthPx: number,
  sizing: Sizing,
): LayoutBox {
  const box = makeBox(el, style, null);
  const available = sizing === "max-content" ? MAX_CONTENT_WIDTH : availableWidthPx;
  const override = options.overrides?.get(el);
  const explicitWidth = override?.width ?? resolveWidth(style, available);
  const shrinkToFit = explicitWidth === null && (isInlineLevel(style) || sizing === "max-content");

  if (explicitWidth !== null) {
    box.width =
      style.boxSizing === "border-box" ? Math.max(0, explicitWidth - horizontalExtra(box)) : explicitWidth;
  } else if (!shrinkToFit) {
    box.width = available;
  }

  // While shrink-to-fitting, children are laid out against the full available
  // width and the box adopts whatever extent they end up needing.
  const childAvailable = box.width > 0 ? contentWidth(box) : available;
  const childSizing: Sizing = sizing === "max-content" ? "max-content" : "fill";
  const children = layoutableChildren(el, options);

  if (el.tagName === "table") {
    layoutTable(box, el, options, box.width > 0 ? contentWidth(box) : childAvailable);
  } else if (style.display === "flex" || style.display === "inline-flex") {
    layoutFlex(box, children, options, childAvailable, childSizing);
  } else {
    layoutBlockFlow(box, children, options, childAvailable, childSizing);
  }

  if (shrinkToFit) {
    box.width = clampSize(style, shrinkToFitWidth(box), "width");
  }

  const explicitHeight = override?.height ?? resolveHeight(style, availableWidthPx);
  if (explicitHeight !== null && explicitHeight !== undefined) {
    // `data-pptx-height` is a border-box size, matching how the attribute reads
    // against a slide that is itself specified in inches.
    const target =
      override?.height !== undefined
        ? explicitHeight
        : style.boxSizing === "border-box"
          ? explicitHeight
          : explicitHeight + verticalExtra(box);
    box.height = clampSize(style, target, "height");
  } else {
    box.height = clampSize(style, box.height, "height");
  }

  return box;
}

/**
 * Border-box width needed to contain a shrink-to-fit box's children.
 *
 * Children are positioned relative to the border-box origin, so the padding
 * offset is subtracted back out before adding the outer padding and border.
 */
function shrinkToFitWidth(box: LayoutBox): number {
  let used = 0;
  for (const child of box.children) {
    used = Math.max(used, child.x + child.width);
  }
  const contentUsed = Math.max(0, used - box.borderLeft - box.paddingLeft);
  return box.borderLeft + box.paddingLeft + contentUsed + box.paddingRight + box.borderRight;
}

/**
 * Collect children that participate in layout, skipping hidden subtrees.
 *
 * Text nodes carry no style of their own: they inherit the computed style of
 * their parent element, which is what the cascade already resolved.
 */
function layoutableChildren(el: DomElement, options: LayoutOptions): LayoutChild[] {
  const out: LayoutChild[] = [];
  const parentStyle = options.styles.get(el);
  if (!parentStyle) return out;

  for (const child of el.children) {
    if (isText(child)) {
      if (child.value.trim() === "") continue;
      out.push({ node: child, style: parentStyle });
      continue;
    }
    if (!isElement(child)) continue;
    if (options.overrides?.get(child)?.ignore) continue;
    const style = options.styles.get(child);
    if (!style) continue;
    if (style.display === "none") continue;
    if (style.visibility === "hidden") continue;
    out.push({ node: child, style });
  }
  return out;
}

/**
 * Lay out block-level children with margin collapsing.
 *
 * Children are partitioned into runs of inline content and individual blocks.
 * Each inline run becomes a sequence of line boxes that wraps at the content
 * edge, matching the browser's inline formatting context; each block child
 * advances the cursor and collapses its margins with the previous sibling.
 */
function layoutBlockFlow(
  box: LayoutBox,
  children: LayoutChild[],
  options: LayoutOptions,
  childAvailable: number,
  sizing: Sizing,
): void {
  const contentLeft = box.borderLeft + box.paddingLeft;
  const contentTop = box.borderTop + box.paddingTop;

  let cursorY = contentTop;
  let previousMarginBottom = 0;
  let first = true;
  let inlineRun: LayoutChild[] = [];

  const flushInline = (): void => {
    if (inlineRun.length === 0) return;
    const lines = layoutInlineRun(box, inlineRun, options, childAvailable);
    inlineRun = [];
    const alignOffset = textAlignOffset(box.style.textAlign, childAvailable, maxLineWidth(lines));
    for (const line of lines) {
      line.x = contentLeft + alignOffset;
      line.y = cursorY;
      box.children.push(line);
      cursorY += line.height;
    }
    // Line boxes never contribute a margin, so the previous block's bottom
    // margin is already accounted for and must not be added twice.
    previousMarginBottom = 0;
    first = false;
  };

  for (const child of children) {
    const childEl = isElement(child.node) ? child.node : null;
    if (childEl !== null && options.overrides?.get(childEl)?.ignore) continue;

    if (childEl === null || isInlineLevel(child.style)) {
      inlineRun.push(child);
      continue;
    }

    flushInline();
    const childBox = layoutElement(child.node as DomElement, child.style, options, childAvailable, sizing);
    applyListMarkers(childBox, child.node as DomElement, indexOfChild(children, child));

    if (child.style.position === "absolute" || child.style.position === "fixed") {
      // Positioned children are placed against the slide later and take no part
      // in flow.
      childBox.x = contentLeft;
      childBox.y = contentTop;
      box.children.push(childBox);
      first = false;
      continue;
    }

    if (first) {
      cursorY += childBox.marginTop;
    } else {
      cursorY += Math.max(previousMarginBottom, childBox.marginTop);
    }

    childBox.x = contentLeft + resolveBlockOffset(box, childBox, childAvailable);
    childBox.y = cursorY;
    cursorY += childBox.height;
    previousMarginBottom = childBox.marginBottom;
    box.children.push(childBox);
    first = false;
  }

  flushInline();
  box.height = cursorY + previousMarginBottom + box.paddingBottom + box.borderBottom;
}

/** Position of a child within its parent's child list, for list numbering. */
function indexOfChild(children: LayoutChild[], target: LayoutChild): number {
  return children.indexOf(target);
}

/** Horizontal offset applied to a line for the parent's `text-align`. */
function textAlignOffset(align: ComputedStyle["textAlign"], available: number, lineWidthPx: number): number {
  const free = Math.max(0, available - lineWidthPx);
  if (align === "center") return free / 2;
  if (align === "right") return free;
  return 0;
}

function maxLineWidth(lines: LayoutBox[]): number {
  return lines.reduce((max, line) => Math.max(max, line.width), 0);
}

/**
 * Pack an inline run into line boxes.
 *
 * Every item is first measured at its intrinsic (max-content) width so inline
 * siblings pack against each other. Packing then places them left to right and
 * breaks a line when the next item would cross the content edge.
 *
 * A text item wider than the whole content edge is re-wrapped to the available
 * width and becomes one line box per wrapped line; otherwise a long paragraph
 * in a narrow box would stay on one line and overflow.
 *
 * Vertical placement uses an ascent approximation so text of different sizes in
 * one line still lines up on a shared baseline.
 */
function layoutInlineRun(
  parent: LayoutBox,
  run: LayoutChild[],
  options: LayoutOptions,
  availableWidthPx: number,
): LayoutBox[] {
  /** One inline item: either an atomic element or a re-wrappable text node. */
  type InlineItem = { box: LayoutBox; text: DomText | null };

  const items: InlineItem[] = [];
  for (const child of run) {
    if (isText(child.node)) {
      items.push({ box: layoutTextNode(child.node, child.style, MAX_CONTENT_WIDTH), text: child.node });
      continue;
    }
    if (!isElement(child.node)) continue;
    items.push({
      box: layoutElement(child.node, child.style, options, MAX_CONTENT_WIDTH, "max-content"),
      text: null,
    });
  }
  if (items.length === 0) return [];

  const lines: LayoutBox[] = [];
  let current: LayoutBox[] = [];
  let currentWidth = 0;

  const pushLine = (): void => {
    if (current.length === 0) return;
    lines.push(buildLineBox(parent, current, currentWidth));
    current = [];
    currentWidth = 0;
  };

  for (const { box: item, text } of items) {
    // A text node that cannot fit on any line is broken up into its own lines.
    if (text !== null && item.width > availableWidthPx && item.lines.length === 1) {
      const wrapped = layoutTextNode(text, item.style, availableWidthPx);
      if (wrapped.lines.length > 1) {
        pushLine();
        for (const line of wrapped.lines) {
          const slice = makeBox(null, item.style, text.value);
          slice.lines = [line];
          slice.width = line.width;
          slice.height = item.height / item.lines.length;
          current.push(slice);
          pushLine();
        }
        continue;
      }
    }

    if (current.length > 0 && currentWidth + item.width > availableWidthPx) pushLine();
    current.push(item);
    currentWidth += item.width + (current.length > 1 ? inlineSpacing(item.style) : 0);
  }
  pushLine();
  return lines;
}

/** Whitespace contribution implied by the sibling margin of an inline box. */
function inlineSpacing(style: ComputedStyle): number {
  return marginOrZero(style.marginLeftPx);
}

/** Assemble positioned items into one line box with a shared baseline. */
function buildLineBox(parent: LayoutBox, items: LayoutBox[], width: number): LayoutBox {
  const line = makeBox(null, parent.style, null);
  line.isLineBox = true;
  line.borderTop = 0;
  line.borderRight = 0;
  line.borderBottom = 0;
  line.borderLeft = 0;
  line.paddingTop = 0;
  line.paddingRight = 0;
  line.paddingBottom = 0;
  line.paddingLeft = 0;
  line.width = width;

  const baseline = items.reduce((max, item) => Math.max(max, ascentOf(item.style)), 0);
  let cursorX = 0;
  for (const item of items) {
    item.x = cursorX;
    item.y = baseline - ascentOf(item.style);
    cursorX += item.width + inlineSpacing(item.style);
    line.children.push(item);
  }

  const descent = items.reduce(
    (max, item) => Math.max(max, item.height - ascentOf(item.style)),
    0,
  );
  line.height = baseline + descent;
  return line;
}

/**
 * Approximate ascent above the baseline, as a fraction of the font size.
 *
 * Real metrics are unavailable without font files; 0.8em matches the ascent of
 * common sans-serif faces closely enough to keep mixed-size text aligned.
 */
function ascentOf(style: ComputedStyle): number {
  return style.fontSizePx * 0.8;
}

/** Horizontal offset for a block child, centring when both margins are `auto`. */
function resolveBlockOffset(parent: LayoutBox, child: LayoutBox, available: number): number {
  const autoLeft = isAutoMargin(child.style.marginLeftPx);
  const autoRight = isAutoMargin(child.style.marginRightPx);
  if (!autoLeft && !autoRight) return child.marginLeft;
  const free = available - child.width - horizontalExtra(child);
  if (autoLeft && autoRight) return Math.max(0, free / 2);
  return autoLeft ? Math.max(0, free) : 0;
}

/**
 * Create a box representing a bare text node flowing inside `parent`.
 *
 * The box always reports its **intrinsic** width (the widest wrapped line), not
 * the width it was offered. Wrapping still respects `availableWidthPx`, so a long
 * paragraph in a 200px box wraps into several lines while each of those lines
 * measures its own width — which is what lets {@link layoutInlineRun} pack
 * several text and inline-element boxes onto one shared line.
 */
function layoutTextNode(
  node: DomNode,
  style: ComputedStyle,
  availableWidthPx: number,
): LayoutBox {
  const textBox = makeBox(null, style, isText(node) ? node.value : "");
  const bold = style.fontWeight >= 600;

  const lines = wrapText(
    textBox.text ?? "",
    availableWidthPx - textBox.paddingLeft - textBox.paddingRight,
    style.fontSizePx,
    style.fontFamily,
    style.letterSpacingPx,
    bold,
  );

  const lineHeightPx = style.fontSizePx * style.lineHeight;
  textBox.lines = lines.map((tokens, index): LayoutLine => ({
    x: 0,
    y: index * lineHeightPx,
    height: lineHeightPx,
    width: lineWidth(tokens),
    tokens,
    nodes: [{ node, style, text: tokensToText(tokens) }],
  }));

  const widest = lines.reduce((max, tokens) => Math.max(max, lineWidth(tokens)), 0);
  textBox.width = widest + textBox.paddingLeft + textBox.paddingRight;
  textBox.height = textBox.paddingTop + lines.length * lineHeightPx + textBox.paddingBottom;
  return textBox;
}

/** Attach bullet glyphs and nesting depth to list items. */
function applyListMarkers(box: LayoutBox, el: DomElement, index: number): void {
  if (el.tagName !== "li") return;
  const parent = el.parent;
  if (!parent) return;

  const ordered = parent.tagName === "ol";
  box.listLevel = countListAncestors(el);
  const startAttr = ordered ? parent.attributes.start : undefined;
  const startValue = startAttr === undefined ? Number.NaN : Number.parseInt(startAttr, 10);
  const start = Number.isFinite(startValue) ? startValue : 1;
  box.listIndex = ordered ? start + index : null;
  box.bullet = ordered ? null : listBulletGlyph(box.listLevel);
}

/** Glyph used for `ul` markers at each nesting level. */
function listBulletGlyph(level: number): string {
  return ["•", "◦", "▪"][level % 3] ?? "•";
}

function countListAncestors(el: DomElement): number {
  let level = 0;
  let current = el.parent;
  while (current) {
    if (current.tagName === "li") level += 1;
    current = current.parent;
  }
  return level;
}

/**
 * Lay out flex children.
 *
 * Items are first measured at their max-content size, which is what `flex-basis:
 * auto` means in CSS, then grown or shrunk to fit the line. Wrapping flex flows
 * onto additional lines.
 */
function layoutFlex(
  box: LayoutBox,
  children: LayoutChild[],
  options: LayoutOptions,
  mainSize: number,
  sizing: Sizing,
): void {
  const contentLeft = box.borderLeft + box.paddingLeft;
  const contentTop = box.borderTop + box.paddingTop;
  const isRow = box.style.flexDirection === "row";
  const gap = resolveGap(box.style, box.style.flexDirection);

  const items: Array<{ box: LayoutBox; basis: number }> = [];
  for (const child of children) {
    if (isText(child.node)) {
      const textBox = layoutTextNode(child.node, child.style, mainSize);
      items.push({ box: textBox, basis: textBox.width });
      continue;
    }
    if (!isElement(child.node)) continue;
    if (child.style.position === "absolute" || child.style.position === "fixed") {
      const positioned = layoutElement(child.node, child.style, options, mainSize, sizing);
      positioned.x = contentLeft;
      positioned.y = contentTop;
      box.children.push(positioned);
      continue;
    }
    const probe = layoutElement(child.node, child.style, options, MAX_CONTENT_WIDTH, "max-content");
    const basis = child.style.flexBasisPx ?? probe.width;
    // Always lay out a second time at the resolved basis. An element with an
    // explicit `width` reports the same width in both passes, but its *children*
    // need the real available width instead of the intrinsic one, otherwise
    // nested blocks shrink to their text instead of filling the item.
    const item = layoutElement(child.node, child.style, options, basis, "fill");
    if (basis <= 0) item.width = probe.width;
    items.push({ box: item, basis });
  }

  if (items.length === 0) {
    box.height = verticalExtra(box);
    return;
  }

  const totalBasis = items.reduce((sum, item) => sum + item.basis, 0);
  const gapsTotal = gap * (items.length - 1);
  const free = mainSize - totalBasis - gapsTotal;
  distributeFreeSpace(items, isRow, free);

  // Line breaking for `flex-wrap: wrap`; otherwise everything is on one line.
  const lines: Array<typeof items> = [];
  if (box.style.flexWrap === "wrap") {
    let currentLine: typeof items = [];
    let used = 0;
    for (const item of items) {
      const size = item.basis + gap;
      if (currentLine.length > 0 && used + size > mainSize) {
        lines.push(currentLine);
        currentLine = [];
        used = 0;
      }
      currentLine.push(item);
      used += size;
    }
    if (currentLine.length > 0) lines.push(currentLine);
  } else {
    lines.push(items);
  }

  let crossCursor = contentTop;
  // The cross size of a single-line flex container is its own content box, so
  // `align-items: center` has room to work. For wrapped containers the line's
  // cross size is the tallest item, as the spec requires.
  const singleLineCrossSize = isRow ? contentHeight(box) : contentWidth(box);

  for (const line of lines) {
    const used = line.reduce((sum, item) => sum + item.basis, 0) + gap * Math.max(0, line.length - 1);
    let mainCursor =
      contentLeft + resolveJustifyOffset(box.style.justifyContent, Math.max(0, mainSize - used), line.length);

    const lineCrossSize =
      lines.length > 1
        ? isRow
          ? line.reduce((max, item) => Math.max(max, item.box.height), 0)
          : line.reduce((max, item) => Math.max(max, item.box.width), 0)
        : Math.max(
            singleLineCrossSize,
            isRow
              ? line.reduce((max, item) => Math.max(max, item.box.height), 0)
              : line.reduce((max, item) => Math.max(max, item.box.width), 0),
          );

    for (const item of line) {
      const crossSize = isRow ? item.box.height : item.box.width;
      const align = item.box.style.alignSelf === "auto" ? box.style.alignItems : item.box.style.alignSelf;

      if (isRow) {
        item.box.x = mainCursor;
        item.box.y = crossCursor + resolveAlignOffset(align, lineCrossSize, crossSize);
        if (align === "stretch" && resolveHeight(item.box.style, mainSize) === null) {
          item.box.height = Math.max(0, lineCrossSize);
        }
        mainCursor += item.box.width + gap;
      } else {
        item.box.y = mainCursor;
        item.box.x = contentLeft + resolveAlignOffset(align, lineCrossSize, crossSize);
        if (align === "stretch" && resolveHeight(item.box.style, mainSize) === null) {
          item.box.width = Math.max(0, lineCrossSize);
        }
        mainCursor += item.box.height + gap;
      }
      box.children.push(item.box);
    }

    crossCursor += lineCrossSize;
    if (!isRow) crossCursor += gap;
  }

  // `crossCursor` already advanced past every line, so it is the cross extent
  // for both axes once the trailing gap is removed.
  const crossExtent = Math.max(0, crossCursor - contentTop - (isRow ? 0 : lines.length > 0 ? gap : 0));
  box.height = contentTop + crossExtent + box.paddingBottom + box.borderBottom;
}

/** Apply `flex-grow` and `flex-shrink` to the items' main-axis size. */
function distributeFreeSpace(
  items: Array<{ box: LayoutBox; basis: number }>,
  isRow: boolean,
  free: number,
): void {
  if (items.length === 0 || Math.abs(free) < 0.01) return;

  if (free > 0) {
    const totalGrow = items.reduce((sum, item) => sum + Math.max(0, item.box.style.flexGrow), 0);
    if (totalGrow <= 0) return;
    for (const item of items) {
      const share = (Math.max(0, item.box.style.flexGrow) / totalGrow) * free;
      const grown = Math.max(0, item.basis + share);
      if (isRow) item.box.width = grown;
      else item.box.height = grown;
    }
    return;
  }

  const totalShrink = items.reduce(
    (sum, item) => sum + Math.max(0, item.box.style.flexShrink) * item.basis,
    0,
  );
  if (totalShrink <= 0) return;
  for (const item of items) {
    const weight = Math.max(0, item.box.style.flexShrink) * item.basis;
    const shrunk = Math.max(0, item.basis + (weight / totalShrink) * free);
    if (isRow) item.box.width = shrunk;
    else item.box.height = shrunk;
  }
}

function resolveGap(style: ComputedStyle, direction: "row" | "column"): number {
  if (direction === "row") return style.columnGapPx ?? style.gapPx;
  return style.rowGapPx ?? style.gapPx;
}

/**
 * Leading offset that implements `justify-content`.
 *
 * `space-between` puts nothing at the start and everything between items, so it
 * contributes no offset. `space-around` and `space-evenly` distribute the free
 * space as a gap per item, plus a leading share.
 */
function resolveJustifyOffset(
  alignment: ComputedStyle["justifyContent"],
  free: number,
  itemCount: number,
): number {
  switch (alignment) {
    case "center":
      return free / 2;
    case "flex-end":
    case "end":
      return free;
    case "space-between":
      return 0;
    case "space-around":
      return free / (itemCount * 2);
    case "space-evenly":
      return free / (itemCount + 1);
    default:
      return 0;
  }
}

function resolveAlignOffset(
  alignment: ComputedStyle["alignItems"],
  lineSize: number,
  itemSize: number,
): number {
  const free = Math.max(0, lineSize - itemSize);
  switch (alignment) {
    case "center":
      return free / 2;
    case "flex-end":
    case "end":
      return free;
    default:
      return 0;
  }
}

/**
 * Lay out a table's rows and cells, then size the table box.
 *
 * Column widths follow the simplified CSS table algorithm: an explicit cell or
 * `<col>` width wins, and the remaining space is shared equally.
 */
function layoutTable(
  box: LayoutBox,
  table: DomElement,
  options: LayoutOptions,
  availableWidthPx: number,
): void {
  const rows: Array<Array<{ element: DomElement; style: ComputedStyle; rowSpan: number; colSpan: number }>> =
    [];

  const collectRows = (node: DomElement): void => {
    for (const child of elementChildren(node)) {
      if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
        collectRows(child);
        continue;
      }
      if (child.tagName !== "tr") continue;
      const cells: (typeof rows)[number] = [];
      for (const cell of elementChildren(child)) {
        if (cell.tagName !== "td" && cell.tagName !== "th") continue;
        const style = options.styles.get(cell);
        if (!style) continue;
        cells.push({
          element: cell,
          style,
          rowSpan: parseSpan(cell.attributes.rowspan, 1),
          colSpan: parseSpan(cell.attributes.colspan, 1),
        });
      }
      if (cells.length > 0) rows.push(cells);
    }
  };
  collectRows(table);

  if (rows.length === 0) {
    box.height = verticalExtra(box);
    return;
  }

  const columnCount = rows.reduce(
    (max, row) => Math.max(max, row.reduce((sum, cell) => sum + cell.colSpan, 0)),
    0,
  );

  const explicitWidths = new Array<number>(columnCount).fill(0);
  for (const row of rows) {
    let column = 0;
    for (const cell of row) {
      const explicit = cell.style.widthPx;
      if (explicit !== null && explicit > 0) {
        for (let i = 0; i < cell.colSpan && column + i < columnCount; i += 1) {
          explicitWidths[column + i] = Math.max(
            explicitWidths[column + i] ?? 0,
            explicit / cell.colSpan,
          );
        }
      }
      column += cell.colSpan;
    }
  }

  const tableWidth = box.width > 0 ? contentWidth(box) : availableWidthPx;
  const specified = explicitWidths.reduce((sum, width) => sum + width, 0);
  const unspecified = explicitWidths.filter((width) => width === 0).length;
  const share = unspecified > 0 ? Math.max(0, tableWidth - specified) / unspecified : 0;
  const columnWidths = explicitWidths.map((width) => (width > 0 ? width : share));

  const contentLeft = box.borderLeft + box.paddingLeft;
  const contentTop = box.borderTop + box.paddingTop;
  let y = contentTop;

  for (const row of rows) {
    let x = contentLeft;
    let rowHeight = 0;
    let column = 0;

    for (const cell of row) {
      let cellWidth = 0;
      for (let i = 0; i < cell.colSpan; i += 1) cellWidth += columnWidths[column + i] ?? 0;

      const cellBox = layoutElement(
        cell.element,
        cell.style,
        options,
        Math.max(0, cellWidth - horizontalExtra(makeBox(cell.element, cell.style, null))),
        "fill",
      );
      const measured = cellBox.height;
      const explicit = resolveHeight(cell.style, tableWidth);
      const height = explicit ?? Math.max(measured, cell.style.fontSizePx * cell.style.lineHeight * 1.4);

      cellBox.x = x;
      cellBox.y = y;
      cellBox.width = cellWidth;
      cellBox.height = height;

      x += cellWidth;
      column += cell.colSpan;
      rowHeight = Math.max(rowHeight, height * cell.rowSpan);
      box.children.push(cellBox);
    }

    y += rowHeight;
  }

  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0);
  if (box.width === 0) {
    box.width = horizontalExtra(box) + totalWidth;
  }
  box.height = y + box.paddingBottom + box.borderBottom;
}

function parseSpan(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/**
 * Apply `position: absolute|fixed` placement.
 *
 * Runs after flow layout: insets are measured against the slide box, matching
 * how a browser resolves an absolutely positioned element whose containing
 * block is the initial containing block. `data-pptx-x/y` overrides insets and
 * is expressed in inches, so it is converted to px first.
 */
function applyPositioning(root: LayoutBox, options: LayoutOptions): void {
  const visit = (box: LayoutBox, parentBorderX: number, parentBorderY: number): void => {
    if (box.element) {
      const style = box.style;
      const override = options.overrides?.get(box.element);

      if (style.position === "absolute" || style.position === "fixed") {
        const x = override?.x ?? resolveInsetX(style, box.width, options.slideWidthPx);
        const y = override?.y ?? resolveInsetY(style, box.height, options.slideHeightPx);
        // Re-express the slide-absolute position as an offset from the parent's
        // border-box origin, which is the contract every reader assumes.
        box.x = x - parentBorderX;
        box.y = y - parentBorderY;
      } else if (override?.x !== undefined || override?.y !== undefined) {
        if (override.x !== undefined) box.x = override.x - parentBorderX;
        if (override.y !== undefined) box.y = override.y - parentBorderY;
      }
    }

    const borderX = parentBorderX + box.x;
    const borderY = parentBorderY + box.y;
    for (const child of box.children) visit(child, borderX, borderY);
  };

  visit(root, 0, 0);
}

function resolveInsetX(style: ComputedStyle, width: number, containerWidth: number): number {
  if (style.leftPx !== null) return style.leftPx;
  if (style.rightPx !== null) return Math.max(0, containerWidth - width - style.rightPx);
  return 0;
}

function resolveInsetY(style: ComputedStyle, height: number, containerHeight: number): number {
  if (style.topPx !== null) return style.topPx;
  if (style.bottomPx !== null) return Math.max(0, containerHeight - height - style.bottomPx);
  return 0;
}

/** Walk a laid-out tree depth-first. */
export function walkBoxes(box: LayoutBox, visit: (box: LayoutBox) => void): void {
  visit(box);
  for (const child of box.children) walkBoxes(child, visit);
}