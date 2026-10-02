/**
 * HTTP API for the HTML -> PPTX converter (PRD section 30).
 *
 * ```
 * POST /api/v1/convert    HTML -> .pptx (written to output/)
 * POST /api/v1/preview    HTML -> slide model, no file written
 * POST /api/v1/validate   HTML -> warnings and errors, no file written
 * GET  /api/v1/health     liveness probe
 * ```
 *
 * `validate` and `preview` deliberately share the conversion pipeline with
 * `convert`, so what a user is warned about is exactly what gets rendered.
 */

import fs from "fs/promises";
import path from "path";

import { Router, type Request, type Response } from "express";

import type { ResolvedAsset } from "../../assets/resolver";
import {
  convertHtmlToPresentation,
  withDiagnosticCounts,
  type ConvertDeps,
} from "../../convert/pipeline";
import {
  LIMITS,
  defaultOptions,
  resolveSlideSize,
  type ConversionMode,
  type ConversionOptions,
  type SlideFormat,
} from "../../convert/options";
import { UserInputError } from "../../errors";
import { assertValidPptxStructure } from "../../qa/validator";
import { renderPresentationToBuffer } from "../../render/htmlPptxWriter";
import type { ConversionReport, Diagnostic, Presentation } from "../../shared/ir";
import { toHex } from "../../shared/color";
import { inchToPx, pxToInch, round } from "../../shared/units";

/** Directory rendered files are written to. */
const OUTPUT_DIR = "output";

/** Accepted slide formats. */
const FORMATS: SlideFormat[] = ["16:9", "4:3", "custom"];

/** Accepted conversion modes. */
const MODES: ConversionMode[] = ["editable", "pixel", "hybrid"];

/** Dependencies, injectable for tests. */
export interface HtmlPptxDeps extends ConvertDeps {
  /** Override the pipeline, for tests that do not need real conversion. */
  convertFn?: typeof convertHtmlToPresentation;
  /** Override the writer, for tests that do not need real PPTX bytes. */
  renderFn?: typeof renderPresentationToBuffer;
  /** Override the structure validator. */
  validateFn?: typeof assertValidPptxStructure;
  /** Output directory. Defaults to `output/`. */
  outputDir?: string;
}

interface ConvertRequestBody {
  html?: unknown;
  options?: unknown;
  assets?: unknown;
}

/** Build the router for `/api/v1`. */
export function createHtmlPptxRouter(deps: HtmlPptxDeps = {}): Router {
  const router = Router();
  const convertFn = deps.convertFn ?? convertHtmlToPresentation;
  const renderFn = deps.renderFn ?? renderPresentationToBuffer;
  const validateFn = deps.validateFn ?? assertValidPptxStructure;
  const outputDir = deps.outputDir ?? OUTPUT_DIR;

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "html2pptx",
      maxHtmlChars: LIMITS.maxHtmlChars,
      maxSlides: LIMITS.maxSlides,
    });
  });

  router.post("/validate", async (req: Request, res: Response) => {
    try {
      const { html, options, assets } = parseBody(req);
      const { report } = await runConversion(convertFn, html, options, assets, deps);
      res.json({
        valid: report.stats.errors === 0 && report.stats.slides > 0,
        slides: report.stats.slides,
        elements: report.stats.elements,
        warnings: report.diagnostics.filter((d) => d.level !== "info"),
        stats: report.stats,
        durationMs: report.durationMs,
      });
    } catch (err) {
      respondWithError(res, err);
    }
  });

  router.post("/preview", async (req: Request, res: Response) => {
    try {
      const { html, options, assets } = parseBody(req);
      const { presentation, report } = await runConversion(convertFn, html, options, assets, deps);
      res.json({
        slideWidthPx: presentation.widthPx,
        slideHeightPx: presentation.heightPx,
        slideWidthInch: round(pxToInch(presentation.widthPx), 4),
        slideHeightInch: round(pxToInch(presentation.heightPx), 4),
        slides: presentation.slides.map((slide, index) => ({
          index,
          background: slide.background,
          elements: slide.elements.map((element) => ({
            id: element.id,
            type: element.type,
            sourceTag: element.sourceTag,
            isFallback: element.isFallback,
            box: element.box,
            text: describeText(element),
          })),
        })),
        report: withDiagnosticCounts(report.stats, report.diagnostics),
        diagnostics: report.diagnostics,
      });
    } catch (err) {
      respondWithError(res, err);
    }
  });

  router.post("/convert", async (req: Request, res: Response) => {
    try {
      const { html, options, assets } = parseBody(req);
      const { presentation, report } = await runConversion(convertFn, html, options, assets, deps);

      const buffer = await renderFn(presentation, {
        title: options.title,
        author: options.author,
      });

      const fileName = buildFileName(options.title);
      const target = path.join(outputDir, fileName);
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(target, buffer);

      // Never report a file that did not survive structural validation.
      await validateFn(target);

      console.log(
        `[html2pptx] OK file=${fileName} slides=${presentation.slides.length} ` +
          `elements=${report.stats.elements} warnings=${countBy(report.diagnostics, "warning")} ` +
          `bytes=${buffer.length}`,
      );

      res.json({
        success: true,
        filename: fileName,
        downloadUrl: `/output/${encodeURIComponent(fileName)}`,
        bytes: buffer.length,
        stats: withDiagnosticCounts(report.stats, report.diagnostics),
        diagnostics: report.diagnostics,
        durationMs: report.durationMs,
      });
    } catch (err) {
      respondWithError(res, err);
    }
  });

  return router;
}

/** Run the pipeline with validated inputs. */
async function runConversion(
  convertFn: HtmlPptxDeps["convertFn"] & NonNullable<HtmlPptxDeps["convertFn"]>,
  html: string,
  options: ConversionOptions,
  assets: Record<string, ResolvedAsset>,
  deps: HtmlPptxDeps,
): Promise<{ presentation: Presentation; report: ConversionReport }> {
  void deps;
  const result = await convertFn(html, options, { assets, fetchImpl: deps.fetchImpl });
  result.report.stats = withDiagnosticCounts(result.report.stats, result.report.diagnostics);
  return result;
}

/** Extract and validate the request body. */
function parseBody(req: Request): {
  html: string;
  options: ConversionOptions;
  assets: Record<string, ResolvedAsset>;
} {
  const body = (req.body ?? {}) as ConvertRequestBody;

  const html = typeof body.html === "string" ? body.html : "";
  if (html.trim() === "") {
    throw new UserInputError("Field 'html' wajib diisi.");
  }
  if (html.length > LIMITS.maxHtmlChars) {
    throw new UserInputError(
      `HTML terlalu panjang (${html.length} karakter; maksimal ${LIMITS.maxHtmlChars}).`,
    );
  }

  return {
    html,
    options: parseOptions(body.options),
    assets: parseAssets(body.assets),
  };
}

/**
 * Merge caller options over the defaults, validating every field.
 *
 * Validation is explicit rather than schema-driven so an unknown key produces a
 * clear 400 instead of being silently dropped.
 */
export function parseOptions(input: unknown): ConversionOptions {
  const defaults = defaultOptions();
  if (input === undefined || input === null) return defaults;
  if (typeof input !== "object") {
    throw new UserInputError("Field 'options' harus berupa objek.");
  }

  const raw = input as Record<string, unknown>;
  const options: ConversionOptions = { ...defaults };

  if (raw.format !== undefined) {
    const format = String(raw.format);
    if (!FORMATS.includes(format as SlideFormat)) {
      throw new UserInputError(`Format tidak dikenal: "${format}". Pilihan: ${FORMATS.join(", ")}.`);
    }
    options.format = format as SlideFormat;
  }

  if (raw.mode !== undefined) {
    const mode = String(raw.mode);
    if (!MODES.includes(mode as ConversionMode)) {
      throw new UserInputError(`Mode tidak dikenal: "${mode}". Pilihan: ${MODES.join(", ")}.`);
    }
    options.mode = mode as ConversionMode;
  }

  if (raw.background !== undefined) {
    const background = toHex(String(raw.background));
    if (!background) {
      throw new UserInputError(`Background bukan warna CSS yang valid: "${String(raw.background)}".`);
    }
    options.background = background;
  }

  if (raw.defaultTextColor !== undefined) {
    const color = toHex(String(raw.defaultTextColor));
    if (!color) {
      throw new UserInputError(
        `defaultTextColor bukan warna CSS yang valid: "${String(raw.defaultTextColor)}".`,
      );
    }
    options.defaultTextColor = color;
  }

  if (raw.defaultFontFamily !== undefined) {
    const family = String(raw.defaultFontFamily).trim();
    if (family === "") throw new UserInputError("defaultFontFamily tidak boleh kosong.");
    options.defaultFontFamily = family;
  }

  if (raw.title !== undefined) options.title = String(raw.title).slice(0, 300);
  if (raw.author !== undefined) options.author = String(raw.author).slice(0, 300);

  if (raw.customSize !== undefined) {
    const size = raw.customSize as Record<string, unknown> | undefined;
    const widthInch = Number(size?.widthInch);
    const heightInch = Number(size?.heightInch);
    if (!Number.isFinite(widthInch) || !Number.isFinite(heightInch)) {
      throw new UserInputError("customSize butuh widthInch dan heightInch berupa angka (inci).");
    }
    options.customSize = { widthInch, heightInch };
  }

  if (raw.allowRemoteImages !== undefined) {
    options.allowRemoteImages = raw.allowRemoteImages === true;
  }

  if (raw.maxRemoteImageBytes !== undefined) {
    const bytes = Number(raw.maxRemoteImageBytes);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new UserInputError("maxRemoteImageBytes harus angka positif.");
    }
    options.maxRemoteImageBytes = Math.min(bytes, 25 * 1024 * 1024);
  }

  if (raw.assetTimeoutMs !== undefined) {
    const timeout = Number(raw.assetTimeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new UserInputError("assetTimeoutMs harus angka positif.");
    }
    options.assetTimeoutMs = Math.min(timeout, 60_000);
  }

  return options;
}

/**
 * Parse pre-resolved assets from the request.
 *
 * Accepted shape: `{ "images/logo.png": { "dataUri": "data:image/png;base64,…" } }`.
 * The data URI is trusted only after it passes the same URL safety check the
 * parser applies, so a hostile client cannot smuggle an executable payload in.
 */
function parseAssets(input: unknown): Record<string, ResolvedAsset> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object") throw new UserInputError("Field 'assets' harus berupa objek.");

  const out: Record<string, ResolvedAsset> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const entry = value as { dataUri?: unknown; widthPx?: unknown; heightPx?: unknown };
    if (typeof entry?.dataUri !== "string") continue;
    if (!/^data:image\/(png|jpe?g|gif|webp|bmp)[;,]/i.test(entry.dataUri)) {
      throw new UserInputError(
        `Asset "${key}" harus berupa data URI gambar raster (png/jpeg/gif/webp/bmp).`,
      );
    }
    out[key] = {
      dataUri: entry.dataUri,
      widthPx: Number(entry.widthPx ?? 0) || 0,
      heightPx: Number(entry.heightPx ?? 0) || 0,
      mimeType: /^data:([^;,]+)/i.exec(entry.dataUri)?.[1] ?? "image/png",
    };
  }
  return out;
}

/** Short human-readable text for a text element, used by the preview API. */
function describeText(element: Presentation["slides"][number]["elements"][number]): string {
  const content = element.content as { paragraphs?: Array<{ runs: Array<{ text: string }> }> } | undefined;
  if (!content?.paragraphs) return "";
  return content.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n");
}

/** Build a filesystem-safe download name. */
function buildFileName(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${base || "presentasi"}-${stamp}.pptx`;
}

function countBy(diagnostics: Diagnostic[], level: Diagnostic["level"]): number {
  return diagnostics.filter((diagnostic) => diagnostic.level === level).length;
}

/** Translate pipeline failures into HTTP responses. */
function respondWithError(res: Response, err: unknown): void {
  if (err instanceof UserInputError) {
    res.status(400).json({ error: "input_tidak_valid", message: err.message });
    return;
  }
  console.error(`[html2pptx] Error: ${err instanceof Error ? err.message : String(err)}`);
  res.status(500).json({
    error: "konversi_gagal",
    message: "Konversi HTML menjadi PPTX gagal. Periksa log server untuk detail.",
  });
}

export { resolveSlideSize, inchToPx };