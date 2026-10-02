/**
 * Unit conversion between CSS pixels and the units PowerPoint understands.
 *
 * PowerPoint stores geometry in EMU (English Metric Units). pptxgenjs accepts
 * inches for `x`/`y`/`w`/`h`, and points for font sizes. CSS expresses
 * geometry in px and typography in px/pt/em/%.
 *
 * The layout engine works exclusively in CSS pixels. Conversion to inches
 * happens exactly once, at the PPTX boundary (see `pxToInch`).
 */

/** CSS reference pixel: 96 CSS px === 1 inch. */
export const CSS_PX_PER_INCH = 96;

/** PostScript points per inch (72 points in one inch). */
export const POINTS_PER_INCH = 72;

/**
 * Convert CSS pixels to inches.
 *
 * ```ts
 * pxToInch(96); // 1
 * pxToInch(192); // 2
 * ```
 */
export function pxToInch(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return px / CSS_PX_PER_INCH;
}

/** Convert inches to CSS pixels. Inverse of {@link pxToInch}. */
export function inchToPx(inch: number): number {
  if (!Number.isFinite(inch)) return 0;
  return inch * CSS_PX_PER_INCH;
}

/** Convert CSS pixels to PostScript points (font sizes use this unit). */
export function pxToPt(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return (px / CSS_PX_PER_INCH) * POINTS_PER_INCH;
}

/** Convert PostScript points to CSS pixels. */
export function ptToPx(pt: number): number {
  if (!Number.isFinite(pt)) return 0;
  return (pt / POINTS_PER_INCH) * CSS_PX_PER_INCH;
}

/** EMU per inch, the unit PowerPoint itself stores. */
export const EMU_PER_INCH = 914400;

/** Convert CSS pixels to EMU. */
export function pxToEmu(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.round((px / CSS_PX_PER_INCH) * EMU_PER_INCH);
}

/** Round to `digits` decimals, avoiding `-0` and float noise in golden files. */
export function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}