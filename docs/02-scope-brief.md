# Scope Brief — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## Tujuan inti
Ubah brief teks (dan pesan revisi lanjutan) menjadi file `.pptx` valid lewat pipeline LLM (content planning) → renderer deterministik (file generation), diakses lewat web app lokal bergaya chat AI.

## In scope (v1)
- Generate deck baru dari brief teks pertama di chat (mode generative, bukan edit template).
- Revisi deck lewat pesan lanjutan di sesi chat yang sama (multi-turn) — LLM menerima `Deck` terakhir + instruksi revisi, bukan generate ulang dari nol.
- Frontend web sederhana bergaya chat (HTML/CSS/JS polos, tanpa framework) — bukan CLI.
- Server lokal (Express) yang menyajikan frontend statis dan endpoint API chat; **hanya listen di `127.0.0.1`**, tidak diekspos ke jaringan.
- Sesi percakapan disimpan in-memory di server per browser tab/sesi (hilang kalau server di-restart — bukan persistent, tetap bukan database).
- Provider LLM bisa diganti via env var (`API_BASE_URL`) — provider-agnostic, OpenAI-compatible.
- Validasi konten (schema) sebelum render, dan validasi struktur file setelah render, di tiap giliran (initial maupun revisi).
- Link download `.pptx` ditampilkan di chat setiap kali deck baru berhasil di-render.

## Out of scope (sengaja, untuk sekarang)
- CLI/headless mode — dihapus dari scope, tidak dipertahankan sebagai alternatif.
- Upload file dokumen (`.docx`, `.pdf`, `.txt`, dsb.) sebagai sumber brief — v1 cuma terima teks yang diketik langsung di chat (kandidat v2; butuh dependency ekstraksi teks baru dan guardrail ukuran/tipe file).
- Mode isi ulang template `.pptx` existing (kandidat v2).
- Visual QA loop otomatis pakai vision model (kandidat v3).
- Multi-user, auth/login, atau hosted service — ini web app pribadi yang jalan lokal, bukan aplikasi yang di-deploy untuk banyak orang.
- Streaming response (SSE/WebSocket) saat LLM sedang memproses — v1 cukup loading indicator, respon dikirim penuh setelah selesai (kandidat v2).
- Riwayat sesi yang persisten lintas restart server (kandidat v2, kalau memang dibutuhkan).
- Animasi/transisi slide kompleks, embed video.

## Stack
Node.js ≥ 20, TypeScript, `express` (server lokal + static file serving), `openai` SDK (custom `baseURL`), `zod`, `pptxgenjs`, `jszip`, `dotenv`, `vitest`. Frontend: HTML/CSS/JS polos tanpa build tool/framework tambahan, disajikan langsung oleh `express.static`.

## Constraints
- Offline-only tidak berlaku — proyek ini butuh koneksi internet untuk memanggil LLM API eksternal.
- Tidak ada database — state percakapan (Deck saat ini + histori ringkas) hidup di memori proses server selama server jalan, bukan file/DB persisten.
- Server wajib bind ke `127.0.0.1` saja — tidak boleh `0.0.0.0`, karena tidak ada auth (lihat `00-guardrails.md`).
- Tidak menambah dependency baru di luar daftar Stack tanpa alasan eksplisit (satu-satunya tambahan dari versi CLI: `express`, untuk menggantikan `commander`).
- Lihat `00-guardrails.md` untuk batasan terkait data privat dan kontrol biaya API.

## Sistem/integrasi yang disentuh
- [x] LLM Provider API (OpenAI-compatible — OpenAI/DeepSeek/Gemini-compat/Ollama lokal)
- [ ] Tidak ada database
- [ ] Tidak ada API pihak ketiga lain di luar LLM

## Definition of done
- Web app end-to-end: buka browser di localhost → ketik brief di chat → dapat `.pptx` valid, teruji manual di PowerPoint/LibreOffice.
- Bisa kirim minimal satu pesan revisi lanjutan di sesi yang sama dan dapat `.pptx` baru yang mencerminkan revisi itu.
- Lint, type-check, dan test suite lulus 100%.
- `.env.example` + README dasar (termasuk cara menjalankan server lokal) tersedia untuk setup ulang di mesin lain.
