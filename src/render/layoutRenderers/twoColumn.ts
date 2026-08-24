import type { Block, ImageBlock, TextBlock } from "../../schema/deck.schema";import { renderChart } from "./chart";
import { addTitle, renderTextBlocks } from "./titleBullets";
import type { RenderArea, SlideRenderContext } from "./titleBullets";

/** Tidak ada file gambar asli di v1 — deskripsi gambar dirender sebagai placeholder box eksplisit. */
export function renderImagePlaceholder(
  ctx: SlideRenderContext,
  block: ImageBlock,
  area: RenderArea
): void {
  ctx.slide.addShape("roundRect", {
    x: area.x,
    y: area.y,
    w: area.w,
    h: area.h,
    fill: { color: ctx.palette.secondary },
    line: { color: ctx.palette.primary },
  });
  ctx.slide.addText(`[Gambar: ${block.description}]`, {
    x: area.x + 0.15,
    y: area.y + area.h / 2 - 0.5,
    w: Math.max(area.w - 0.3, 0.5),
    h: 1.0,
    align: "center",
    fontSize: 11,
    italic: true,
    color: "FFFFFF",
  });
}

function splitIntoColumns(blocks: Block[], column: 0 | 1): Block[] {
  const halfIndex = Math.ceil(blocks.length / 2);
  return column === 0 ? blocks.slice(0, halfIndex) : blocks.slice(halfIndex);
}

/** Render campuran block (text/chart/image) berurutan secara vertikal di dalam satu kolom. */
export function renderMixedBlocks(ctx: SlideRenderContext, blocks: Block[], area: RenderArea): void {
  let y = area.y;
  for (const block of blocks) {
    const remainingH = area.h - (y - area.y);
    if (remainingH <= 0.5) break;
    const remaining: RenderArea = { x: area.x, y, w: area.w, h: remainingH };
    if (block.type === "text") {
      const estH = Math.min(0.42 * Math.max(1, Math.ceil(block.content.length / 55)) + 0.1, remainingH);
      renderTextBlocks(ctx, [block], { ...remaining, h: estH });
      y += estH;
    } else if (block.type === "chart") {
      const chartH = Math.min(remainingH, 3.2);
      renderChart(ctx, block, { ...remaining, h: chartH });
      y += chartH;
    } else {
      const imgH = Math.min(remainingH, 2.4);
      renderImagePlaceholder(ctx, block, { ...remaining, h: imgH });
      y += imgH;
    }
  }
}

export const twoColumnRenderer = (ctx: SlideRenderContext): void => {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  addTitle(ctx.slide, slideModel.title, ctx.palette);
  const blocks = slideModel.blocks;
  renderMixedBlocks(ctx, splitIntoColumns(blocks, 0), { x: 0.6, y: 1.9, w: 4.1, h: 4.6 });
  renderMixedBlocks(ctx, splitIntoColumns(blocks, 1), { x: 5.3, y: 1.9, w: 4.1, h: 4.6 });
};

/**
 * imageText — reuse pola dua kolom (sesuai docs/04a-implementation-plan.md §3).
 * Placeholder gambar di kiri/kanan sesuai altPosition; teks di kolom sebelahnya.
 */
export const imageTextRenderer = (ctx: SlideRenderContext): void => {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  addTitle(ctx.slide, slideModel.title, ctx.palette);
  const imageBlock = slideModel.blocks.find((b): b is ImageBlock => b.type === "image");
  const textBlocks = slideModel.blocks.filter((b): b is TextBlock => b.type === "text");

  const position = imageBlock?.altPosition ?? "right";
  if (!imageBlock || position === "full") {
    if (imageBlock) renderImagePlaceholder(ctx, imageBlock, { x: 0.6, y: 1.8, w: 8.8, h: 4.4 });
    else renderTextBlocks(ctx, textBlocks, { x: 0.8, y: 1.9, w: 8.4, h: 4.4 });
    return;
  }
  const imgArea: RenderArea =
    position === "left" ? { x: 0.6, y: 1.8, w: 3.8, h: 4.5 } : { x: 5.6, y: 1.8, w: 3.8, h: 4.5 };
  const textArea: RenderArea =
    position === "left" ? { x: 4.7, y: 1.95, w: 4.6, h: 4.3 } : { x: 0.7, y: 1.95, w: 4.6, h: 4.3 };
  renderImagePlaceholder(ctx, imageBlock, imgArea);
  renderTextBlocks(ctx, textBlocks, textArea);
};
