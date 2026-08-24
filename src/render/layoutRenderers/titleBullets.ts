import type PptxGenJS from "pptxgenjs";
import type { Deck, Palette, TextBlock } from "../../schema/deck.schema";

/** Tipe konteks render yang dipakai semua layout renderer. */
export type SlideShape = ReturnType<PptxGenJS["addSlide"]>;

export interface SlideRenderContext {
  slide: SlideShape;
  deck: Deck;
  palette: Palette;
  /** Indeks slide yang sedang dirender ke dalam deck (0-based). */
  slideIndex: number;
}

export interface RenderArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function addTitle(
  slide: SlideShape,
  title: string,
  palette: Palette,
  opts?: { y?: number; fontSize?: number; color?: string }
): void {
  slide.addText(title, {
    x: 0.6,
    y: opts?.y ?? 0.4,
    w: 8.8,
    h: 1.2,
    fontSize: opts?.fontSize ?? 30,
    bold: true,
    color: opts?.color ?? palette.text,
    valign: "top",
  });
}

/** Render TextBlock berurutan di dalam area; teks yang melebihi area dipotong (area terbatas, bukan silent data loss — layout memang terbatas). */
export function renderTextBlocks(ctx: SlideRenderContext, blocks: TextBlock[], area: RenderArea): number {
  let y = area.y;
  for (const block of blocks) {
    const estH = Math.min(0.42 * Math.max(1, Math.ceil(block.content.length / 60)) + 0.15, area.y + area.h - y);
    if (estH <= 0.1) break;
    ctx.slide.addText(block.bullet ? `• ${block.content}` : block.content, {
      x: area.x,
      y,
      w: area.w,
      h: estH,
      fontSize: block.bold ? 16 : 13,
      bold: block.bold,
      color: ctx.palette.text,
      valign: "top",
    });
    y += estH;
  }
  return y - area.y;
}

export const titleBulletsRenderer = (ctx: SlideRenderContext): void => {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  addTitle(ctx.slide, slideModel.title, ctx.palette);
  if (slideModel.subtitle) {
    ctx.slide.addText(slideModel.subtitle, {
      x: 0.6, y: 1.35, w: 8.8, h: 0.5, fontSize: 14, color: ctx.palette.secondary, valign: "top",
    });
  }
  const textBlocks = slideModel.blocks.filter((b): b is TextBlock => b.type === "text");
  renderTextBlocks(ctx, textBlocks, { x: 0.8, y: 2.0, w: 8.4, h: 4.6 });
};
