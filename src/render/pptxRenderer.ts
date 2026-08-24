import PptxGenJS from "pptxgenjs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Deck } from "../schema/deck.schema";
import { RenderError } from "../errors";
import type { SlideRenderContext } from "./layoutRenderers/titleBullets";
import { addTitle, renderTextBlocks, titleBulletsRenderer } from "./layoutRenderers/titleBullets";
import { renderChart } from "./layoutRenderers/chart";
import { imageTextRenderer, twoColumnRenderer } from "./layoutRenderers/twoColumn";
import { LAYOUT_TYPES, type LayoutType } from "../schema/deck.schema";

type LayoutRendererFn = (ctx: SlideRenderContext) => void;

function titleRenderer(ctx: SlideRenderContext): void {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  ctx.slide.background = { color: ctx.palette.primary };
  ctx.slide.addText(slideModel.title, {
    x: 0.8, y: 2.4, w: 8.4, h: 1.4,
    fontSize: 40, bold: true, color: ctx.palette.background, align: "center", valign: "middle",
  });
  if (slideModel.subtitle) {
    ctx.slide.addText(slideModel.subtitle, {
      x: 0.8, y: 3.8, w: 8.4, h: 0.7,
      fontSize: 18, color: ctx.palette.secondary, align: "center", valign: "top",
    });
  }
}

function sectionDividerRenderer(ctx: SlideRenderContext): void {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  ctx.slide.background = { color: ctx.palette.secondary };
  ctx.slide.addText(slideModel.title, {
    x: 0.8, y: 2.7, w: 8.4, h: 1.2,
    fontSize: 32, bold: true, color: ctx.palette.background, align: "left", valign: "middle",
  });
  if (slideModel.subtitle) {
    ctx.slide.addText(slideModel.subtitle, {
      x: 0.85, y: 3.9, w: 8.3, h: 0.6, fontSize: 15, color: ctx.palette.background, align: "left",
    });
  }
}

function closingRenderer(ctx: SlideRenderContext): void {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  ctx.slide.background = { color: ctx.palette.primary };
  ctx.slide.addText(slideModel.title, {
    x: 0.8, y: 2.5, w: 8.4, h: 1.2,
    fontSize: 36, bold: true, color: ctx.palette.background, align: "center", valign: "middle",
  });
  const closingText =
    slideModel.subtitle ??
    slideModel.blocks
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.content)
      .join("\n");
  if (closingText) {
    ctx.slide.addText(closingText, {
      x: 0.8, y: 3.8, w: 8.4, h: 0.9,
      fontSize: 15, color: ctx.palette.secondary, align: "center", valign: "top",
    });
  }
}

/**
 * Strategy pattern: lookup table layout → renderer.
 * Menambah layout baru = tambah satu entri di sini + satu entri di LAYOUT_TYPES.
 */
const LAYOUT_RENDERERS: Record<LayoutType, LayoutRendererFn> = {
  title: titleRenderer,
  titleBullets: titleBulletsRenderer,
  twoColumn: twoColumnRenderer,
  chartFocus: chartFocusRenderer,
  imageText: imageTextRenderer,
  sectionDivider: sectionDividerRenderer,
  closing: closingRenderer,
};

function chartFocusRenderer(ctx: SlideRenderContext): void {
  const slideModel = ctx.deck.slides[ctx.slideIndex]!;
  addTitle(ctx.slide, slideModel.title, ctx.palette);
  const chart = slideModel.blocks.find((b): b is Extract<typeof b, { type: "chart" }> => b.type === "chart");
  const textBlocks = slideModel.blocks.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
  if (!chart && textBlocks.length === 0) {
    throw new RenderError(
      `Slide 'chartFocus' "${slideModel.title}" tidak punya block chart maupun teks — tidak ada yang bisa dirender.`
    );
  }
  if (chart) {
    renderChart(ctx, chart, { x: 0.6, y: 1.8, w: textBlocks.length > 0 ? 5.6 : 8.8, h: 4.6 });
  }
  if (textBlocks.length > 0) {
    renderTextBlocks(ctx, textBlocks, {
      x: chart ? 6.5 : 0.8,
      y: 1.8,
      w: chart ? 2.9 : 8.4,
      h: 4.6,
    });
  }
}

/** Pastikan tiap LayoutType punya renderer terdaftar saat startup modul — fail loud kalau tidak (guard test checklist). */
export function assertAllLayoutsHaveRenderers(): void {
  for (const layout of LAYOUT_TYPES) {
    if (typeof LAYOUT_RENDERERS[layout] !== "function") {
      throw new RenderError(`Layout '${layout}' tidak punya renderer terdaftar.`);
    }
  }
}

export interface RenderResult {
  absolutePath: string;
}

/**
 * Render Deck tervalidasi → file .pptx di folder output/.
 * WAJIB dipanggil hanya dengan deck yang sudah lolos DeckSchema.safeParse() — pipeline menjamin ini.
 * Satu instance pptxgen per giliran render (jangan reuse lintas request).
 */
export async function renderDeck(deck: Deck, outPath: string): Promise<RenderResult> {
  if (!deck || deck.slides.length === 0) {
    throw new RenderError("renderDeck dipanggil dengan deck kosong — pipeline seharusnya mencegah ini.");
  }

  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE"; // wajib sebelum addSlide pertama
  pres.author = deck.meta.author ?? "CiptaSlide";
  pres.title = deck.meta.title;

  const palette = deck.meta.palette;
  const absolutePath = path.resolve(outPath);

  for (let i = 0; i < deck.slides.length; i++) {
    const slideModel = deck.slides[i];
    if (!slideModel) throw new RenderError(`Slide index ${i} hilang secara tak terduga.`);
    const slideShape = pres.addSlide();
    if (slideModel.speakerNotes) {
      slideShape.addNotes(slideModel.speakerNotes);
    }
    const renderer = LAYOUT_RENDERERS[slideModel.layout];
    if (!renderer) {
      // Tidak mungkin lewat Zod, tapi fail loud tetap.
      throw new RenderError(`Layout '${slideModel.layout}' tidak punya renderer terdaftar.`);
    }
    const ctx: SlideRenderContext = { slide: slideShape, deck, palette, slideIndex: i };
    try {
      renderer(ctx);
    } catch (err) {
      if (err instanceof RenderError) throw err;
      throw new RenderError(
        `Gagal merender slide ${i + 1} (layout ${slideModel.layout}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await pres.writeFile({ fileName: absolutePath });
  } catch (err) {
    throw new RenderError(
      `pptxgenjs gagal menulis file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { absolutePath };
}
