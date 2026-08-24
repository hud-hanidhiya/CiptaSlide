# QA & Release Checklist — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## Functional & edge case
- [ ] Happy path lolos end-to-end lewat browser (brief di chat → `.pptx` valid, teruji manual di PowerPoint/LibreOffice).
- [ ] Minimal satu giliran revisi lewat chat berhasil (`Deck` berubah sesuai instruksi, `.pptx` baru dihasilkan).
- [ ] Chart `pie`/`doughnut` dengan nilai negatif ditolak, bukan dirender — di giliran initial maupun revisi.
- [ ] `values` chart kosong/nol menghasilkan placeholder eksplisit, bukan chart kosong membingungkan.
- [ ] Repair-loop pulih dari kegagalan schema, dan `throw` jelas setelah 3x gagal (tidak infinite retry) — di giliran initial maupun revisi.
- [ ] `sessionId` tidak dikenal (server baru restart) dibalas error jelas di chat, bukan crash server.

## Data & security
- [ ] Tidak ada API key atau secret hardcoded di kode/commit.
- [ ] API key tidak pernah dikirim ke frontend/browser (cek network tab).
- [ ] `.env` ter-`.gitignore`, `.env.example` cuma berisi placeholder.
- [ ] Server tidak bisa diakses dari perangkat lain di jaringan lokal (hanya `127.0.0.1`).
- [ ] Brief contoh/fixture yang di-commit tidak mengandung data pribadi/privat sensitif (lihat `00-guardrails.md`).

## Engineering standard
- [ ] Lint/type-check bersih.
- [ ] Semua unit test lulus.
- [ ] `validatePptxStructure()` mendeteksi file corrupt sengaja-dirusak (fixture test).
- [ ] Frontend chat berfungsi normal di browser lokal (kirim pesan, lihat balasan + link download, riwayat chat tidak hilang antar-giliran dalam sesi yang sama).
- [ ] Tidak ada pelanggaran guardrail (cek ulang `00-guardrails.md`).
