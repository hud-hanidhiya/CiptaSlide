# Spec — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## Fitur
| # | Fitur | Prioritas (must/nice) | Catatan |
|---|---|---|---|
| 1 | Generate `Deck` (JSON terstruktur) dari brief teks via LLM | must | Kontrak schema lengkap di `04-architecture-notes.md` |
| 2 | Validasi `Deck` terhadap schema, dengan repair-loop otomatis (max 3x) kalau invalid | must | Repair-loop kirim ulang JSON invalid sebagai konteks, bukan generate ulang dari nol |
| 3 | Render `Deck` tervalidasi jadi file `.pptx` (`pptxgenjs`) | must | Satu fungsi renderer per tipe layout |
| 4 | Validasi struktural file `.pptx` hasil render | must | Buka ulang sebagai ZIP, cek file XML inti ada |
| 5 | Provider LLM diganti lewat env var, tanpa ubah kode | must | `API_BASE_URL` + `API_KEY` + `MODEL_NAME` |
| 6 | Server Express: static frontend + endpoint `POST /api/chat` | must | Bind `127.0.0.1` saja; lihat `00-guardrails.md` |
| 7 | Frontend chat sederhana (HTML/CSS/JS polos) — kirim pesan, tampilkan balasan + link download | must | Tanpa framework, tanpa build step |
| 8 | Revisi deck multi-turn — pesan lanjutan di sesi sama mengubah `Deck` terakhir, bukan mulai dari nol | must | Session state in-memory per sesi; kirim `Deck` terakhir + instruksi revisi ke LLM |
| 9 | Mode isi ulang template `.pptx` existing | nice | v2, di luar scope v1 |
| 10 | Visual QA loop lewat vision model | nice | v3, di luar scope v1 |
| 11 | Streaming response (SSE/WebSocket) saat proses generate/revisi | nice | v2, di luar scope v1 — v1 cukup loading indicator |
| 12 | Upload file dokumen (`.docx`/`.pdf`/`.txt`) sebagai sumber brief, bukan cuma teks diketik | nice | v2, di luar scope v1 — lihat `02-scope-brief.md` |

## User flow
1. Operator membuka `http://localhost:...` di browser — melihat tampilan chat kosong.
2. Operator mengetik brief pertama dan mengirimkannya (`POST /api/chat` dengan `sessionId` baru).
3. Server memanggil LLM untuk merencanakan isi deck (JSON terstruktur) — ini giliran **initial**.
4. JSON divalidasi; kalau gagal, otomatis diperbaiki (max 3x percobaan/repair-loop).
5. `Deck` tervalidasi dirender jadi file `.pptx`, lalu divalidasi strukturnya.
6. Server menyimpan `Deck` ini di session state (in-memory), lalu membalas chat dengan ringkasan singkat + link download `.pptx`.
7. Operator bisa mengirim pesan lanjutan (mis. "ganti judul slide 2", "tambah chart penjualan") — ini giliran **revisi**.
8. Server memanggil LLM lagi, kali ini dengan konteks `Deck` terakhir + instruksi revisi (bukan brief awal saja) untuk menghasilkan `Deck` baru.
9. `Deck` baru divalidasi & dirender ulang (langkah 4–6 diulang), menghasilkan file `.pptx` baru dan link download baru di chat.
10. Operator bisa mengulangi langkah 7–9 sebanyak yang diperlukan dalam sesi yang sama, atau mulai sesi baru (refresh/tab baru) untuk brief yang tidak berhubungan.

## Data flow & transisi status (kalau ada)
Tidak ada state machine persisten ke disk/DB (bukan sistem transaksional). Sesi disimpan in-memory selama proses server hidup:

```
Sesi chat (in-memory di server, per sessionId)
  brief pertama (input) → PLANNING (initial) → [retry max 3x jika schema invalid] → RENDERING → VALIDATING → balasan chat + link .pptx
  pesan revisi (input)  → PLANNING (revisi, konteks: Deck terakhir + instruksi) → [retry max 3x] → RENDERING → VALIDATING → balasan chat + link .pptx baru
```

Tidak ada retry policy lintas-sesi — tiap `sessionId` independen. Sesi hilang kalau server di-restart (diterima sebagai batasan tool lokal single-user, lihat `04-architecture-notes.md` §Failure mode).

## Error handling
- **Technical error** (timeout, service down, network issue): network timeout ke LLM API, HTTP 429 (rate limit), response bukan JSON sama sekali → boleh retry otomatis dalam batas repair-loop planner, baik di giliran initial maupun revisi.
- **Business/logic error** (validasi gagal, input tidak valid): brief kosong/terlalu pendek, palette hex tidak valid dari user, jumlah slide diminta melebihi batas (>30) → tidak retry otomatis, langsung dibalas ke chat dengan pesan error jelas (HTTP 4xx dari `/api/chat`, ditampilkan sebagai bubble error di frontend, bukan crash halaman).
- **Session tidak ditemukan/kadaluarsa** (server sudah di-restart sejak sesi dibuat) → `/api/chat` balas error jelas, frontend menyarankan mulai chat baru — bukan retry diam-diam ke `Deck` yang sudah tidak ada.

## Edge case yang harus ditangani
- `ChartBlock` bertipe `pie`/`doughnut` dengan nilai negatif → ditolak sebelum render, baik di giliran initial maupun revisi.
- `values` chart kosong/semua nol → render placeholder eksplisit, bukan chart kosong membingungkan.
- API key kosong/salah → server gagal start / gagal cepat di awal (sebelum memanggil LLM sama sekali), pesan jelas di log server.
- Provider lokal/non-OpenAI yang jauh lebih lambat → timeout eksplisit di client LLM, ditangani sebagai technical error di atas.
- Pesan revisi yang tidak nyambung dengan `Deck` yang ada (mis. minta ubah "slide 10" padahal deck cuma 5 slide) → LLM diberi konteks jumlah slide aktual di system/repair prompt; kalau tetap invalid, masuk jalur repair-loop biasa.
- Operator mengirim pesan revisi sebelum giliran sebelumnya selesai diproses → frontend menonaktifkan input sampai balasan sebelumnya datang (hindari race condition di session state yang sama).

## Acceptance criteria (Given/When/Then)

**AC-01 (Happy path — generate awal)**
- Given: brief teks valid dan API key benar
- When: operator mengirim brief pertama lewat chat di browser
- Then: chat membalas dengan ringkasan + link `.pptx` yang lolos validasi struktural dan terbuka tanpa error di PowerPoint/LibreOffice

**AC-02 (Error path — schema invalid dari LLM)**
- Given: LLM mengembalikan JSON tidak sesuai schema pada percobaan pertama (initial atau revisi)
- When: repair-loop dijalankan
- Then: setelah maksimal 3 percobaan gagal, `/api/chat` balas HTTP error dengan pesan jelas (bukan stack trace mentah), ditampilkan sebagai bubble error di chat

**AC-03 (Edge case — chart dengan nilai negatif pada pie chart)**
- Given: `Deck` berisi `ChartBlock` bertipe `pie` dengan salah satu `values` negatif
- When: validasi pre-render dijalankan
- Then: slide tersebut ditolak dengan pesan eksplisit, bukan dirender jadi chart yang misleading

**AC-04 (Happy path — revisi multi-turn)**
- Given: sesi chat sudah punya `Deck` valid dari giliran sebelumnya
- When: operator mengirim pesan revisi (mis. "ganti warna tema jadi biru") di sesi yang sama
- Then: `Deck` baru dihasilkan berdasarkan `Deck` lama + instruksi, lolos validasi, dirender jadi file `.pptx` baru, dan link download baru muncul di chat tanpa menghapus riwayat percakapan sebelumnya

## Pertanyaan terbuka
- Berapa lama sesi in-memory boleh "hidup" sebelum dianggap kadaluarsa (kalau server jalan lama tanpa restart) — perlu TTL sederhana, atau cukup hidup selama server hidup?
- Riwayat chat yang ditampilkan ke operator di frontend perlu disimpan penuh, atau cukup `Deck` versi terakhir + daftar ringkas instruksi revisi yang pernah diberikan?
- Kalau nanti butuh mode template (v2), apakah overwrite file existing perlu guard eksplisit di UI (bukan lagi flag `--force` seperti versi CLI)?
