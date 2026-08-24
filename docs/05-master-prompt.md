Kamu membantu saya membangun CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator, sebuah web app pribadi yang jalan lokal (bukan CLI).

CONTEXT
- Idea/problem brief: docs/01-idea-brief.md
- Scope: docs/02-scope-brief.md
- Spec: docs/03-spec.md
- Architecture notes: docs/04-architecture-notes.md
- Implementation plan: docs/04a-implementation-plan.md
- Guardrails: docs/00-guardrails.md

STACK
Node.js ≥ 20, TypeScript, `express` (server lokal + static file serving), `openai` SDK (OpenAI-compatible, custom `baseURL`), `zod`, `pptxgenjs`, `jszip`, `dotenv`, `vitest`. Frontend: HTML/CSS/JS polos tanpa framework/build tool.

SCOPE
- Generate deck baru dari brief teks pertama di chat (mode generative).
- Revisi deck lewat pesan lanjutan di sesi chat yang sama (multi-turn) — bukan generate ulang dari nol.
- Frontend web sederhana bergaya chat, disajikan oleh server Express lokal.
- Server hanya listen di `127.0.0.1`, tanpa auth (single-user lokal).
- Session percakapan disimpan in-memory per sesi (hilang saat server restart).
- Provider LLM diganti via env var, tanpa ubah kode.
- Validasi konten (schema) sebelum render, validasi struktur file setelah render — di tiap giliran.

OUT OF SCOPE
- CLI/headless mode — dihapus total dari scope.
- Mode isi ulang template `.pptx` existing.
- Visual QA loop otomatis via vision model.
- Auth, multi-user, hosted service, database.
- Streaming response (SSE/WebSocket) saat generate/revisi.
- Animasi/transisi slide kompleks, embed video.

IMPLEMENTATION RULES
1. Perubahan kecil dan lokal ke task yang sedang dikerjakan.
2. Jangan sentuh file tidak terkait atau ganti struktur yang sudah ada tanpa instruksi eksplisit.
3. Sebelum perubahan besar, jelaskan rencana dan file yang terdampak dulu.
4. Ikuti docs/00-guardrails.md secara ketat — terutama soal data privat yang dikirim ke LLM API, batas retry, dan server yang wajib bind `127.0.0.1` saja.
5. Jangan tambah dependency baru tanpa menjelaskan alasannya.
6. Jalankan lint/build/test setelah tiap tahap dan laporkan hasilnya.
7. Deck wajib lolos Zod validation sebelum render; file `.pptx` wajib lolos validasi struktural sebelum dilaporkan sukses ke chat.
8. Semua fungsi lintas-stage (Planner → Renderer → QA) wajib fail loud (`throw`), tidak boleh silent fallback ke hasil kosong/default; route API yang menerjemahkan error jadi respons HTTP jelas ke frontend.

WORK ORDER
Stage 1: Ulangi pemahaman, sebutkan asumsi/pertanyaan, buat task plan.
Stage 2: Scaffold / implementasi core (schema, planner, renderer, validator).
Stage 3: Server Express + endpoint chat + frontend chat sederhana.
Stage 4: Test untuk logika kritis (termasuk giliran revisi).
Stage 5: Polish + edge case (session lifecycle, error handling).
Stage 6: Update docs/README.

DEFINITION OF DONE
- Web app end-to-end: buka browser di localhost → brief di chat → `.pptx` valid, teruji manual di PowerPoint/LibreOffice.
- Minimal satu giliran revisi lewat chat berhasil menghasilkan `.pptx` baru di sesi yang sama.
- Lint, type-check, dan test suite lulus 100%.
- `.env.example` + README dasar (termasuk cara menjalankan server lokal) tersedia untuk setup ulang di mesin lain.
