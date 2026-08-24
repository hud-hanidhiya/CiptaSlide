# Rangkuman — Proyek CiptaSlide (AI PPTX Generator)

## Konteks
Proyek pribadi (bukan terkait pekerjaan kantor apa pun). Nama proyek: **CiptaSlide**. Tujuan: web app lokal bergaya chat AI yang mengubah brief teks jadi file `.pptx` valid, memakai LLM (API apa saja yang OpenAI-compatible) sebagai content planner, dan `pptxgenjs` sebagai renderer deterministik. Bisa revisi deck lewat pesan lanjutan (multi-turn) dalam sesi chat yang sama.

## Perjalanan percakapan (ringkas)
1. Diskusi awal soal skill `pptx` bawaan Claude — disepakati tidak disalin verbatim (proprietary), tapi prinsipnya (pemisahan LLM-planner vs renderer deterministik, structured output, QA berlapis) dipakai sebagai basis desain sendiri.
2. Dibuat dokumen plan awal + technical implementation plan, awalnya sebagai **CLI**.
3. Dokumen diintegrasikan ke tiga versi workflow kit secara berurutan (tiap versi menggantikan yang sebelumnya):
   - `internal-tools-workflow-v2.md` (versi kerja, ditolak karena proyek ini personal)
   - `Personal_Project_Workflow_Kit.md` (versi ringkas 8 dokumen)
   - **`Universal-Project-Workflow-Kit-ID.md` — versi final yang dipakai sekarang** (Tier 1/Tier 2, ada `00-guardrails.md` dan `04a` sebagai jembatan ke coding agent)
4. Semua referensi ke instansi/istilah kerja (LNSW, INSW, CEISA, Bea Cukai, PPKEK, NK Tools, pajak, cukai) sudah dibersihkan total dari seluruh dokumen — sudah diverifikasi dengan grep, hasilnya bersih.
5. Proyek diberi nama **CiptaSlide**.
6. **Pivot arsitektur (perubahan terbaru):** CLI dihapus total dari scope, diganti web app lokal dengan frontend chat sederhana (HTML/CSS/JS polos, tanpa framework), server Express yang bind `127.0.0.1` saja. Chat-nya multi-turn — bisa minta revisi deck lewat pesan lanjutan setelah hasil pertama, tidak cuma single-shot. Semua 9 dokumen inti (`00`–`06`) + ringkasan ini sudah diperbarui untuk mencerminkan pivot ini.

## Status saat ini
**Tier proyek: Tier 2 (Full Suite)** — karena ada integrasi eksternal baru (LLM API) dan scope lintas sesi.

Folder `docs/` berisi 11 file, mengikuti struktur Universal Project Workflow Kit — semua sudah versi web app (bukan CLI lagi):
- `00-guardrails.md` — 3 Risk Trigger spesifik proyek ini: (1) data privat terkirim ke LLM eksternal, (2) biaya API tak terkendali (termasuk lintas giliran revisi), (3) output dilaporkan sukses padahal file corrupt; ditambah catatan wajib bind server ke `127.0.0.1`.
- `01-idea-brief.md` — sekarang mendeskripsikan web app chat, bukan CLI.
- `02-scope-brief.md` — stack ganti `commander` → `express`; scope mencakup frontend chat, session in-memory, revisi multi-turn.
- `03-spec.md` — user flow, error handling, dan acceptance criteria (AC-01 s.d. AC-04) sudah versi chat web, termasuk AC-04 khusus giliran revisi.
- `04-architecture-notes.md` — struktur folder baru (`src/server/`, `public/`), tipe `SessionState`/`ChatTurnSummary` baru, keputusan teknis kunci soal web app vs CLI dan session in-memory.
- `04a-implementation-plan.md` — breakdown file per komponen versi web (server, routes, sessionStore, frontend), 4 phase implementasi, edge case session lifecycle.
- `05-master-prompt.md` — siap ditempel ke AI coding tool, sudah versi web app.
- `06-task-plan.md` — 22 task (bertambah dari 18 di versi CLI karena ada task server/session/frontend), tabel dengan target file + done criteria.
- `07-debug-log.md` — kosong, template siap pakai.
- `08-qa-release-checklist.md` — ditambah item session lifecycle & keamanan bind localhost.
- `09-retrospective.md` — kosong, template siap pakai.

## Keputusan teknis kunci
- Stack: Node.js ≥ 20, TypeScript, `express` (server lokal + static serving), `openai` SDK (baseURL custom untuk provider apa saja), `zod`, `pptxgenjs`, `jszip`, `dotenv`, `vitest`. Frontend: HTML/CSS/JS polos tanpa build tool.
- Arsitektur: pipeline 3 stage (Planner → Renderer → QA), dihubungkan lewat kontrak `Deck` (Zod-validated) — LLM tidak pernah menulis XML/OOXML langsung. Dipicu per giliran chat lewat `POST /api/chat`.
- CLI dihapus total dari scope — web app satu-satunya cara pakai.
- Chat multi-turn: giliran revisi mengirim `Deck` terakhir + instruksi revisi sebagai konteks ke LLM (bukan riwayat chat mentah penuh, bukan generate ulang dari nol).
- Session state disimpan in-memory di server (`Map<sessionId, SessionState>`) — hilang saat server restart, diterima sebagai batasan sadar untuk tool single-user lokal v1.
- Server wajib bind `127.0.0.1` saja, tanpa sistem auth (single-user lokal).
- Repair-loop LLM dibatasi max 3x percobaan per giliran (guardrail biaya), baik initial maupun revisi.
- Renderer pakai Strategy Pattern (lookup table per `layout` type) supaya gampang ditambah layout baru.
- Chart `pie`/`doughnut` dengan nilai negatif wajib ditolak sebelum render (guardrail output integrity).

## Backlog v2
- Upload file dokumen (`.docx`/`.pdf`/`.txt`) sebagai sumber brief, bukan cuma teks diketik di chat — dicatat di `02-scope-brief.md`, `03-spec.md`, dan `09-retrospective.md`.

## Belum dikerjakan / langkah berikutnya
- **Gate A** (verifikasi kit): karena repo belum di-`npm init`, semua file di `04a` masih berstatus CREATE — Gate A otomatis lolos untuk repo kosong, tapi tetap perlu dikonfirmasi ulang begitu mulai scaffold.
- Proyek belum di-scaffold sama sekali (belum ada `package.json`, belum ada kode).
- Langkah paling praktis untuk lanjut: mulai dari Task #1 di `06-task-plan.md` (init project, deps termasuk `express`, tsconfig), lalu jalan sekuensial sampai Task #22.
- Kalau lanjut di chat baru: cukup upload folder `docs/` (atau tempel `05-master-prompt.md`) ke chat baru sebagai konteks awal, lalu minta lanjut dari Phase 1.
