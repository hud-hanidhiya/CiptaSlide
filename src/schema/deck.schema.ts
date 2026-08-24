import { z } from "zod";

export const LAYOUT_TYPES = [
  "title",
  "titleBullets",
  "twoColumn",
  "chartFocus",
  "imageText",
  "sectionDivider",
  "closing",
] as const;

export const LayoutTypeSchema = z.enum(LAYOUT_TYPES);
export type LayoutType = z.infer<typeof LayoutTypeSchema>;

export const CHART_TYPES = ["bar", "line", "pie", "doughnut"] as const;
export const ChartTypeSchema = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartTypeSchema>;

const HexColorSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{6}$/, "harus hex 6 digit tanpa '#', mis. 1A2B3C");

export const PaletteSchema = z.object({
  primary: HexColorSchema,
  secondary: HexColorSchema,
  background: HexColorSchema.default("FFFFFF"),
  text: HexColorSchema.default("1A1A1A"),
});
export type Palette = z.infer<typeof PaletteSchema>;

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  content: z.string().min(1).max(2000),
  bullet: z.boolean(),
  bold: z.boolean(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const ChartSeriesSchema = z.object({
  name: z.string().min(1).max(200),
  values: z.array(z.number().finite()).min(1),
});
export type ChartSeries = z.infer<typeof ChartSeriesSchema>;

/**
 * Catatan: cross-field check chart (panjang series vs categories, larangan nilai negatif
 * pada pie/doughnut) dijalankan di level DeckSchema — discriminated union Zod v3 hanya
 * menerima ZodObject polos sebagai opsi.
 */
export const ChartBlockSchema = z.object({
  type: z.literal("chart"),
  chartType: ChartTypeSchema,
  title: z.string().min(1).max(300),
  categories: z.array(z.string().min(1)).min(1),
  series: z.array(ChartSeriesSchema).min(1),
});
export type ChartBlock = z.infer<typeof ChartBlockSchema>;

export const ImageBlockSchema = z.object({
  type: z.literal("image"),
  description: z.string().min(1).max(1000),
  altPosition: z.enum(["left", "right", "full"]),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const BlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ChartBlockSchema,
  ImageBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;

export const SlideSchema = z.object({
  layout: LayoutTypeSchema,
  title: z.string().max(300),
  subtitle: z.string().max(600).optional(),
  blocks: z.array(BlockSchema),
  speakerNotes: z.string().max(4000).optional(),
});
export type Slide = z.infer<typeof SlideSchema>;

export const MAX_SLIDES = 30;

export const DeckMetaSchema = z.object({
  title: z.string().min(1).max(300),
  author: z.string().max(200).optional(),
  palette: PaletteSchema,
});
export type DeckMeta = z.infer<typeof DeckMetaSchema>;

export const DeckSchema = z
  .object({
    meta: DeckMetaSchema,
    slides: z.array(SlideSchema).min(1).max(MAX_SLIDES),
  })
  .superRefine((deck, ctx) => {
    if (deck.slides[0]?.layout !== "title") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "slide pertama wajib layout 'title'",
        path: ["slides", 0, "layout"],
      });
    }

    for (let sIdx = 0; sIdx < deck.slides.length; sIdx++) {
      const slide = deck.slides[sIdx]!;
      for (let bIdx = 0; bIdx < slide.blocks.length; bIdx++) {
        const block = slide.blocks[bIdx]!;
        if (block.type !== "chart") continue;
        const basePath: (string | number)[] = ["slides", sIdx, "blocks", bIdx];

        for (const series of block.series) {
          if (series.values.length !== block.categories.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `chart "${block.title}": series "${series.name}" punya ${series.values.length} nilai tapi ada ${block.categories.length} kategori`,
              path: [...basePath, "series"],
            });
          }
        }

        // Guardrail output integrity (docs/00-guardrails.md): pie/doughnut bernilai negatif
        // menyesatkan meski file-nya "valid" — ditolak di validasi, bukan dirender apa adanya.
        if (
          (block.chartType === "pie" || block.chartType === "doughnut") &&
          block.series.some((s) => s.values.some((v) => v < 0))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `chart "${block.title}" bertipe ${block.chartType} tidak boleh punya nilai negatif`,
            path: [...basePath, "series"],
          });
        }
      }
    }
  });
export type Deck = z.infer<typeof DeckSchema>;
