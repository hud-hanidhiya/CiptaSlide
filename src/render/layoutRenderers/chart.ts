import type { ChartBlock } from "../../schema/deck.schema";
import { RenderError } from "../../errors";
import type { RenderArea, SlideRenderContext } from "./titleBullets";

/**
 * Renderer ChartBlock. Guardrail output integrity (docs/00-guardrails.md):
 * - pie/doughnut dengan nilai negatif → throw RenderError (sudah tertahan Zod, ini guard kedua fail-loud)
 * - values kosong / semua nol → placeholder eksplisit, bukan chart kosong membingungkan
 */
export function renderChart(ctx: SlideRenderContext, block: ChartBlock, area: RenderArea): void {
  const allZeroOrEmpty =
    block.series.length === 0 ||
    block.series.every((s) => s.values.length === 0 || s.values.every((v) => v === 0));

  if (allZeroOrEmpty) {
    ctx.slide.addText(`[Data belum tersedia untuk chart "${block.title}"]`, {
      x: area.x,
      y: area.y + area.h / 2 - 0.3,
      w: area.w,
      h: 0.6,
      align: "center",
      italic: true,
      fontSize: 12,
      color: ctx.palette.text,
    });
    return;
  }

  if (
    (block.chartType === "pie" || block.chartType === "doughnut") &&
    block.series.some((s) => s.values.some((v) => v < 0))
  ) {
    throw new RenderError(
      `Chart '${block.title}' bertipe ${block.chartType} punya nilai negatif — harusnya sudah ditolak validasi schema sebelum render.`
    );
  }

  ctx.slide.addChart(
    block.chartType,
    block.series.map((s) => ({ name: s.name, labels: [...block.categories], values: [...s.values] })),
    {
      x: area.x,
      y: area.y,
      w: area.w,
      h: area.h,
      showLegend:
        block.chartType === "pie" || block.chartType === "doughnut" || block.series.length > 1,
      legendPos: "b",
      chartColors: [ctx.palette.primary, ctx.palette.secondary],
    }
  );
}
