# Architecture Notes — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

> **Catatan revisi (HTML -> PPTX).** Dokumen ini menjelaskan jalur **chat/LLM**.
> Jalur kedua, **HTML -> PPTX**, punya arsitektur sendiri yang berlapis:
> sanitize -> cascade -> layout -> IR -> pptxgenjs. Lihat
> **[docs/10-html-to-pptx-engine.md](10-html-to-pptx-engine.md)**.

## Stack & alasannya
- **TypeScript + Node.js ≥ 20** — type-safety penting karena kontrak `Deck` jadi jembatan antara output LLM yang tidak terprediksi dan renderer yang deterministik.
- **`express`** — server HTTP minimal untuk menyajikan frontend statis (`public/`) dan endpoint API (`/api/chat`, `/api/v1/*`); dipilih karena paling sederhana untuk kebutuhan single-user lokal, tidak butuh fitur framework yang lebih berat.
- **`openai` SDK** — dipakai bukan cuma untuk OpenAI, tapi karena hampir semua provider (DeepSeek, Gemini compat layer, Ollama lokal) menyediakan endpoint kompatibel `/chat/completions`. Cukup ganti `baseURL`.
- **`zod`** — validasi runtime + type inference sekaligus; krusial karena LLM output tidak bisa dipercaya begitu saja walau providernya "mendukung" structured output.
- **`pptxgenjs`** — renderer OOXML tingkat tinggi, tidak perlu manipulasi XML manual untuk kasus generate-dari-nol. Dipakai oleh **kedua** jalur.
- **`jszip`** — untuk QA struktural (`.pptx` adalah ZIP), dan nanti dipakai lagi kalau mode template (v2) butuh baca/tulis XML slide existing.
- **`parse5`** — parser HTML sesuai spesifikasi (WHATWG). Dipakai hanya untuk *tokenizing*: pipeline ini tidak pernah membutuhkan DOM hidup, jadi tidak perlu jsdom yang jauh lebih berat dan sudah punya parser bawaan.
- **Frontend polos (HTML/CSS/JS, tanpa framework/build tool)** — cukup untuk halaman chat dan workbench konverter; menghindari kompleksitas build pipeline untuk tool pribadi. Disajikan langsung lewat `express.static`.

**Dependency yang dihapus dari versi CLI:** `commander` (parsing argumen CLI) — tidak relevan lagi karena tidak ada lagi entry point command-line.

## Struktur proyek
```
CiptaSlide/
  src/
    shared/                    # [HTML->PPTX] satuan, warna, tipe IR
      units.ts, color.ts, ir.ts
    html/                      # [HTML->PPTX] sanitizer whitelist + parser parse5
      dom.ts, sanitize.ts, pptxAttributes.ts
    css/                       # [HTML->PPTX] CSS subset engine
      values.ts, parse.ts, selector.ts, cascade.ts, metrics.ts
    layout/                    # [HTML->PPTX] block/inline/flex/table -> box px
      layoutEngine.ts
    map/                       # [HTML->PPTX] box -> SlideElement
      domToIr.ts
    assets/                    # [HTML->PPTX] <img src> -> data URI
      resolver.ts
    convert/                   # [HTML->PPTX] orkestrasi pipeline + laporan
      options.ts, pipeline.ts
    server/
      app.ts                # setup Express app, static serving, mount routes
      routes/
        chat.ts              # POST /api/chat — orkestrasi planner→renderer→validator per giliran
        html2pptx.ts         # POST /api/v1/{convert,preview,validate}, GET /api/v1/health
      sessionStore.ts        # Map<sessionId, SessionState> in-memory
    config.ts                 # load & validasi env var (API_BASE_URL, API_KEY, MODEL_NAME, PORT)
    llm/
      client.ts
      promptBuilder.ts        # buildSystemPrompt, buildUserPrompt(brief), buildRevisionPrompt(deck, instruction), buildRepairPrompt(raw, zodError)
    schema/
      deck.schema.ts
    planner/
      contentPlanner.ts       # planDeck() untuk initial, reviseDeck() untuk revisi — sama-sama pakai repair-loop max 3x
    render/
      pptxRenderer.ts         # [chat] Deck -> pptx
      layoutRenderers/
        titleBullets.ts
        twoColumn.ts
        chart.ts
      htmlPptxWriter.ts       # [HTML->PPTX] IR -> pptx (fungsi murni dari IR)
    qa/
      validator.ts            # dipakai kedua jalur
  public/
    index.html                 # markup chat UI
    chat.js                    # fetch ke /api/chat, render bubble chat + link download
    styles.css
    html/                      # workbench HTML -> PPTX (editor, preview sandbox, report)
      index.html, app.js, styles.css
  tests/
    schema.test.ts, renderer.test.ts, contentPlanner.test.ts, chatRoute.test.ts
    units.test.ts, sanitize.test.ts, cssEngine.test.ts, layout.test.ts
    domToIr.test.ts, golden.test.ts, pipeline.test.ts, html2pptxRoute.test.ts
    fixtures/                  # golden file: input.html + expected.json
  docs/
  output/                       # file .pptx hasil render, disajikan lewat express.static juga
  .env.example
  package.json
  tsconfig.json
```

## Keputusan teknis kunci
| Keputusan | Alasan | Alternatif yang dipertimbangkan |
|---|---|---|
| Pipeline 3 stage (Planner → Renderer → QA), dihubungkan lewat kontrak `Deck` tervalidasi | LLM tidak pernah menulis XML/OOXML langsung — menghindari file corrupt dari halusinasi struktur, tiap stage bisa ditest independen | LLM langsung generate XML/OOXML mentah — ditolak, terlalu rapuh dan sulit divalidasi |
| Zod schema sebagai satu-satunya kontrak antar-stage | Type-safety + runtime validation sekaligus; repair-loop bisa pakai error Zod sebagai feedback ke LLM | JSON Schema murni tanpa Zod — kehilangan type inference otomatis di TypeScript |
| Strategy Pattern untuk renderer (lookup table per `layout` type) | Menambah layout baru = menambah satu entri, tanpa menyentuh kode lain | Satu fungsi renderer raksasa dengan switch-case — lebih rapuh untuk maintenance jangka panjang |
| Repair-loop max 3x, mengirim ulang JSON invalid sebagai konteks (bukan generate ulang dari nol) | Retry mahal (generate ulang total) boros token dan hasil beda-beda tiap attempt | Retry tanpa batas — ditolak, lihat `00-guardrails.md` (risiko biaya tak terkendali) |
| Web app dengan frontend chat polos + server Express lokal, menggantikan CLI sepenuhnya | Pengalaman "mengobrol sampai deck jadi" lebih natural untuk revisi berulang; tetap sederhana karena tanpa framework/build step | Tetap CLI dengan flag `--revise` — ditolak, kurang natural untuk iterasi multi-turn; framework frontend (React dll) — ditolak untuk v1, kebutuhan UI terlalu sederhana untuk menjustifikasi build tooling |
| Session state in-memory (`Map` di proses server), bukan file/DB | Single-user lokal, tidak butuh persistensi lintas restart; menghindari kompleksitas DB untuk tool pribadi | SQLite lokal untuk histori sesi — ditolak untuk v1, kandidat v2 kalau riwayat lintas-restart ternyata dibutuhkan |
| Revisi kirim `Deck` terakhir + instruksi sebagai konteks ke LLM (bukan seluruh riwayat chat mentah) | Payload/token terkendali seiring percakapan makin panjang; `Deck` JSON sudah representasi lengkap state saat ini | Kirim seluruh riwayat pesan chat tiap giliran — ditolak, boros token dan tidak perlu karena `Deck` sudah representasi state |
| Server bind `127.0.0.1` saja, tanpa auth | Cukup untuk single-user lokal; menghindari kebutuhan sistem login untuk tool pribadi | Bind `0.0.0.0` + auth sederhana — ditolak untuk v1, di luar scope (lihat `00-guardrails.md`) |
| Tanpa streaming (SSE/WebSocket) di v1 — respon dikirim penuh setelah render selesai | Lebih sederhana untuk MVP; loading indicator cukup untuk kebutuhan personal | SSE untuk menampilkan progres per-stage — kandidat v2, nice-to-have |

## Integration point & kontrak
| Sistem target | Protokol | Auth | Payload/interface |
|---|---|---|---|
| LLM Provider (OpenAI-compatible) | HTTPS REST (`/chat/completions`) | Bearer API key via `.env` (server-side saja) | `{ model, messages[], response_format }` → `Deck` JSON (skema di bawah) |
| Frontend (browser) ↔ Server lokal | HTTP REST, `127.0.0.1` saja | Tidak ada (single-user lokal) | `POST /api/chat { sessionId, message }` → `{ reply: string, downloadUrl?: string, deckSummary?: object }` |

Tidak ada integration point lain.

## Perubahan data model / skema
```sql
-- N/A — proyek ini tidak memakai database apa pun. File-based only (output .pptx ke disk lokal, session state in-memory).
```

```typescript
type LayoutType =
  | "title" | "titleBullets" | "twoColumn"
  | "chartFocus" | "imageText" | "sectionDivider" | "closing";

interface Palette {
  primary: string;    // hex 6 digit, no '#'
  secondary: string;
  background: string; // default "FFFFFF"
  text: string;        // default "1A1A1A"
}

interface TextBlock {
  type: "text";
  content: string;
  bullet: boolean;
  bold: boolean;
}

interface ChartBlock {
  type: "chart";
  chartType: "bar" | "line" | "pie" | "doughnut";
  title: string;
  categories: string[];
  series: { name: string; values: number[] }[];
}

interface ImageBlock {
  type: "image";
  description: string;
  altPosition: "left" | "right" | "full";
}

type Block = TextBlock | ChartBlock | ImageBlock;

interface Slide {
  layout: LayoutType;
  title: string;
  subtitle?: string;
  blocks: Block[];
  speakerNotes?: string;
}

interface Deck {
  meta: { title: string; author?: string; palette: Palette };
  slides: Slide[];
}

// Baru — untuk mendukung web app + multi-turn revision (tidak dipersist, in-memory saja)
interface ChatTurnSummary {
  role: "user" | "assistant";
  summary: string; // ringkasan singkat, bukan JSON Deck penuh
}

interface SessionState {
  sessionId: string;
  deck: Deck | null;        // null sebelum giliran initial selesai
  lastPptxPath: string | null;
  turns: ChatTurnSummary[]; // riwayat ringkas untuk ditampilkan di frontend
  createdAt: number;
}
```

## Data flow
```
Browser (chat UI)
  → POST /api/chat { sessionId, message }
  → [sessionId baru?] → ContentPlanner.planDeck(brief)      (LLM call, retry/repair max 3x)
  → [sessionId ada Deck?] → ContentPlanner.reviseDeck(deck, instruction)  (LLM call, retry/repair max 3x)
  → Deck (JSON, Zod-validated)
  → PptxRenderer (deterministic, pptxgenjs) → file.pptx (disk, output/)
  → Validator (jszip, cek struktur ZIP/XML dasar)
  → SessionState diupdate (deck baru, lastPptxPath, turns)
  → balasan JSON ke browser: { reply, downloadUrl } | error (HTTP 4xx/5xx, pesan jelas)
```
Session state hidup di memori server selama proses server berjalan — hilang total kalau server di-restart (lihat Failure mode di bawah).

## Failure mode & recovery
- **LLM API timeout/tidak merespons** → tidak ada rollback diperlukan (Deck lama di session state tidak berubah sampai giliran baru sukses). Operator cukup kirim ulang pesan — idempotent secara alami karena tidak ada side effect ke sistem lain.
- **File `.pptx` hasil render corrupt** → terdeteksi `Validator` sebelum server melaporkan sukses ke chat; file gagal cukup dihapus/diabaikan, `SessionState.deck` tetap versi lama (belum ditimpa), tidak perlu rollback kompleks.
- **API key salah/habis kuota** → fail-fast di `config.ts` sebelum server bahkan mulai listen, atau sebelum memanggil LLM sama sekali kalau baru diketahui saat runtime.
- **Server di-restart** → semua `SessionState` in-memory hilang; operator harus mulai chat baru dari awal (brief awal lagi). Ini diterima sebagai batasan sadar untuk tool single-user lokal v1, bukan bug — didokumentasikan juga di `03-spec.md`.
- Tidak ada retry queue/DLQ — di luar scope untuk tool single-user, single-process.

## Risiko yang diketahui
- Provider OpenAI-compatible tidak semuanya konsisten dukung `response_format: json_schema` strict — mitigasi: selalu validasi ulang dengan Zod di sisi kita, jangan percaya klaim provider begitu saja.
- Gotcha spesifik `pptxgenjs` (format hex warna, batas nilai shadow/offset, dsb) belum dikumpulkan — dicatat progresif di `07-debug-log.md` seiring trial-run.
- Biaya API membengkak kalau brief kompleks, repair-loop sering kepakai, atau operator melakukan banyak giliran revisi berturut-turut dalam satu sesi — sudah dimitigasi lewat guardrail di `00-guardrails.md` (repair-loop max 3x per giliran, konteks revisi ringkas bukan riwayat penuh).
- Server yang bind `127.0.0.1` tanpa auth tetap berisiko kalau suatu saat operator lupa dan mengubah bind address ke `0.0.0.0` — perlu dijaga eksplisit di `config.ts`/README, bukan cuma konvensi tak tertulis.

## Path file yang terdampak
- `src/schema/deck.schema.ts` (CREATE)
- `src/config.ts` (CREATE)
- `src/llm/client.ts` (CREATE)
- `src/llm/promptBuilder.ts` (CREATE)
- `src/planner/contentPlanner.ts` (CREATE)
- `src/render/pptxRenderer.ts` (CREATE)
- `src/render/layoutRenderers/titleBullets.ts` (CREATE)
- `src/render/layoutRenderers/twoColumn.ts` (CREATE)
- `src/render/layoutRenderers/chart.ts` (CREATE)
- `src/qa/validator.ts` (CREATE)
- `src/server/app.ts` (CREATE)
- `src/server/routes/chat.ts` (CREATE)
- `src/server/sessionStore.ts` (CREATE)
- `public/index.html` (CREATE)
- `public/chat.js` (CREATE)
- `public/styles.css` (CREATE)
