# CiptaSlide

Web app pribadi yang jalan lokal (bukan CLI) dengan **dua jalur** membuat `.pptx`:

1. **HTML -> PPTX** (utama): tulis HTML/CSS, dapat PowerPoint yang objeknya masih
   editable. Tidak butuh LLM.
2. **Brief -> PPTX** (sekunder): tulis brief di chat, LLM menyusun deck-nya.

```
Jalur 1 (HTML)
HTML -> sanitizer+parser -> cascade CSS -> layout engine -> IR -> pptxgenjs -> .pptx

Jalur 2 (Chat)
Brief -> Planner (LLM, JSON Deck + repair-loop max 3x) -> pptxgenjs -> QA -> .pptx
```

Keduanya menghasilkan file yang lolos validasi struktur OOXML sebelum dilaporkan
sukses, dan keduanya dilayani oleh server Express yang sama.

## Prasyarat

- Node.js >= 20
- Untuk jalur 1 saja: **tidak perlu API key apa pun**
- Untuk jalur 2: API key dari provider LLM apa pun yang OpenAI-compatible

## Setup

```powershell
npm install

# hanya diperlukan untuk jalur 2 (chat)
Copy-Item .env.example .env
notepad .env
```

Isi `.env` (wajib hanya untuk jalur chat):

| Var | Wajib | Contoh |
|---|---|---|
| `API_BASE_URL` | chat | `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `http://127.0.0.1:11434/v1` (Ollama) |
| `API_KEY` | chat | key provider (server-side saja, tidak pernah dikirim ke browser) |
| `MODEL_NAME` | chat | `gpt-4o-mini`, `deepseek-chat`, dsb. |
| `PORT` | tidak | default `3000` |
| `LLM_TIMEOUT_MS` | tidak | default `120000` |
| `LLM_MAX_TOKENS` | tidak | default `8192` (guardrail biaya) |
| `MAX_MESSAGE_CHARS` | tidak | default `8000` |

> Jalur HTML->PPTX tidak membaca `.env` sama sekali, jadi bisa dipakai tanpa
> konfigurasi LLM apa pun.

## Menjalankan

```powershell
npm start          # build + jalankan; buka http://127.0.0.1:3000
npm run dev        # build lalu node --watch dist/server/app.js
```

> Host **selalu** `127.0.0.1` (hardcoded di `src/config.ts`, tidak bisa dioverride
> env). Server pribadi tanpa auth — sengaja tidak terekspos ke jaringan.

## Jalur 1: HTML -> PPTX

Buka `http://127.0.0.1:<PORT>/html/`. Tempel HTML, atur ukuran slide, klik
**Convert to PPTX**.

Konvensi pembatas slide:

```html
<section data-slide data-background="#0B1020">
  <h1>Transformasi Digital</h1>
  <p>Meningkatkan efisiensi proses bisnis.</p>
</section>

<section data-slide>
  <h1>Slide kedua</h1>
</section>
```

Tanpa `data-slide`, seluruh dokumen dianggap satu slide.

### Elemen yang didukung

| HTML | PPTX |
|---|---|
| `h1`-`h6`, `p`, `blockquote`, `dt`, `dd`, `figcaption` | text |
| `strong`/`b`, `em`/`i`, `u`, `s` | run Bergaya di dalam paragraf |
| `span`, `a` | text (dengan hyperlink untuk `a`) |
| `ul`/`li`, `ol`/`li` | bullet / numbered list |
| `pre`, `code`, `kbd`, `samp` | text monospace |
| `img`, `svg` | image |
| `table` (`thead`/`tbody`/`th`/`td`) | table PowerPoint |
| `div`, `section`, `figure` | shape, **hanya** bila ada fill atau border |
| `hr` | line |

Container tanpa fill dan tanpa border sengaja **tidak** jadi shape, supaya wrapper
`<div>` biasa tidak menghasilkan kotak putih yang menutupi anaknya.

### CSS yang didukung

**Typography** `font-family` `font-size` `font-weight` `font-style` `color`
`line-height` `letter-spacing` `text-align` `text-transform` `text-decoration`
`vertical-align` `white-space`

**Box** `width` `height` `margin` `padding` `border` `border-*` `border-radius`
`background` `box-sizing` `min-`/`max-width` `min-`/`max-height`

**Position** `position` `top` `right` `bottom` `left`

**Layout** `display` (`block`, `inline`, `inline-block`, `flex`, `none`)
`flex-direction` `flex-wrap` `flex-grow` `flex-shrink` `flex-basis` `gap`
`justify-content` `align-items` `align-self` `order`

**Visibility** `display` `visibility` `opacity` `z-index` `overflow`

Anything else (CSS Grid, `filter`, `transform`, `animation`, `clip-path`,
`float`, ...) tidak diabaikan diam-diam: muncul sebagai warning di panel Report,
sesuai blok "Conversion report" di PRD.

### Atribut `data-pptx-*`

Escape hatch untuk presisi. Geometri dalam **inci**, font size dalam **point**.

```html
<div
    data-pptx-x="1"
    data-pptx-y="2"
    data-pptx-width="4"
    data-pptx-height="2"
    data-pptx-background="#0B1020"
    data-pptx-shape="roundRect">
</div>

<h1 data-pptx-font-size="32" data-pptx-color="#2563EB">Laporan Bulanan</h1>
```

| Atribut | Arti |
|---|---|
| `data-pptx-ignore` | lewati elemen beserta subtrenya |
| `data-pptx-x` / `-y` / `-width` / `-height` | geometri absolut (inci) |
| `data-pptx-font-size` | ukuran font (point) |
| `data-pptx-font-family` / `-font-weight` | tipografi |
| `data-pptx-color` / `-background` | warna CSS |
| `data-pptx-align` | `left` / `center` / `right` / `justify` |
| `data-pptx-type` | paksa tipe: `text` / `image` / `shape` / `line` |
| `data-pptx-shape` | preset shape pptxgenjs (`rect`, `roundRect`, `ellipse`, ...) |
| `data-pptx-as-image` | flatten subtree jadi satu gambar |
| `data-pptx-bullet` | glyph bullet, atau `none` |
| `data-pptx-rotate` | rotasi (derajat) |
| `data-pptx-css` | CSS tambahan tanpa `<style>` |

### Gambar

Inline `data:` URI adalah jalur yang paling andal:

```html
<img src="data:image/png;base64,iVBORw0KGgo..." width="200">
```

Aset juga bisa dikirim lewat API pada field `assets`. Gambar `http(s):` **mati
secara default** (`allowRemoteImages: false`) karena risiko SSRF; kalau diaktifkan
ada batas 5 MiB dan timeout 5 detik.

## API

```
POST /api/v1/convert    HTML -> file .pptx di output/
POST /api/v1/preview    HTML -> slide model, tanpa menulis file
POST /api/v1/validate   HTML -> warning/error, tanpa menulis file
GET  /api/v1/health     liveness probe
```

```http
POST /api/v1/convert
Content-Type: application/json

{
  "html": "<section data-slide><h1>Judul</h1></section>",
  "options": {
    "format": "16:9",
    "background": "#FFFFFF",
    "defaultFontFamily": "Arial",
    "mode": "editable"
  }
}
```

```json
{
  "success": true,
  "filename": "laporan-20260101abcd.pptx",
  "downloadUrl": "/output/laporan-20260101abcd.pptx",
  "bytes": 55012,
  "stats": { "slides": 1, "elements": 2, "converted": 2, "fallback": 0, "warnings": 0, "errors": 0 },
  "diagnostics": [],
  "durationMs": 34
}
```

`format`: `16:9` (default) | `4:3` | `custom`. `custom` butuh
`customSize: { widthInch, heightInch }`.

Error non-2xx selalu berbentuk `{ "error": string, "message": string }`.
File yang gagal validasi struktur **tidak pernah** dilaporkan sukses.

## Jalur 2: chat (LLM)

1. Buka `http://127.0.0.1:<PORT>`.
2. Ketik brief, mis. *"Deck 6 slide pitch produk kopi susu literan untuk investor"*.
3. Kirim pesan revisi di chat yang sama tanpa mulai dari nol.
4. Sesi hilang kalau server di-restart (in-memory, by design).

## Perintah

```powershell
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # compile ke dist/
```

File `.pptx` tersimpan di `output/` dan disajikan lewat `/output/<file>.pptx`.

## Arsitektur

### Jalur HTML (docs/10-html-to-pptx-engine.md)

| Lapisan | Berkas | Tugas |
|---|---|---|
| Shared | `src/shared/units.ts`, `color.ts`, `ir.ts` | satuan, warna, tipe IR |
| Parser | `src/html/sanitize.ts`, `dom.ts` | whitelist sanitizer + parse5 |
| Atribut | `src/html/pptxAttributes.ts` | `data-pptx-*` |
| CSS | `src/css/values.ts`, `parse.ts`, `selector.ts`, `cascade.ts`, `metrics.ts` | parser CSS, selector, cascade, metrik teks |
| Layout | `src/layout/layoutEngine.ts` | block, inline, flex, table -> box px |
| Mapping | `src/map/domToIr.ts` | box -> `SlideElement` |
| Aset | `src/assets/resolver.ts` | `<img src>` -> data URI |
| Pipeline | `src/convert/pipeline.ts`, `options.ts` | orkestrasi + laporan |
| Writer | `src/render/htmlPptxWriter.ts` | IR -> pptxgenjs |
| HTTP | `src/server/routes/html2pptx.ts` | `/api/v1/*` |

Prinsip: `96 px = 1 inch`, dan konversi ke inch **hanya** terjadi di dalam writer,
sehingga batas satuan bisa diaudit di satu tempat.

### Jalur chat

- `src/schema/deck.schema.ts` — kontrak `Deck` (Zod), satu-satunya jembatan antara
  output LLM dan renderer.
- `src/planner/contentPlanner.ts` — `planDeck()` / `reviseDeck()` dengan
  repair-loop maksimal 3 percobaan.
- `src/render/pptxRenderer.ts` + `layoutRenderers/` — strategy per layout.
- `src/qa/validator.ts` — buka ulang `.pptx` sebagai ZIP, cek entri XML inti.

## Guardrails

Detail: docs/00-guardrails.md.

- Bind hanya `127.0.0.1`.
- HTML user **tidak pernah** masuk `innerHTML`; sanitizer berbasis whitelist
  membuang `script`/`iframe`/`object`/`on*` dan menolak URL `javascript:`,
  `data:text/html`, `data:image/svg+xml`.
- Preview memakai `<iframe sandbox="">` dengan `srcdoc`: script mati total.
- `<style>` tetap didukung, tapi `@import`, `expression()`, dan
  `url(javascript:)` dinetralkan sebelum CSS dikompilasi.
- Gambar remote mati secara default; ada size cap dan timeout.
- Body JSON dibatasi 40 MB (koncahan HTML/CSS inline), tetap wajar untuk bind
  localhost.
- API key hanya di `.env` server, tidak pernah dikirim ke browser.

## Batasan yang diketahui

- CSS Grid, `float`, `transform`, `filter`, `animation` tidak didukung (warning,
  bukan crash).
- Metrik font adalah perkiraan tab advance width; PowerPoint memakai metrik asli
  saat membuka file, jadi line break bisa berbeda tipis.
- `inline-block` mendapat barisnya sendiri; campuran inline dan block dalam satu
  baris tidak dimodelkan.
- Mode `pixel` (raster per slide) belum meraster: butuh headless browser yang
  sengaja tidak ditambahkan. Fallback yang berfungsi sekarang adalah `hybrid`
  via `data-pptx-as-image`.
- Session chat in-memory, tanpa auth/multi-user/database.
- Block gambar pada jalur chat masih placeholder deskripsi.

Dokumen desain lengkap ada di folder `docs/`.