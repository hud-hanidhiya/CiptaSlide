# Task Plan — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

| # | Task | Target file (path eksplisit) | Done criteria | Status |
|---|---|---|---|:---:|
| 1 | Init project, deps (termasuk `express`, tanpa `commander`), tsconfig | `package.json`, `tsconfig.json` | `npm install` sukses, `tsc --noEmit` tanpa error | ☐ |
| 2 | Setup `.env.example` + `.gitignore` (exclude `.env`) | `.env.example`, `.gitignore` | `.env` tidak ter-track git; `.env.example` berisi placeholder `API_BASE_URL`/`API_KEY`/`MODEL_NAME`/`PORT` | ☐ |
| 3 | Definisikan Zod schema `Deck`/`Slide`/`Block` | `src/schema/deck.schema.ts` | Type-check pass; `Deck` type ter-export via `z.infer` | ☐ |
| 4 | Unit test schema: valid, field wajib hilang, chart pie nilai negatif ditolak | `tests/schema.test.ts` | Semua test case lulus | ☐ |
| 5 | `loadLlmConfig()` — load & validasi env, fail-fast kalau kosong; `HOST` eksplisit `127.0.0.1` | `src/config.ts` | Unit test: env lengkap → config; env kosong → throw jelas | ☐ |
| 6 | Wrapper OpenAI-compatible client + `generateDeckJson()` | `src/llm/client.ts` | Type-check pass, signature sesuai `04a` §2 | ☐ |
| 7 | System/user/revisi/repair prompt builder | `src/llm/promptBuilder.ts` | Unit test: prompt mengandung constraint kunci (no `•` literal, max 6 blocks, JSON-only); prompt revisi menyertakan `Deck` lama + instruksi | ☐ |
| 8 | `planDeck()` — retry/repair loop max 3x + custom error class | `src/planner/contentPlanner.ts` | Unit test (mocked LLM): valid langsung, repair sukses attempt-2, gagal 3x → throw | ☐ |
| 9 | `reviseDeck()` — revisi berbasis `Deck` lama + instruksi, pakai repair-loop yang sama | `src/planner/contentPlanner.ts` | Unit test (mocked LLM): revisi menghasilkan `Deck` berbeda dari input, tetap lolos repair-loop max 3x | ☐ |
| 10 | Renderer `titleBullets` (dipakai juga untuk title/sectionDivider/closing) | `src/render/layoutRenderers/titleBullets.ts` | Manual render test: title+bullet tampil benar | ☐ |
| 11 | Renderer `twoColumn` (dipakai sementara untuk imageText) | `src/render/layoutRenderers/twoColumn.ts` | Manual render test: 2 kolom tidak overlap | ☐ |
| 12 | Renderer `chart` — guard nilai negatif pada pie/doughnut sebelum `addChart()` | `src/render/layoutRenderers/chart.ts` | Unit test: values negatif pada pie → throw sebelum render | ☐ |
| 13 | Lookup table layout + `renderDeck()`, `LAYOUT_WIDE` sebelum `addSlide()` pertama, nama file unik per giliran | `src/render/pptxRenderer.ts` | Static check: semua 7 layout type punya renderer terdaftar | ☐ |
| 14 | `validatePptxStructure()` — validasi struktur ZIP/XML dasar | `src/qa/validator.ts` | Fixture test: file valid → `[]`; file dirusak → error terdeteksi | ☐ |
| 15 | `sessionStore.ts` — in-memory `Map<sessionId, SessionState>`, `getOrCreate`/`update` | `src/server/sessionStore.ts` | Unit test: sesi baru → state kosong; update → state ter-patch benar | ☐ |
| 16 | Route `POST /api/chat` — orkestrasi planner→renderer→validator per giliran (initial vs revisi) | `src/server/routes/chat.ts` | Integration test (mocked LLM): giliran initial & revisi sama-sama hasilkan `downloadUrl` | ☐ |
| 17 | Setup Express app — static `public/` & `output/`, mount route, `listen(PORT, "127.0.0.1")` | `src/server/app.ts` | Manual check: server jalan, tidak bisa diakses dari luar localhost | ☐ |
| 18 | Frontend chat — markup, styling, dan JS (fetch, render bubble, link download, disable input saat loading) | `public/index.html`, `public/styles.css`, `public/chat.js` | Manual check di browser: kirim brief → balasan + link muncul; kirim revisi → balasan baru muncul tanpa hilangkan riwayat | ☐ |
| 19 | Custom error class (`LlmTransientError`, `LlmSchemaError`, `UserInputError`, `SessionNotFoundError`) dipakai konsisten, dipetakan ke HTTP status di route | `src/server/routes/chat.ts`, `src/planner/contentPlanner.ts` | Unit test: tiap error class → HTTP status dan pesan JSON berbeda dan jelas | ☐ |
| 20 | Logging minimal per-stage (attempt count, durasi, sessionId) | `src/server/routes/chat.ts` | Manual check: log per stage terbaca jelas di terminal server | ☐ |
| 21 | Manual smoke test end-to-end lewat browser dengan API key asli: brief awal + minimal satu revisi | N/A (manual) | File `.pptx` dari brief nyata dan hasil revisi sama-sama terbuka tanpa "repair needed" di PowerPoint/LibreOffice | ☐ |
| 22 | README dasar (cara jalankan server lokal) + `.env.example` final | `README.md`, `.env.example` | Proyek bisa di-setup ulang dari nol di mesin lain hanya dari README | ☐ |
