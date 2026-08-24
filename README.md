# CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator

Web app pribadi yang jalan lokal (bukan CLI): tulis brief presentasi di chat, dapat file `.pptx` valid yang bisa langsung dibuka di PowerPoint/LibreOffice. Revisi deck cukup dengan pesan lanjutan di sesi chat yang sama — tanpa mulai dari nol.

```
Brief teks → Planner (LLM, JSON Deck + repair-loop max 3×)
           → Renderer (pptxgenjs, deterministik)
           → QA (validasi Zod sebelum render, validasi struktur ZIP/XML setelah render)
           → link download .pptx di chat
```

## Prasyarat

- Node.js ≥ 20
- API key dari provider LLM apa pun yang OpenAI-compatible (OpenAI, DeepSeek, Gemini-compat, Ollama lokal)

## Setup

```powershell
npm install

# salin konfigurasi lalu isi API_BASE_URL / API_KEY / MODEL_NAME
Copy-Item .env.example .env
notepad .env
```

Isi `.env` minimal:

| Var | Wajib | Contoh |
|---|---|---|
| `API_BASE_URL` | ya | `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `http://127.0.0.1:11434/v1` (Ollama) |
| `API_KEY` | ya | key dari provider (server-side saja, tidak pernah dikirim ke browser) |
| `MODEL_NAME` | ya | `gpt-4o-mini`, `deepseek-chat`, dsb. |
| `PORT` | tidak | default `3000` |
| `LLM_TIMEOUT_MS` | tidak | default `120000` |
| `LLM_MAX_TOKENS` | tidak | default `8192` (guardrail biaya) |
| `MAX_MESSAGE_CHARS` | tidak | default `8000` |

## Menjalankan server lokal

```powershell
npm start          # build + jalankan; buka http://127.0.0.1:3000
```

Untuk pengembangan (build sekali, server auto-restart saat dist berubah):

```powershell
npm run dev        # build lalu node --watch dist/server/app.js
```

> Host **selalu** `127.0.0.1` (hardcoded di `src/config.ts`, tidak bisa dioverride env). Server pribadi tanpa auth — sengaja tidak terekspos ke jaringan.

## Cara pakai

1. Buka `http://127.0.0.1:<PORT>` di browser.
2. Ketik brief pertama, mis. *"Deck 6 slide pitch produk kopi susu literan untuk investor"* → tunggu → muncul ringkasan + link download `.pptx`.
3. Kirim pesan revisi di chat yang sama, mis. *"ganti warna tema jadi biru"* atau *"tambah slide penutup"* → deck baru dirender, link baru muncul.
4. Sesi hilang kalau server di-restart (in-memory, by design) — ketik ulang brief untuk mulai sesi baru.

## Perintah lain

```powershell
npm run typecheck  # tsc --noEmit
npm test           # vitest run (106 test)
npm run build      # compile ke dist/
```

File `.pptx` hasil render tersimpan di `output/` dan juga disajikan lewat `/output/<file>.pptx`.

## Arsitektur singkat

- `src/schema/deck.schema.ts` — kontrak `Deck` (Zod): satu-satunya jembatan antara output LLM dan renderer. Pie/doughnut bernilai negatif **ditolak** di sini.
- `src/planner/contentPlanner.ts` — `planDeck()` (giliran initial) & `reviseDeck()` (multi-turn, konteks = Deck terakhir + instruksi, bukan riwayat penuh). Repair-loop **maksimal 3 percobaan** per giliran.
- `src/render/pptxRenderer.ts` + `layoutRenderers/` — strategy per layout (`title`, `titleBullets`, `twoColumn`, `chartFocus`, `imageText`, `sectionDivider`, `closing`).
- `src/qa/validator.ts` — buka ulang `.pptx` sebagai ZIP, cek entri XML inti. File gagal validasi **tidak pernah** dilaporkan sukses ke chat.
- `src/server/` — Express bind `127.0.0.1`: `POST /api/sessions` (buat sessionId), `POST /api/chat` (pipeline per giliran), static `public/` + `output/`.
- `public/` — chat UI polos tanpa framework/build step.

Semua fungsi lintas-stage fail loud (`throw`) — tidak ada silent fallback; route menerjemahkan error jadi HTTP status yang jelas (400 input, 404 sesi mati, 502 schema invalid persisten, 503 LLM tak bisa dihubungi, 500 render/file corrupt).

## Guardrails utama (detail: docs/00-guardrails.md)

- API key hanya di `.env` server (masuk `.gitignore`), tidak pernah dikirim ke frontend.
- Brief dikirim ke provider LLM eksternal — jangan isi data privat/sensitif.
- Repair-loop & retry dibatasi ketat; token usage dilog per giliran.

## Batasan v1 (by design)

- Session in-memory — hilang saat server restart.
- Tanpa streaming (loading indicator saja), tanpa auth/multi-user/database.
- Block gambar dirender sebagai placeholder deskripsi (belum ada file gambar asli).

Dokumen desain lengkap ada di folder `docs/`.
