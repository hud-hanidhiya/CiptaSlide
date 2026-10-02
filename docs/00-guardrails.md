# Project Guardrails — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## Risk Trigger (hal-hal yang mahal/memalukan kalau salah)
- [x] Data privat/sensitif terkirim ke pihak ketiga eksternal (LLM API) — brief teks & pesan revisi dikirim ke provider LLM manapun yang dikonfigurasi.
- [x] Biaya API tak terkendali — repair-loop dan tiap giliran revisi chat bisa boros token tanpa disadari kalau tidak dibatasi.
- [x] Output dilaporkan "sukses" padahal file `.pptx` sebenarnya corrupt/tidak bisa dibuka.
- [x] HTML dari luar tidak dipercaya untuk dieksekusi — jalur HTML->PPTX menerima markup dari pengguna; kalau markup itu diperlakukan sebagai DOM hidup, ini menjadi sink XSS dan vektor SSRF.
- [ ] Uang / kalkulasi finansial — tidak relevan, proyek ini tidak melakukan kalkulasi finansial apa pun.
- [ ] Transisi status yang sulit dibalik — tidak relevan, tiap revisi cuma mengganti `Deck` di sesi in-memory + file `.pptx` di disk, tidak ada state yang "sulit dibalik" (revisi berikutnya bisa menimpa lagi).
- [ ] Perubahan skema database atau kontrak API publik — tidak relevan, tidak ada database, dan server ini tidak mempublikasikan API ke luar (cuma dipakai frontend lokalnya sendiri).
- [ ] Auth / permission / data user multi-pihak — tidak relevan secara fungsional (single-user, tidak ada sistem akun), **tapi** karena sekarang jalan sebagai web server, wajib bind ke `127.0.0.1` saja (localhost), bukan `0.0.0.0` — supaya tidak diam-diam bisa diakses dari perangkat lain di jaringan yang sama tanpa auth.

## Aturan untuk tiap trigger yang dicentang di atas

**Data privat terkirim ke pihak ketiga eksternal**
- Brief/pesan chat yang dikirim ke LLM API tidak boleh berisi data pribadi/privat sensitif (identitas, kontak, dokumen rahasia, dsb.).
- Review manual brief sebelum dikirim, terutama untuk brief yang diambil dari sumber lain (copy-paste dari dokumen lain).
- API key hanya lewat `.env` lokal di server, wajib masuk `.gitignore`, tidak pernah hardcode di kode/commit, dan **tidak pernah dikirim ke frontend/browser** (frontend cuma bicara ke server sendiri via `/api/*`, bukan ke LLM API langsung).

**Biaya API tak terkendali**
- Repair-loop planner dibatasi maksimal 3 percobaan per giliran (initial maupun revisi) — tidak boleh retry tanpa batas.
- Set `max_tokens`/batas response eksplisit di tiap request LLM.
- Log jumlah token per-giliran chat (kalau tersedia dari response provider) untuk pemantauan biaya.
- Revisi multi-turn mengirim `Deck` terakhir + instruksi revisi sebagai konteks (bukan riwayat chat penuh mentah-mentah) supaya payload tidak membengkak tak terkendali seiring panjangnya percakapan.

**HTML dari luar tidak dipercaya untuk dieksekusi** (conversion engine, docs/10)
- Sanitizer bersifat **whitelist**, bukan blacklist: tag di luar daftar putih dihapus, bukan "dibiarkan kalau aman". Tag dengan risiko (`script`, `iframe`, `object`, `embed`, `form`, `link`, `meta`) kehilangan seluruh subtrenya.
- Atribut `on*` dan `srcset` selalu dibuang. Atribut URL (`href`, `src`) wajib lolos `isSafeUrl`, yang menolak `javascript:`, `vbscript:`, `data:text/html`, `data:image/svg+xml`, dan `file:`, termasuk setelah karakter kontrol dibuang (menutup `java\nscript:`).
- `<style>` tetap didukung, tapi `@import`, `expression()`, dan `url(javascript:)` dinetralkan sebelum CSS dikompilasi.
- Jalur konversi **tidak pernah** memanggil `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`eval`. Pratinjau di browser memakai `<iframe sandbox="">` + `srcdoc`, yang mematikan seluruh script.
- Gambar `http(s):` **mati secara default** (`allowRemoteImages: false`) karena vektor SSRF; ketika diaktifkan ada batas ukuran (5 MiB) dan timeout (5 detik).
- Body JSON dibatasi 40 MB, HTML dipotong pada 500k karakter, dan jumlah slide dibatasi 200 - supaya satu request tidak bisa membuat server kehabisan memori.
- Bukti: `tests/sanitize.test.ts` (payload XSS/SSRF), `tests/pipeline.test.ts` (batas input, image remote mati secara default).

**Output dilaporkan sukses padahal corrupt**
- Setiap `Deck` hasil LLM (initial maupun hasil revisi) wajib lolos `Deck.safeParse()` (Zod) sebelum dirender — tidak ada jalur render yang melewati validasi ini.
- Setiap file `.pptx` hasil render wajib lolos `validatePptxStructure()` sebelum server mengirim link download ke chat — "tidak ada exception saat render" bukan bukti valid.
- Chart dengan nilai negatif pada tipe `pie`/`doughnut` ditolak di validasi, bukan dirender apa adanya (bisa menyesatkan meski filenya "valid" secara struktur).

## Verification hooks
- Lint rule / static check: type-check TypeScript (`tsc --noEmit`) menangkap mismatch kontrak `Deck` antar-stage.
- Coverage test minimum: setiap risk trigger di atas wajib punya minimal satu unit test yang membuktikan guardrail-nya aktif (lihat detail test di `04a-implementation-plan.md` §5 dan `06-task-plan.md`).
