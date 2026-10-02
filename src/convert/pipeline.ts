/**
 * The conversion pipeline.
 *
 * ```
 * HTML -> sanitize -> DOM -> stylesheet -> cascade -> layout -> IR -> PPTX
 * ```
 *
 * Every stage collects {@link Diagnostic}s instead of throwing, so one broken
 * element never loses the whole deck. The only hard failures are the ones that
 * make an IR meaningless: unparseable size options or a stylesheet that cannot
 * be compiled at all.
 *
 * The pipeline is also the single place that knows the supported-CSS subset, so
 * the "this property will be ignored" warnings in the PRD report are emitted
 * here rather than guessed at by callers.
 */

import { AssetResolver, type ResolvedAsset } from "../assets/resolver";
import { computeStyleTree, type ComputedStyle } from "../css/cascade";
import { parseStylesheet } from "../css/parse";
import type { DomElement } from "../html/dom";
import { elementChildren } from "../html/dom";
import { parseHtml, sanitizeCss } from "../html/sanitize";
import { readOverrides, type PptxOverrides } from "../html/pptxAttributes";
import { layoutTree, type LayoutBox, type LayoutOverride } from "../layout/layoutEngine";
import { mapSlideElements, type MapContext } from "../map/domToIr";
import { toHex } from "../shared/color";
import type {
  ConversionReport,
  ConversionStats,
  Diagnostic,
  Presentation,
  Slide,
} from "../shared/ir";
import { inchToPx, round } from "../shared/units";
import {
  LIMITS,
  normalizeBackground,
  resolveSlideSize,
  type ConversionMode,
  type ConversionOptions,
} from "./options";

/** CSS properties the layout engine models. Anything else is reported. */
const SUPPORTED_CSS_PROPERTIES = new Set([
  "background", "background-color",
  "border", "border-color", "border-style", "border-width", "border-radius",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "bottom", "box-sizing",
  "color",
  "display",
  "flex", "flex-basis", "flex-direction", "flex-grow", "flex-shrink", "flex-wrap",
  "font", "font-family", "font-size", "font-style", "font-weight",
  "gap",
  "height",
  "left",
  "letter-spacing", "line-height", "list-style-type",
  "margin", "margin-bottom", "margin-left", "margin-right", "margin-top",
  "max-height", "max-width", "min-height", "min-width",
  "opacity", "order", "overflow",
  "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
  "position",
  "right", "row-gap", "column-gap",
  "text-align", "text-decoration", "text-decoration-color", "text-decoration-line",
  "text-indent", "text-transform",
  "top",
  "vertical-align",
  "visibility", "white-space",
  "width",
  "z-index",
  "align-items", "align-self", "justify-content",
]);

/**
 * CSS properties that are deliberately out of scope (PRD section 12).
 *
 * Listed explicitly so the warning names the exact property the author wrote,
 * rather than a generic "unsupported".
 */
const KNOWN_UNSUPPORTED_PROPERTIES = new Set([
  "filter", "backdrop-filter", "animation", "animation-name", "animation-duration",
  "transition", "transition-property", "transition-duration",
  "transform", "transform-origin",
  "clip-path", "mix-blend-mode", "box-shadow", "text-shadow",
  "float", "object-fit", "object-position",
  "grid-template-columns", "grid-template-rows", "grid-gap", "grid-area",
  "grid-auto-flow", "grid-auto-columns", "grid-auto-rows",
  "box-shadow", "outline", "cursor", "pointer-events",
]);

/** Deps for {@link convertHtmlToPresentation}. */
export interface ConvertDeps {
  /** Pre-resolved assets keyed by their reference in the HTML. */
  assets?: Record<string, ResolvedAsset>;
  /** Injected fetch, for tests. */
  fetchImpl?: typeof fetch;
}

/** Result of a conversion. */
export interface ConversionResult {
  presentation: Presentation;
  report: ConversionReport;
}

/**
 * Convert HTML into the IR.
 *
 * This is the pure half of the pipeline: no PPTX bytes, no filesystem. It is
 * what golden-file tests assert against, and what `POST /api/v1/preview` uses
 * to report slide and element counts without rendering a file.
 */
export async function convertHtmlToPresentation(
  html: string,
  options: ConversionOptions,
  deps: ConvertDeps = {},
  slideIndexHint = 0,
): Promise<ConversionResult> {
  const started = Date.now();
  const diagnostics: Diagnostic[] = [];

  const source = (html ?? "").slice(0, LIMITS.maxHtmlChars);
  if ((html ?? "").length > LIMITS.maxHtmlChars) {
    diagnostics.push({
      level: "warning",
      stage: "parse",
      message: `HTML truncated to ${LIMITS.maxHtmlChars} characters`,
    });
  }

  // Stage 1: sanitize and parse.
  const { root, css: inlineCss, diagnostics: parseDiagnostics } = parseHtml(source);
  diagnostics.push(
    ...parseDiagnostics.map((d) => ({ ...d, slideIndex: d.slideIndex ?? slideIndexHint })),
  );

  // Stage 2: stylesheet. `<style>` bodies are hoisted during parsing; inline
  // `style` attributes are resolved by the cascade.
  const cssText = [inlineCss, ...collectInlineCssBlocks(root)].filter(Boolean).join("\n");
  const stylesheet = parseStylesheet(cssText, diagnostics);
  reportUnsupportedProperties(
    stylesheet.rules.flatMap((rule) => rule.declarations),
    diagnostics,
  );
  if (cssText.trim() !== "" && stylesheet.rules.length === 0) {
    diagnostics.push({
      level: "warning",
      stage: "css",
      message: "No usable CSS rules were found in the supplied stylesheet",
    });
  }

  // Stage 3: geometry.
  const size = resolveSlideSize(options);
  const slideWidthPx = round(inchToPx(size.widthInch));
  const slideHeightPx = round(inchToPx(size.heightInch));
  const viewport = { widthPx: slideWidthPx, heightPx: slideHeightPx };

  const defaultBackground = normalizeBackground(options.background, "#FFFFFF");
  const defaultColor = toHex(options.defaultTextColor) ?? "#1A1A1A";

  // Stage 4: cascade over the whole document, so `data-slide` sections inherit
  // styles declared outside themselves.
  const styles = computeStyleTree(root, stylesheet, viewport);

  // Stage 5: split into slides.
  const sections = findSlideSections(root);
  if (sections.length > LIMITS.maxSlides) {
    diagnostics.push({
      level: "warning",
      stage: "parse",
      message: `Only the first ${LIMITS.maxSlides} sections were converted`,
    });
  }

  const resolver = new AssetResolver({
    assets: deps.assets,
    allowRemote: options.allowRemoteImages,
    maxRemoteBytes: options.maxRemoteImageBytes,
    timeoutMs: options.assetTimeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  const images = new Map<DomElement, ResolvedAsset | null>();
  const overrides = new Map<DomElement, PptxOverrides>();
  const flatten = new Set<DomElement>();
  collectOverrides(root, overrides, flatten);

  const slides: Slide[] = [];
  const slideSources = sections.slice(0, LIMITS.maxSlides);

  for (const [index, section] of slideSources.entries()) {
    const slideBox = layoutSection(section, styles, viewport, slideWidthPx, slideHeightPx, diagnostics, index);
    if (!slideBox) continue;

    await resolveImages(section, resolver, images, diagnostics, index, options.mode);

    const context: MapContext = {
      styles,
      defaultFontFamily: options.defaultFontFamily,
      defaultColor,
      images,
      overrides,
      flatten,
      consumed: new Set(),
      warnings: [],
    };
    const elements = mapSlideElements(slideBox, context);
    for (const warning of context.warnings) {
      diagnostics.push({
        level: "warning",
        stage: "mapping",
        slideIndex: index,
        message: warning.message,
        property: warning.property,
        element: warning.element,
      });
    }

    slides.push({
      background: readSlideBackground(section, defaultBackground),
      elements,
      sourceIndex: index,
    });
  }

  if (slides.length === 0) {
    diagnostics.push({
      level: "warning",
      stage: "parse",
      message: "No slides could be produced from the input",
    });
    slides.push({ background: defaultBackground, elements: [], sourceIndex: 0 });
  }

  const presentation: Presentation = {
    widthPx: slideWidthPx,
    heightPx: slideHeightPx,
    defaultFontFamily: options.defaultFontFamily,
    defaultColor,
    defaultBackground,
    slides,
  };

  return {
    presentation,
    report: {
      stats: buildStats(presentation),
      diagnostics,
      durationMs: Date.now() - started,
    },
  };
}

/**
 * Lay out one slide section.
 *
 * The section is laid out against the slide's own width so percentages and
 * `vw` units resolve against the slide, not against the surrounding document.
 */
function layoutSection(
  section: DomElement,
  styles: Map<DomElement, ComputedStyle>,
  viewport: { widthPx: number; heightPx: number },
  slideWidthPx: number,
  slideHeightPx: number,
  diagnostics: Diagnostic[],
  slideIndex: number,
): LayoutBox | null {
  const style = styles.get(section);
  if (!style) return null;

  const slideDiagnostics: Diagnostic[] = [];
  const box = layoutTree(section, {
    slideWidthPx,
    slideHeightPx,
    styles,
    overrides: buildGeometryOverrides(section),
    diagnostics: slideDiagnostics,
    slideIndex,
  });
  diagnostics.push(...slideDiagnostics);
  return box;
}

/**
 * Read `data-pptx-*` geometry overrides, converting inches to px.
 *
 * `box-sizing` is deliberately ignored here: an author writing
 * `data-pptx-width="4"` means four inches on the slide, not four inches of
 * content inside a padding box.
 */
function buildGeometryOverrides(section: DomElement): Map<DomElement, LayoutOverride> {
  const out = new Map<DomElement, LayoutOverride>();
  const visit = (el: DomElement): void => {
    const overrides = readOverrides(el.attributes);
    if (
      overrides.x !== null || overrides.y !== null ||
      overrides.width !== null || overrides.height !== null
    ) {
      out.set(el, {
        x: overrides.x !== null ? inchToPx(overrides.x) : undefined,
        y: overrides.y !== null ? inchToPx(overrides.y) : undefined,
        width: overrides.width !== null ? inchToPx(overrides.width) : undefined,
        height: overrides.height !== null ? inchToPx(overrides.height) : undefined,
      });
    }
    for (const child of elementChildren(el)) visit(child);
  };
  visit(section);
  return out;
}

/**
 * Resolve every `<img>` inside a slide section.
 *
 * In `pixel` mode images are optional because the slide is rasterised as a
 * whole; in `editable` and `hybrid` modes a missing image is a real loss and is
 * warned about.
 */
async function resolveImages(
  section: DomElement,
  resolver: AssetResolver,
  images: Map<DomElement, ResolvedAsset | null>,
  diagnostics: Diagnostic[],
  slideIndex: number,
  mode: ConversionMode,
): Promise<void> {
  const targets: DomElement[] = [];
  const visit = (el: DomElement): void => {
    if (el.tagName === "img") targets.push(el);
    for (const child of elementChildren(el)) visit(child);
  };
  visit(section);

  for (const el of targets) {
    const src = el.attributes.src ?? "";
    const overrides = readOverrides(el.attributes);
    if (overrides.ignore) {
      images.set(el, null);
      continue;
    }
    const resolution = await resolver.resolve(src, slideIndex);
    images.set(el, resolution.asset);
    if (mode !== "pixel") diagnostics.push(...resolution.diagnostics);
  }
}

/**
 * Find slide sections.
 *
 * `<section data-slide>` is the documented convention. When no element carries
 * `data-slide`, the whole document becomes a single slide, which is what makes
 * a one-line HTML snippet usable.
 */
export function findSlideSections(root: DomElement): DomElement[] {
  const sections: DomElement[] = [];
  const visit = (el: DomElement): void => {
    if (el.attributes["data-slide"] !== undefined) sections.push(el);
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);
  return sections.length > 0 ? sections : [root];
}

/** Read `data-slide-background` / `data-background` on a slide section. */
function readSlideBackground(section: DomElement, fallback: string): string {
  const raw = section.attributes["data-slide-background"] ?? section.attributes["data-background"];
  if (raw === undefined) return fallback;
  return toHex(raw) ?? fallback;
}

/** Collect `data-pptx-*` overrides and mark `data-pptx-as-image` subtrees. */
function collectOverrides(
  root: DomElement,
  overrides: Map<DomElement, PptxOverrides>,
  flatten: Set<DomElement>,
): void {
  const visit = (el: DomElement): void => {
    overrides.set(el, readOverrides(el.attributes));
    if (el.attributes["data-pptx-as-image"] !== undefined) flatten.add(el);
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);
}

/**
 * Read CSS supplied inline on an element's `data-pptx-css` attribute.
 *
 * This exists so a caller can hand over a stylesheet without wrapping it in a
 * `<style>` element, which is convenient for API users who already have the CSS
 * in a separate variable.
 */
function collectInlineCssBlocks(root: DomElement): string[] {
  const blocks: string[] = [];
  const visit = (el: DomElement): void => {
    const css = el.attributes["data-pptx-css"];
    if (css !== undefined && css.trim() !== "") blocks.push(sanitizeCss(css));
    for (const child of elementChildren(el)) visit(child);
  };
  visit(root);
  return blocks;
}

/** Emit a warning for each declaration the engine does not model. */
function reportUnsupportedProperties(
  declarations: Array<{ property: string; value: string }>,
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const property = declaration.property;
    if (SUPPORTED_CSS_PROPERTIES.has(property)) continue;
    if (seen.has(property)) continue;
    seen.add(property);
    diagnostics.push({
      level: "warning",
      stage: "css",
      property,
      message: KNOWN_UNSUPPORTED_PROPERTIES.has(property)
        ? `CSS property "${property}" is not supported and will be ignored`
        : `CSS property "${property}" is not recognised and will be ignored`,
    });
  }
}

/** Aggregate the presentation into the PRD's report statistics. */
export function buildStats(presentation: Presentation): ConversionStats {
  let elements = 0;
  let fallback = 0;
  for (const slide of presentation.slides) {
    elements += slide.elements.length;
    fallback += slide.elements.filter((element) => element.isFallback).length;
  }
  return {
    slides: presentation.slides.length,
    elements,
    converted: elements - fallback,
    fallback,
    warnings: 0,
    errors: 0,
  };
}

/** Attach warning and error counts to a report. */
export function withDiagnosticCounts(
  stats: ConversionStats,
  diagnostics: Diagnostic[],
): ConversionStats {
  return {
    ...stats,
    warnings: diagnostics.filter((d) => d.level === "warning").length,
    errors: diagnostics.filter((d) => d.level === "error").length,
  };
}