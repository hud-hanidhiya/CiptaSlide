# Technical Implementation Plan — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## 0. SOURCE REFERENCES (wajib dibaca sebelum eksekusi)

| Dokumen | Status |
|---|---|
| `docs/01-idea-brief.md` | Tersedia |
| `docs/02-scope-brief.md` | Tersedia |
| `docs/03-spec.md` | Tersedia |
| `docs/04-architecture-notes.md` | Tersedia |
| `docs/00-guardrails.md` | Tersedia |

## 1. OBJECTIVE & SCOPE
Membangun web app TypeScript lokal (server Express + frontend chat polos) yang mengubah brief teks — dan pesan revisi lanjutan — menjadi file `.pptx` valid, dengan LLM sebagai content planner dan `pptxgenjs` sebagai deterministic renderer, dilengkapi validasi schema dan validasi struktural.

**Batasan wajib (diturunkan dari `00-guardrails.md`):**
- [ ] Tidak mengirim data privat/sensitif ke LLM API eksternal tanpa review manual brief
- [ ] Tidak menghapus batas retry (max 3x) pada repair-loop planner, baik giliran initial maupun revisi
- [ ] Tidak melaporkan hasil "sukses" tanpa lolos `Deck.safeParse()` dan `validatePptxStructure()`
- [ ] Tidak menyimpan API key di kode/commit, dan tidak pernah mengirim API key ke frontend/browser
- [ ] Server wajib bind `127.0.0.1` saja, tidak boleh `0.0.0.0`

**Assumptions (belum diverifikasi):**
- Repo ini adalah repo Git terpisah, dikelola sepenuhnya sendiri.
- Dijalankan di mesin pribadi dengan Node.js ≥ 20 tersedia.
- Belum ada kode existing untuk proyek ini — semua file di bawah berstatus CREATE.
- Tidak ada kebutuhan multi-tab/multi-browser bersamaan yang perlu diisolasi ketat — satu operator, kemungkinan satu sesi aktif dalam satu waktu, tapi `sessionId` tetap dipakai supaya siap kalau operator buka beberapa tab dengan brief berbeda.

## 2. ARCHITECTURAL PATTERN & DESIGN
**Pola desain:** Pipeline / Pipe-and-Filter — Planner → Renderer → QA, dihubungkan lewat kontrak data tervalidasi (`Deck`), bukan shared mutable state. Dipicu per giliran chat lewat route HTTP, bukan lagi lewat invocation CLI. Render stage memakai Strategy Pattern per `layout` (lookup table `layoutRenderers`). Session state dipegang lewat pola Repository sederhana (`sessionStore.ts`, in-memory `Map`).

**Kontrak data / interface / skema:** identik dengan `04-architecture-notes.md` bagian "Perubahan data model / skema" — tidak diduplikasi di sini untuk menghindari dua sumber kebenaran yang bisa berbeda. Tambahan kontrak fungsi:

```typescript
interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

type PlanDeckFn = (client: OpenAIClient, model: string, brief: string) => Promise<Deck>;
type ReviseDeckFn = (client: OpenAIClient, model: string, currentDeck: Deck, instruction: string) => Promise<Deck>;
type RenderDeckFn = (deck: Deck, outPath: string) => Promise<void>;
type ValidatePptxFn = (path: string) => Promise<string[]>;

interface ChatRequestBody {
  sessionId: string;
  message: string;
}

interface ChatResponseBody {
  reply: string;
  downloadUrl?: string;
}
```

Aturan kontrak: batas antar-stage selalu data tervalidasi; Renderer tidak boleh memanggil LLM lagi; semua fungsi fail loud (`throw`), tidak ada silent fallback; route `chat.ts` yang menerjemahkan `throw` jadi HTTP status + pesan JSON yang jelas ke frontend (tidak pernah bocorkan stack trace mentah ke browser).

## 3. COMPONENT & FILE BREAKDOWN

- **`src/schema/deck.schema.ts`** — Status: CREATE
  * Tanggung jawab: Zod schema `Deck`/`Slide`/`Block` (discriminated union) + type inference.
  * State/input/output: pure definitions, tidak stateful.
  * Dependensi: `zod`.

- **`src/config.ts`** — Status: CREATE
  * Tanggung jawab: load & validasi env var (`API_BASE_URL`, `API_KEY`, `MODEL_NAME`, `PORT`), fail-fast kalau kosong; eksplisit set `HOST = "127.0.0.1"` (tidak dari env, biar tidak bisa kepencet salah ubah ke `0.0.0.0`).
  * Dependensi: `dotenv`.

- **`src/llm/client.ts`** — Status: CREATE
  * Tanggung jawab: wrapper `OpenAI` client (baseURL custom) + `generateDeckJson()`.
  * State/input/output: input `LlmConfig` + prompt; output raw JSON string (belum divalidasi).
  * Dependensi: `openai`.

- **`src/llm/promptBuilder.ts`** — Status: CREATE
  * Tanggung jawab: `buildSystemPrompt()`, `buildUserPrompt(brief)`, `buildRevisionPrompt(currentDeck, instruction)`, `buildRepairPrompt(raw, zodError)`.
  * Dependensi: `deck.schema.ts`.

- **`src/planner/contentPlanner.ts`** — Status: CREATE
  * Tanggung jawab: orkestrasi retry/repair loop (max 3x — guardrail biaya) untuk dua fungsi: `planDeck(brief)` (giliran initial) dan `reviseDeck(currentDeck, instruction)` (giliran revisi); satu-satunya tempat `Deck.safeParse()` pertama dipanggil.
  * Dependensi: `llm/client.ts`, `llm/promptBuilder.ts`, `schema/deck.schema.ts`.

- **`src/render/pptxRenderer.ts`** — Status: CREATE
  * Tanggung jawab: lookup table layout→renderer, `pres.layout = "LAYOUT_WIDE"` sebelum `addSlide()` pertama, `writeFile()` ke folder `output/` dengan nama file unik per giliran (mis. `${sessionId}-${timestamp}.pptx`).
  * Dependensi: `pptxgenjs`, semua `layoutRenderers/*`.

- **`src/render/layoutRenderers/titleBullets.ts`** — Status: CREATE — render title+bullet dari `TextBlock`.
- **`src/render/layoutRenderers/twoColumn.ts`** — Status: CREATE — render 2 kolom (reuse sementara untuk `imageText`).
- **`src/render/layoutRenderers/chart.ts`** — Status: CREATE — render `ChartBlock` via `addChart()`. Wajib guard nilai negatif/kosong sebelum render (guardrail output integrity).

- **`src/qa/validator.ts`** — Status: CREATE
  * Tanggung jawab: `validatePptxStructure(path)` — cek ZIP/XML dasar via `jszip`.
  * Dependensi: `jszip`, `fs/promises`.

- **`src/server/sessionStore.ts`** — Status: CREATE
  * Tanggung jawab: `Map<sessionId, SessionState>` in-memory; `getOrCreate(sessionId)`, `update(sessionId, patch)`.
  * State/input/output: stateful (satu-satunya tempat mutable state proyek ini), hidup selama proses server berjalan.
  * Dependensi: tidak ada (pure Node/TS).

- **`src/server/routes/chat.ts`** — Status: CREATE
  * Tanggung jawab: handler `POST /api/chat` — baca `sessionId`+`message`, cabang initial vs revisi berdasar `sessionStore`, panggil `contentPlanner` → `pptxRenderer` → `validator`, update session, balas JSON; terjemahkan error custom jadi HTTP status + pesan jelas.
  * Dependensi: `sessionStore.ts`, `planner/contentPlanner.ts`, `render/pptxRenderer.ts`, `qa/validator.ts`.

- **`src/server/app.ts`** — Status: CREATE — entry point, setup Express, `express.static("public")`, `express.static("output")` untuk link download, mount route chat, `app.listen(PORT, "127.0.0.1")`.

- **`public/index.html`** — Status: CREATE — markup halaman chat (area pesan + input + tombol kirim).
- **`public/chat.js`** — Status: CREATE — `fetch("/api/chat", ...)`, render bubble pesan, tampilkan link download saat `downloadUrl` ada, disable input saat menunggu balasan.
- **`public/styles.css`** — Status: CREATE — styling minimal, cukup rapi untuk dipakai sendiri.

**Reverse-dependency check:** tidak ada file DELETE (proyek greenfield, `cli.ts` yang direncanakan sebelumnya tidak jadi dibuat sama sekali — bukan dihapus, karena memang belum pernah ada di repo).

## 4. STEP-BY-STEP IMPLEMENTATION PHASES
- **Phase 1: Skema/types & interface** — `deck.schema.ts` lengkap + unit test schema (valid, invalid per field, chart pie nilai negatif ditolak).
- **Phase 2: Core logic / service / handler** — `config.ts`, `llm/client.ts`, `llm/promptBuilder.ts`, `planner/contentPlanner.ts` (`planDeck` + `reviseDeck` + repair-loop), unit test dengan mocked LLM client untuk kedua fungsi.
- **Phase 3: Render, server & frontend integration** — semua `layoutRenderers/*`, `pptxRenderer.ts`, `qa/validator.ts`, `sessionStore.ts`, `server/routes/chat.ts`, `server/app.ts`, `public/*`; integration test end-to-end untuk `/api/chat` (initial + revisi) dengan mocked LLM response (fixture JSON); manual check frontend di browser.
- **Phase 4: Validasi & error handling** — custom error class (`LlmTransientError`, `LlmSchemaError`, `UserInputError`, `SessionNotFoundError`), mapping error → HTTP status di `chat.ts`, logging minimal per-stage, manual smoke test dengan API key asli lewat browser (initial + minimal satu revisi).

## 5. EDGE CASES & SAFETY CHECKS
- **Nilai nol/negatif/null**: `ChartBlock.values` negatif pada `pie`/`doughnut` wajib ditolak pre-render; `values` kosong/semua nol → placeholder eksplisit, bukan chart kosong membingungkan.
- **Idempotency / duplicate request**: tiap giliran chat independen secara side-effect (file baru per giliran, bukan overwrite diam-diam); repair-loop harus kirim ulang JSON invalid sebagai konteks perbaikan, bukan generate ulang dari nol (hemat token, hasil konsisten antar-attempt).
- **Klasifikasi error**: Technical (network timeout, HTTP 429, response bukan JSON) → retry otomatis dalam batas repair-loop. Business (brief kosong, palette hex salah format, jumlah slide >30) → fail fast, tidak retry, balas HTTP 4xx jelas ke chat.
- **Race condition / network failure**: set `timeout` eksplisit di client LLM (provider non-OpenAI/lokal bisa jauh lebih lambat). Satu `pptxgen()` instance per giliran render — jangan reuse across request. Frontend disable input selama menunggu balasan supaya tidak ada dua request bersamaan untuk `sessionId` yang sama.
- **Session lifecycle**: `sessionId` tidak dikenal di `sessionStore` (mis. server baru di-restart) → `chat.ts` balas `SessionNotFoundError` (HTTP 404) dengan pesan jelas, frontend arahkan mulai chat baru — bukan diam-diam membuat sesi kosong yang membingungkan.
- **Keamanan lokal**: server cuma listen di `127.0.0.1`; test manual pastikan tidak bisa diakses dari perangkat lain di jaringan yang sama.
- **Checklist verifikasi/testing singkat:**
  - [ ] `Deck.safeParse()` menolak semua kasus invalid yang terdaftar
  - [ ] Repair-loop pulih dari 1x kegagalan schema (unit test, mocked LLM) — untuk `planDeck` maupun `reviseDeck`
  - [ ] Repair-loop `throw` setelah 3x gagal
  - [ ] Setiap `LayoutType` punya renderer terdaftar (tidak ada `undefined` runtime)
  - [ ] `validatePptxStructure()` mendeteksi file corrupt sengaja-dirusak
  - [ ] `POST /api/chat` giliran initial menghasilkan `downloadUrl` valid (integration test, mocked LLM)
  - [ ] `POST /api/chat` giliran revisi (sessionId sudah ada `Deck`) menghasilkan `Deck` baru yang berbeda dari sebelumnya (integration test, mocked LLM)
  - [ ] `sessionId` tidak dikenal → HTTP 404 jelas, bukan crash server
  - [ ] End-to-end manual: brief → `.pptx` terbuka tanpa "repair needed", lalu satu revisi → `.pptx` baru juga terbuka mulus
  - [ ] Env var kosong → server gagal start dengan pesan jelas, bukan stack trace mentah
  - [ ] Server tidak bisa diakses dari luar `127.0.0.1` (manual check)

## 6. VERIFICATION GATE (instruksi untuk AI berikutnya)
Sebelum menyusun `docs/06-task-plan.md`:
- Konfirmasi apakah repo sudah diinisialisasi atau masih perlu `npm init` dari nol.
- Konfirmasi setiap path file dan function signature di atas benar-benar ada di repo lokal (kalau repo sudah ada isinya).
- Kalau ada mismatch antara rencana ini dan kondisi repo aktual — laporkan dan berhenti, jangan menebak.
- Cek versi eksplisit `pptxgenjs`/`openai`/`zod`/`express` dari `package.json` aktual (kalau sudah ada) sebelum instalasi.
