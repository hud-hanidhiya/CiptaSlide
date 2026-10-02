/**
 * Conversion options: everything a caller can tune for one HTML -> PPTX run.
 *
 * These map one-to-one onto the controls in the UI (PRD section 9) and the API
 * body (PRD section 30). Defaults match a 16:9 deck at 13.333in x 7.5in.
 */

/** Slide aspect ratio presets. */
export type SlideFormat = "16:9" | "4:3" | "custom";

/** Fidelity strategy (PRD section 21). */
export type ConversionMode = "editable" | "pixel" | "hybrid";

/** A custom slide size, in inches. */
export interface CustomSlideSize {
  widthInch: number;
  heightInch: number;
}

/** Full option set for a conversion. */
export interface ConversionOptions {
  /** Aspect ratio preset, or `custom` to use `customSize`. */
  format: SlideFormat;
  /** Used only when `format` is `custom`. */
  customSize?: CustomSlideSize;
  /** Default slide background as any CSS colour. */
  background: string;
  /** Default font family when CSS does not specify one. */
  defaultFontFamily: string;
  /** Default body text colour. */
  defaultTextColor: string;
  /** Fidelity strategy. */
  mode: ConversionMode;
  /** Allow outbound HTTP requests for `<img src>`. Off by default (SSRF risk). */
  allowRemoteImages: boolean;
  /** Maximum size of a downloaded image, in bytes. */
  maxRemoteImageBytes: number;
  /** Network timeout for image downloads, in ms. */
  assetTimeoutMs: number;
  /** Document title written into PPTX metadata. */
  title: string;
  /** Document author written into PPTX metadata. */
  author: string;
}

import { toHex } from "../shared/color";

/** Preset dimensions in inches. */
export const FORMAT_SIZES: Record<Exclude<SlideFormat, "custom">, CustomSlideSize> = {
  "16:9": { widthInch: 13.333, heightInch: 7.5 },
  "4:3": { widthInch: 10, heightInch: 7.5 },
};

/** Hard limits that protect the server from pathological input. */
export const LIMITS = {
  maxHtmlChars: 500_000,
  maxSlides: 200,
  minSlideInch: 1,
  maxSlideInch: 100,
  maxRemoteImageBytes: 5 * 1024 * 1024,
  assetTimeoutMs: 5000,
} as const;

/** Defaults matching the PRD's configuration panel. */
export function defaultOptions(): ConversionOptions {
  return {
    format: "16:9",
    background: "#FFFFFF",
    defaultFontFamily: "Arial",
    defaultTextColor: "#1A1A1A",
    mode: "editable",
    allowRemoteImages: false,
    maxRemoteImageBytes: LIMITS.maxRemoteImageBytes,
    assetTimeoutMs: LIMITS.assetTimeoutMs,
    title: "Presentasi",
    author: "CiptaSlide",
  };
}

/** Resolve the effective slide size in inches, clamping to sane bounds. */
export function resolveSlideSize(options: ConversionOptions): CustomSlideSize {
  const size =
    options.format === "custom" && options.customSize
      ? options.customSize
      : FORMAT_SIZES[options.format === "custom" ? "16:9" : options.format];

  return {
    widthInch: clamp(size.widthInch, LIMITS.minSlideInch, LIMITS.maxSlideInch),
    heightInch: clamp(size.heightInch, LIMITS.minSlideInch, LIMITS.maxSlideInch),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Convert a CSS colour to `#RRGGBB`, falling back when unparseable.
 *
 * Short hex is expanded (`#eef` -> `#EEFFFF`) because PowerPoint only accepts
 * six-digit RGB; a three-digit value would silently render black.
 */
export function normalizeBackground(value: string, fallback: string): string {
  const parsed = toHex(value);
  return parsed ? parsed.toUpperCase() : fallback;
}