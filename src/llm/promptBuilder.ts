import type { Deck } from "../schema/deck.schema";
import { MAX_SLIDES } from "../schema/deck.schema";

/**
 * Semua prompt di satu tempat. Kontrak output LLM = JSON `Deck` sesuai schema Zod
 * (src/schema/deck.schema.ts) — LLM tidak pernah menyentuh XML/OOXML.
 */

export const SYSTEM_PROMPT = [
  "Kamu adalah content planner untuk generator presentasi. Tugasmu SATU: menghasilkan JSON 'Deck' yang valid.",
  "",
  "Aturan output (WAJIB):",
  "- Balas HANYA satu objek JSON tanpa teks lain, tanpa markdown fence, tanpa penjelasan.",
  "- JSON harus cocok dengan schema Deck di bawah.",
  `- Maksimal ${MAX_SLIDES} slide; minimal 1 slide.`,
  "- Slide pertama wajib layout 'title'.",
  "- Layout yang tersedia: title, titleBullets, twoColumn, chartFocus, imageText, sectionDivider, closing.",
  "- Palette: field primary/secondary/background/text, hex 6 digit TANPA karakter '#', mis. \"1A2B3C\".",
  "- Block bertipe 'text': { type, content (1-2000 char), bullet (bool), bold (bool) }.",
  "- Block bertipe 'chart': { type, chartType ('bar'|'line'|'pie'|'doughnut'), title, categories (string[], min 1), series ({ name, values: number[] }[], min 1).",
  "  * Panjang setiap series.values HARUS sama dengan panjang categories.",
  "  * chartType pie/doughnut DILARANG punya nilai negatif — kalau datanya negatif, ubah jadi 'bar' atau ubah framing datanya.",
  "- Block bertipe 'image': { type, description (1-1000 char), altPosition ('left'|'right'|'full') } — deskripsi gambar saja, bukan file gambar.",
  "- Bahasa isi deck mengikuti bahasa brief user.",
  "",
  "Schema Deck:",
  "{",
  '  "meta": { "title": string, "author"?: string, "palette": { "primary": hex6, "secondary": hex6, "background": hex6 default FFFFFF, "text": hex6 default 1A1A1A } },',
  '  "slides": [ { "layout": LayoutType, "title": string (<=300), "subtitle"?: string, "blocks": Block[], "speakerNotes"?: string } ]',
  "}",
].join("\n");

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildUserPrompt(brief: string): string {
  return [
    "Buatkan Deck dari brief berikut. Balas hanya JSON Deck.",
    "",
    "=== BRIEF ===",
    brief,
    "=== AKHIR BRIEF ===",
  ].join("\n");
}

export function buildRevisionPrompt(currentDeck: Deck, instruction: string): string {
  return [
    "Kamu akan menerima Deck JSON saat ini dan instruksi revisi dari operator.",
    "Tugasmu: hasilkan VERSI BARU dari Deck itu dengan revisi diterapkan.",
    "Jangan generate ulang dari nol: pertahankan semua bagian yang tidak disentuh instruksi",
    "(judul slide, urutan, palette, isi block) persis seperti aslinya kecuali yang diminta diubah.",
    "Balas hanya JSON Deck hasil revisi, tanpa teks lain.",
    "",
    `Deck saat ini memiliki ${currentDeck.slides.length} slide (indeks 1-${currentDeck.slides.length}).`,
    "Jika instruksi menyebut nomor slide di luar rentang itu, adaptasi ke slide terdekat yang relevan.",
    "",
    "=== DECK SAAT INI ===",
    JSON.stringify(currentDeck),
    "=== AKHIR DECK ===",
    "",
    "=== INSTRUKSI REVISI ===",
    instruction,
    "=== AKHIR INSTRUKSI ===",
  ].join("\n");
}

export function buildRepairPrompt(rawInvalidJson: string, zodErrors: string[]): string {
  return [
    "JSON Deck sebelumnya GAGAL validasi schema. Perbaiki dan balas hanya JSON lengkap yang sudah benar.",
    "Jangan ubah bagian yang tidak ditandai error.",
    "",
    "=== DAFTAR ERROR VALIDASI ===",
    ...zodErrors.map((e, i) => `${i + 1}. ${e}`),
    "=== AKHIR ERROR ===",
    "",
    "=== JSON SEBELUMNYA (INVALID) ===",
    rawInvalidJson,
    "=== AKHIR JSON ===",
  ].join("\n");
}
