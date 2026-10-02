/**
 * IR -> PPTX writer.
 *
 * This is the only module that talks to pptxgenjs, and it is a pure function of
 * {@link Presentation}: same IR in, same XML out. That property is what lets
 * golden-file tests assert on the IR and still trust the file that ships.
 *
 * The one non-obvious decision is geometry. The layout engine works in CSS
 * pixels; PowerPoint wants inches (or EMU). Conversion happens here, once, in
 * {@link pxToInch}, so there is a single place to audit the unit boundary.
 */

import PptxGenJS from "pptxgenjs";

/**
 * pptxgenjs ships its option types inside a `PptxGenJS` namespace on the default
 * export rather than as named exports, so they are referenced through it.
 */
type ShapeType = PptxGenJS.ShapeType;
type TextProps = PptxGenJS.TextProps;
type TextPropsOptions = PptxGenJS.TextPropsOptions;

import { toHex6 } from "../shared/color";
import type {
  BorderStyle,
  ImageContent,
  Presentation,
  ShapeContent,
  Slide,
  SlideElement,
  TableCell,
  TableContent,
  TextContent,
  TextParagraph,
  TextRun,
} from "../shared/ir";
import { pxToInch, pxToPt } from "../shared/units";

/** The pptxgenjs slide type, re-exported so callers need one import. */
type PptxSlide = ReturnType<PptxGenJS["addSlide"]>;

/** Options for {@link renderPresentationToBuffer}. */
export interface RenderOptions {
  /** Document metadata written into the OOXML core properties. */
  title?: string;
  author?: string;
  subject?: string;
  /** Emit a text placeholder for each slide title. Off by default. */
  speakerNotes?: string[];
}

/** pptxgenjs shape presets we emit. Anything else falls back to a rectangle. */
const SUPPORTED_PRESETS = new Set<string>([
  "rect",
  "roundRect",
  "ellipse",
  "triangle",
  "line",
  "chevron",
  "diamond",
  "parallelogram",
  "pentagon",
  "hexagon",
]);

/** Fallback shape type, kept as a typed constant so the cast happens once. */
const RECTANGLE = "rect" as ShapeType;

/**
 * Render a presentation to PPTX bytes.
 *
 * Returns the raw buffer so the caller decides between writing a file and
 * streaming a response; no filesystem access happens here.
 */
export async function renderPresentationToBuffer(
  presentation: Presentation,
  options: RenderOptions = {},
): Promise<Buffer> {
  const pptx = new PptxGenJS();

  // A custom layout is declared from the IR's own pixel size rather than
  // assuming 16:9. Without this a `format: "custom"` request would render a
  // wide slide whose coordinates came from a different page size, and every
  // element would sit at the wrong absolute position when opened.
  const layoutName = "HTML2PPTX";
  pptx.defineLayout({
    name: layoutName,
    width: pxToInch(presentation.widthPx),
    height: pxToInch(presentation.heightPx),
  });

  // `pptx.layout` must be assigned before the first slide is added.
  pptx.layout = layoutName;
  pptx.defineSlideMaster({
    title: layoutName,
    background: { color: stripHash(presentation.defaultBackground) },
    objects: [],
    // Slide numbers only make sense on a landscape deck; a portrait custom size
    // would put the marker outside the page.
    slideNumber:
      presentation.widthPx >= presentation.heightPx
        ? {
            x: pxToInch(presentation.widthPx) - 0.55,
            y: pxToInch(presentation.heightPx) - 0.35,
            w: 0.5,
            h: 0.3,
            color: "808080",
            fontSize: 10,
          }
        : { x: 0.3, y: 0.3, w: 0.5, h: 0.3, color: "808080", fontSize: 10 },
  });

  if (options.title !== undefined) pptx.title = options.title;
  if (options.author !== undefined) pptx.author = options.author;
  if (options.subject !== undefined) pptx.subject = options.subject;

  for (const [index, slide] of presentation.slides.entries()) {
    renderSlide(pptx, presentation, slide, index, options);
  }

  return pptx.write({ outputType: "nodebuffer" }) as Promise<Buffer>;
}

/** Add one slide and its elements to the deck. */
function renderSlide(
  pptx: PptxGenJS,
  presentation: Presentation,
  slideModel: Slide,
  slideIndex: number,
  options: RenderOptions,
): void {
  const slide = pptx.addSlide({ masterName: "HTML2PPTX" });
  const background = stripHash(slideModel.background ?? presentation.defaultBackground);
  slide.background = { color: background };

  const notes = options.speakerNotes?.[slideIndex];
  if (notes !== undefined && notes !== "") slide.addNotes(notes);

  for (const element of slideModel.elements) {
    try {
      renderElement(slide, element);
    } catch {
      // A single malformed element must not lose the whole slide. The
      // conversion report counts these before rendering; here we simply skip.
      continue;
    }
  }
}

/** Dispatch one IR element onto the slide. */
function renderElement(slide: PptxSlide, element: SlideElement): void {
  switch (element.type) {
    case "text":
      renderText(slide, element);
      return;
    case "image":
      renderImage(slide, element);
      return;
    case "table":
      renderTable(slide, element);
      return;
    case "shape":
      renderShape(slide, element);
      return;
    case "line":
      renderLine(slide, element);
      return;
    default:
      return;
  }
}

/** Geometry in inches, derived from the IR box. */
function inchesOf(element: SlideElement): { x: number; y: number; w: number; h: number } {
  return {
    x: pxToInch(element.box.x),
    y: pxToInch(element.box.y),
    w: pxToInch(Math.max(element.box.width, 0)),
    h: pxToInch(Math.max(element.box.height, 0)),
  };
}

/** Add a text frame with paragraphs, runs, bullets and hyperlinks. */
function renderText(slide: PptxSlide, element: SlideElement): void {
  const content = element.content as TextContent | undefined;
  if (!content || content.paragraphs.length === 0) return;

  const { style } = element;
  const geometry = inchesOf(element);

  const runs: TextProps[] = [];
  for (const paragraph of content.paragraphs) runs.push(...paragraphToPptx(paragraph, style));
  if (runs.length === 0) return;

  slide.addText(runs, {
      x: geometry.x,
      y: geometry.y,
      w: Math.max(geometry.w, 0.01),
      h: Math.max(geometry.h, 0.01),
      // PowerPoint autofits nothing for us, so text is left top-aligned inside
      // the box the layout engine measured.
      valign: style.verticalAlign === "middle" ? "middle" : style.verticalAlign === "bottom" ? "bottom" : "top",
      align: style.textAlign,
      margin: 0,
      wrap: true,
      fontFace: style.fontFamily,
    fontSize: pxToPt(style.fontSizePx),
    bold: style.bold,
    italic: style.italic,
    lineSpacingMultiple: style.lineHeight,
    fill: style.background !== null ? { color: stripHash(style.background) } : undefined,
    line: borderToPptxLine(style.border),
    isTextBox: true,
  });
}

/** Convert one paragraph into pptxgenjs break/run objects. */
function paragraphToPptx(
  paragraph: TextParagraph,
  style: SlideElement["style"],
): TextProps[] {
  const out: TextProps[] = [];

  // A paragraph's bullet belongs on the paragraph properties, not on a
  // synthetic empty run: pptxgenjs only emits `<a:buChar>` when `bullet` is set
  // on the run that actually carries the text.
  //
  // Glyph bullets must omit `type` entirely: pptxgenjs's `type` branch only
  // handles `"number"`, so `type: "bullet"` silently emits no `<a:buChar>` at
  // all. `characterCode` also has to be the 4-digit hex form, not the glyph.
  const bullet =
    paragraph.bullet !== null
      ? ({ characterCode: hexCodePoint(paragraph.bullet) } as const)
      : paragraph.listIndex !== null
        ? ({ type: "number", numberStartAt: paragraph.listIndex } as const)
        : undefined;

  for (const [index, run] of paragraph.runs.entries()) {
    const options = runToPptx(run, style);
    if (index === 0 && bullet !== undefined) {
      options.bullet = bullet;
      options.indentLevel = paragraph.listLevel;
      options.align = paragraph.align;
    }
    out.push({ text: run.text, options });
  }
  return out;
}

/**
 * Convert a bullet glyph to the 4-digit hex code point pptxgenjs expects.
 *
 * pptxgenjs validates `characterCode` against `/^[0-9A-Fa-f]{4}$/` and emits
 * `<a:buChar char="&#xNNNN;"/>`. Passing the glyph itself produces no bullet.
 */
function hexCodePoint(glyph: string): string {
  const code = glyph.codePointAt(0) ?? 0x2022;
  return code.toString(16).toUpperCase().padStart(4, "0");
}

/** Convert one styled run into pptxgenjs run options. */
function runToPptx(run: TextRun, style: SlideElement["style"]): TextPropsOptions {
  const options: TextPropsOptions = {
    bold: run.bold,
    italic: run.italic,
    fontFace: run.fontFamily ?? style.fontFamily,
    fontSize: pxToPt(run.fontSizePx ?? style.fontSizePx),
    color: stripHash(run.color ?? style.color ?? "#000000"),
  };
  if (run.underline) options.underline = { style: "sng" };
  if (run.strike) options.strike = "sngStrike";
  if (run.hyperlink !== null) options.hyperlink = { url: run.hyperlink };
  if (run.highlight !== null) options.highlight = stripHash(run.highlight);
  return options;
}

/** Add an image, fitting it inside the box according to the IR fit mode. */
function renderImage(slide: PptxSlide, element: SlideElement): void {
  const content = element.content as ImageContent | undefined;
  if (!content) return;

  const geometry = inchesOf(element);
  const alt = content.alt ?? undefined;

  const placement = fitPlacement(
    { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h },
    content,
  );

  slide.addImage({
    data: content.dataUri,
    x: placement.x,
    y: placement.y,
    w: placement.w,
    h: placement.h,
    altText: alt,
    rounding: false,
  });
}

/** Compute the drawable rectangle for an image inside its box. */
function fitPlacement(
  box: { x: number; y: number; w: number; h: number },
  content: ImageContent,
): { x: number; y: number; w: number; h: number } {
  if (content.fit === "fill") return box;
  if (content.naturalWidthPx <= 0 || content.naturalHeightPx <= 0) return box;
  if (box.w <= 0 || box.h <= 0) return box;

  const naturalRatio = content.naturalWidthPx / content.naturalHeightPx;
  const boxRatio = box.w / box.h;

  const widthFirst = content.fit === "cover" ? naturalRatio > boxRatio : naturalRatio < boxRatio;
  if (widthFirst) {
    const height = box.w / naturalRatio;
    return { x: box.x, y: box.y + (box.h - height) / 2, w: box.w, h: height };
  }
  const width = box.h * naturalRatio;
  return { x: box.x + (box.w - width) / 2, y: box.y, w: width, h: box.h };
}

/** Add a table, honouring per-cell fills, alignment and spans. */
function renderTable(slide: PptxSlide, element: SlideElement): void {
  const content = element.content as TableContent | undefined;
  if (!content) return;

  const geometry = inchesOf(element);
  const baseFont = element.style.fontFamily;
  const baseFontSize = pxToPt(element.style.fontSizePx);

  const rows = content.rows.map((row, rowIndex) =>
    row.map((cell) => tableCellToPptx(cell, content, baseFont, baseFontSize, rowIndex, content.hasHeaderRow)),
  );

  slide.addTable(rows, {
    x: geometry.x,
    y: geometry.y,
    w: geometry.w,
    h: geometry.h > 0 ? geometry.h : undefined,
    colW: content.colWidthsPx.map((width) => pxToInch(width)),
    rowH: content.rowHeightsPx.map((height) => pxToInch(height)),
    border:
      content.borderColor !== null
        ? { type: "solid", pt: pxToPt(content.borderWidthPx), color: stripHash(content.borderColor) }
        : { type: "none" },
    fill: element.style.background !== null ? { color: stripHash(element.style.background) } : undefined,
    autoPage: false,
  });
}

/** Convert one IR cell into pptxgenjs table cell options. */
function tableCellToPptx(
  cell: TableCell,
  table: TableContent,
  baseFont: string,
  baseFontSize: number,
  rowIndex: number,
  hasHeaderRow: boolean,
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    fontFace: baseFont,
    fontSize: baseFontSize,
    color: stripHash(cell.color ?? "#000000"),
    bold: cell.bold || (hasHeaderRow && rowIndex === 0),
    align: cell.align,
    valign: "middle",
    margin: 4,
  };
  if (cell.background !== null) options.fill = { color: stripHash(cell.background) };
  if (cell.colSpan > 1) options.colspan = cell.colSpan;
  if (cell.rowSpan > 1) options.rowspan = cell.rowSpan;
  void table;
  return { text: cell.text, options };
}

/** Add a rectangle, ellipse or other preset shape. */
function renderShape(slide: PptxSlide, element: SlideElement): void {
  const content = element.content as ShapeContent | undefined;
  if (!content) return;
  const geometry = inchesOf(element);
  const { style } = element;

  slide.addShape(
    shapeTypeOf(content.preset),
    {
      x: geometry.x,
      y: geometry.y,
      w: Math.max(geometry.w, 0.01),
      h: Math.max(geometry.h, 0.01),
      fill: style.background !== null ? { color: stripHash(style.background) } : { type: "none" },
      line: borderToPptxLine(style.border),
      rectRadius: style.borderRadiusPx > 0 ? pxToInch(style.borderRadiusPx) : undefined,
      rotate: style.rotate !== 0 ? style.rotate : undefined,
      shadow: { type: "outer", color: "000000", blur: 0, offset: 0, opacity: 0 },
    },
  );
}

/** Add a straight line across the box width. */
function renderLine(slide: PptxSlide, element: SlideElement): void {
  const geometry = inchesOf(element);
  const border: BorderStyle = element.style.border ?? { color: "#000000", widthPx: 1, style: "solid" };

  slide.addShape("line", {
    x: geometry.x,
    y: geometry.y,
    w: Math.max(geometry.w, 0.01),
    h: 0,
    line: {
      color: stripHash(border.color),
      width: pxToPt(border.widthPx),
      dashType: border.style === "dashed" ? "dash" : border.style === "dotted" ? "sysDot" : "solid",
    },
    flipH: false,
    flipV: false,
  });
}

/** Convert an IR border into pptxgenjs line options. */
function borderToPptxLine(border: BorderStyle | null): Record<string, unknown> | undefined {
  if (!border || border.style === "none" || border.widthPx <= 0) return { type: "none" };
  return {
    color: stripHash(border.color),
    width: pxToPt(border.widthPx),
    dashType: border.style === "dashed" ? "dash" : border.style === "dotted" ? "sysDot" : "solid",
  };
}

/** Map a preset name to a pptxgenjs shape type, defaulting to a rectangle. */
function shapeTypeOf(preset: string): ShapeType {
  return SUPPORTED_PRESETS.has(preset) ? (preset as ShapeType) : RECTANGLE;
}

/** pptxgenjs wants bare hex without a leading `#`. */
function stripHash(color: string | null | undefined): string {
  if (!color) return "000000";
  return color.startsWith("#") ? color.slice(1).toLowerCase() : color.toLowerCase();
}

export { toHex6, pxToInch, pxToPt };