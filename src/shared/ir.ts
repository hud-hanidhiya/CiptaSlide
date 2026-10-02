/**
 * Intermediate Representation (IR) for HTML-to-PPTX conversion.
 *
 * The pipeline is strictly layered:
 *
 * ```
 * HTML -> DOM -> Computed Style -> Layout Boxes -> IR -> PPTX
 * ```
 *
 * Nothing downstream of {@link SlideElement} may look at HTML, CSS or the DOM.
 * That is what makes conversion deterministic and testable: golden files can
 * assert on the IR, and the PPTX writer is a pure function of the IR.
 *
 * All geometry in the IR is CSS pixels, relative to the top-left corner of the
 * slide. Conversion to inches happens once, inside the PPTX writer.
 */

/** Discriminator for what a slide element becomes in PowerPoint. */
export type SlideElementType =
  | "text"
  | "image"
  | "table"
  | "shape"
  | "line";

/** Post-layout geometry, in CSS pixels, relative to the slide's top-left. */
export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in absolute slide coordinates. */
export interface Box extends ElementBox {}

/** Text alignment resolved from `text-align`. */
export type TextAlign = "left" | "center" | "right" | "justify";

/** Vertical alignment of text inside its box. */
export type VerticalAlign = "top" | "middle" | "bottom";

/** Underline / strike-through resolved from `text-decoration-line`. */
export interface TextDecoration {
  underline: boolean;
  strike: boolean;
}

/**
 * Styling that survives the HTML -> CSS -> PPTX round trip.
 *
 * Every field is already resolved: there is no cascade here, only final values.
 */
export interface ElementStyle {
  fontFamily: string;
  /** Font size in CSS pixels. Converted to points at the PPTX boundary. */
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** `#RRGGBB`, or null when the effective colour is inherited/transparent. */
  color: string | null;
  /** `#RRGGBB` fill for shapes and table cells. */
  background: string | null;
  textAlign: TextAlign;
  verticalAlign: VerticalAlign;
  /** Multiplier of font size, e.g. `1.5` for `line-height: 150%`. */
  lineHeight: number;
  /** Shape border as PPTX line options, or null when there is no border. */
  border: BorderStyle | null;
  /** Corner radius in CSS pixels. */
  borderRadiusPx: number;
  /** Bullet character for list items; null for non-list text. */
  bullet: string | null;
  /** 1-based list position, used to number `ol` items. */
  listIndex: number | null;
  /** Indentation level for nested lists, 0-based. */
  listLevel: number;
  /** Rotation in degrees, 0 when the element is upright. */
  rotate: number;
  /** Opacity 0..1. */
  opacity: number;
  /** Text hyperlink target when the element came from an `<a href>`. */
  hyperlink: string | null;
}

/** Border description using CSS-like keywords. */
export interface BorderStyle {
  color: string;
  /** Width in CSS pixels. */
  widthPx: number;
  style: "solid" | "dashed" | "dotted" | "none";
}

/** One styled run of text inside a paragraph. */
export interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
  /** `#RRGGBB` highlight behind the run, or null. */
  highlight: string | null;
  /** Font size override in CSS pixels, or null to inherit the paragraph size. */
  fontSizePx: number | null;
  fontFamily: string | null;
  /** Hyperlink target for this run. */
  hyperlink: string | null;
}

/** A paragraph: one visual line-flow unit inside a text element. */
export interface TextParagraph {
  runs: TextRun[];
  align: TextAlign;
  /** Extra spacing above the paragraph, in CSS pixels. */
  spaceBeforePx: number;
  /** Extra spacing below the paragraph, in CSS pixels. */
  spaceAfterPx: number;
  bullet: string | null;
  listLevel: number;
  listIndex: number | null;
}

/** Text element payload: paragraphs with styled runs. */
export interface TextContent {
  paragraphs: TextParagraph[];
}

/** One table cell. Merged cells repeat their span count on every covered slot. */
export interface TableCell {
  text: string;
  color: string | null;
  background: string | null;
  bold: boolean;
  align: TextAlign;
  /** Number of grid columns this cell spans. */
  colSpan: number;
  /** Number of grid rows this cell spans. */
  rowSpan: number;
}

/** Table element payload. `rows[r][c]` is the cell at grid row r, column c. */
export interface TableContent {
  rows: TableCell[][];
  /** Column widths in CSS pixels, one per grid column. */
  colWidthsPx: number[];
  /** Row heights in CSS pixels, one per grid row. */
  rowHeightsPx: number[];
  /** Border colour, or null for a borderless table. */
  borderColor: string | null;
  borderWidthPx: number;
  /** True when the source `<table>` carried a `<thead>`; boldens row 0. */
  hasHeaderRow: boolean;
  /** True when the source `<table>` carried a `<tfoot>`. */
  hasFooterRow: boolean;
}

/** Image element payload. */
export interface ImageContent {
  /**
   * Fully resolved image bytes as a data URI. Resolution happens during asset
   * fetching, so the PPTX writer never performs I/O.
   */
  dataUri: string;
  /** Intrinsic size in CSS pixels, used for aspect-ratio corrections. */
  naturalWidthPx: number;
  naturalHeightPx: number;
  /** Alternative text for accessibility, or null. */
  alt: string | null;
  /** How the image fills its box when aspect ratios differ. */
  fit: "contain" | "cover" | "fill";
}

/** Shape element payload. */
export interface ShapeContent {
  /** pptxgenjs preset shape name, e.g. `rect`, `roundRect`, `ellipse`. */
  preset: string;
  /** Path points for `line` shapes, in relative box coordinates. */
  points?: Array<{ x: number; y: number }>;
}

/** A single element on a slide. */
export interface SlideElement {
  id: string;
  type: SlideElementType;
  box: ElementBox;
  style: ElementStyle;
  /** Tag name the element came from, for debugging and reports. */
  sourceTag: string;
  /** True when this element replaced an unsupported subtree. */
  isFallback: boolean;
  content?: TextContent | ImageContent | TableContent | ShapeContent;
}

/** One slide in the IR. */
export interface Slide {
  /** `#RRGGBB` background, or null to inherit the presentation default. */
  background: string | null;
  elements: SlideElement[];
  /** Source index of the `<section data-slide>` that produced this slide. */
  sourceIndex: number;
}

/** A whole presentation in the IR. */
export interface Presentation {
  /** Slide width in CSS pixels. */
  widthPx: number;
  /** Slide height in CSS pixels. */
  heightPx: number;
  /** Default font family applied when CSS does not specify one. */
  defaultFontFamily: string;
  /** Default body text colour. */
  defaultColor: string;
  /** Default slide background. */
  defaultBackground: string;
  slides: Slide[];
}

/** Severity of a conversion diagnostic. */
export type DiagnosticLevel = "info" | "warning" | "error";

/** Where a diagnostic came from, for grouping in the UI. */
export type DiagnosticStage =
  | "sanitize"
  | "parse"
  | "css"
  | "layout"
  | "assets"
  | "mapping"
  | "render";

/** A single conversion diagnostic. */
export interface Diagnostic {
  level: DiagnosticLevel;
  stage: DiagnosticStage;
  message: string;
  /** CSS property or HTML tag involved, when applicable. */
  property?: string;
  element?: string;
  /** 0-based slide index, when the diagnostic is slide-scoped. */
  slideIndex?: number;
}

/** Aggregate conversion statistics, mirroring the PRD's report block. */
export interface ConversionStats {
  slides: number;
  elements: number;
  /** Elements rendered as native PPTX objects. */
  converted: number;
  /** Elements that fell back to a raster or placeholder image. */
  fallback: number;
  warnings: number;
  errors: number;
}

/** Result of a full HTML -> PPTX conversion. */
export interface ConversionReport {
  stats: ConversionStats;
  diagnostics: Diagnostic[];
  /** Wall-clock duration of the conversion, in milliseconds. */
  durationMs: number;
}