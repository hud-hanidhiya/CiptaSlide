# Task Plan — CiptaSlide (eksekusi Stage 1–6)

Status eksekusi work order dari `05-master-prompt.md`. Semua path relatif ke root repo.

## Keputusan desain yang diambil saat eksekusi

| # | Keputusan | Alasan | Referensi |
|---|---|---|---|
| 1 | Endpoint tambahan `POST /api/sessions` untuk membuat sessionId | Tanpa ini, "sesi baru" vs "sesi mati (server restart)" tidak bisa dibedakan; spec §Error handling menuntut sessionId tak dikenal → HTTP 404, frontend arahkan mulai chat baru | `03-spec.md`, `04a-implementation-plan.md` §5 |
| 2 | Tidak ada TTL sesi di v1 | Sesi hidup selama proses server hidup — jawaban pertanyaan terbuka spec, pilihan paling sederhana untuk tool single-user | `03-spec.md` §Pertanyaan terbuka |
| 3 | Jalankan TS via `tsc` build → `node dist/` (+ `node --watch` untuk dev) | Tanpa menambah dependency baru (`tsx`/`nodemon` tidak masuk daftar stack) | Aturan #5 |
| 4 | Cross-field chart checks di level `DeckSchema.superRefine` | Discriminated union Zod v3 hanya menerima ZodObject polos sebagai opsi (ZodEffects tidak bisa) | — |
| 5 | Error teknis LLM (timeout/429/network) ikut repair-loop dengan batas attempt yang sama (3×) | Spec §Error handling mengizinkan retry otomatis "dalam batas repair-loop"; habis → HTTP 503 | `03-spec.md` |
| 6 | DI opsional di route chat (`store`, `overrides`) supaya integration test bisa mock LLM/validator tanpa monkey-patching | Test checklist docs/04a §5 butuh skenario file corrupt & schema invalid persisten | `04a-implementation-plan.md` §5 |

## File yang dibuat

- Scaffold: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Core: `src/schema/deck.schema.ts`, `src/config.ts`, `src/errors.ts`, `src/llm/client.ts`, `src/llm/promptBuilder.ts`, `src/planner/contentPlanner.ts`
- Render/QA: `src/render/pptxRenderer.ts`, `src/render/layoutRenderers/{titleBullets,twoColumn,chart}.ts`, `src/qa/validator.ts`
- Server: `src/server/app.ts`, `src/server/sessionStore.ts`, `src/server/routes/chat.ts`, `src/server/routes/sessions.ts`
- Frontend: `public/index.html`, `public/chat.js`, `public/styles.css`
- Tests: `tests/schema.test.ts`, `tests/contentPlanner.test.ts`, `tests/renderer.test.ts`, `tests/config.test.ts`, `tests/chatRoute.test.ts`

## Checklist verifikasi docs/04a §5

- [x] `Deck.safeParse()` menolak semua kasus invalid terdaftar (schema.test)
- [x] Repair-loop pulih dari 1x kegagalan — planDeck & reviseDeck (contentPlanner.test)
- [x] Repair-loop throw setelah 3x gagal (schema → LlmSchemaError; teknis → LlmTransientError)
- [x] Setiap LayoutType punya renderer terdaftar + dirender valid (renderer.test, loop semua layout)
- [x] `validatePptxStructure()` mendeteksi file corrupt sengaja-dirusak
- [x] `/api/chat` initial → downloadUrl valid (chatRoute.test, mocked LLM, validator asli)
- [x] `/api/chat` revisi → Deck baru berbeda + file baru di sesi sama
- [x] sessionId tak dikenal → HTTP 404 `session_tidak_dikenal`
- [ ] End-to-end manual: brief → .pptx terbuka mulus di PowerPoint/LibreOffice + 1 revisi — **perlu API key asli operator** (jalankan `npm start`)
- [x] Env var kosong → server gagal start dengan pesan jelas
- [x] Server tidak bisa diakses dari luar 127.0.0.1 (diverifikasi via LAN IP machine saat smoke test)

## Hasil verifikasi otomatis (terakhir dijalankan)

- `npx tsc --noEmit`: lulus tanpa error
- `npm run build`: lulus, entry point `dist/server/app.js`
- `npm test`: **110 test lulus / 0 gagal** (5 file test)
- Smoke test manual: fail-fast env kosong OK; static frontend 200; `/api/sessions` 201; bind 127.0.0.1 terbukti (LAN IP ditolak); LLM mati → HTTP 503 pesan jelas

## Hasil code review (6 track) & perbaikan yang diterapkan

- [fixed] Klasifikasi error LLM: penolakan permanen provider (HTTP 4xx kecuali 408/429, mis. API key salah) kini gagal cepat sebagai `LlmConfigError` → HTTP 400 `llm_config_salah`, tidak lagi dibuang-buang ke repair-loop dan dilaporkan 503 (src/llm/client.ts `isPermanentLlmHttpError`)
- [fixed] Dead code dihapus: `completeJson` (interface+impl), alias `UsageLogger`, `SessionStore.size()`, field `RenderResult.outPath`
- [ditolak setelah re-check] Dugaan duplikasi konstanta estimasi tinggi teks titleBullets vs twoColumn — konstanta berbeda karena lebar area berbeda (kolom vs full width), bukan drift

## Debug log pptxgenjs (progressif)

- (awal) Hex warna tanpa `#`; `pres.layout = "LAYOUT_WIDE"` wajib sebelum `addSlide()` pertama; satu instance `pptxgen()` per giliran render.
- Belum ditemukan gotcha lain pada trial render semua 7 layout (semua lolos validasi struktural).
