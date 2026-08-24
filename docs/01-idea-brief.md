# Idea / Problem Brief — CiptaSlide — Dari ide menjadi presentasi. AI PPTX Generator (Web App)

## Ini apa?
Web app pribadi (jalan lokal di browser, `http://localhost:...`) dengan frontend bergaya chat AI, yang mengubah brief teks jadi file `.pptx` siap pakai. Backend TypeScript memakai LLM (API apa saja yang OpenAI-compatible) untuk merencanakan isi lewat percakapan, dan renderer deterministik (`pptxgenjs`) untuk menghasilkan filenya. Chat-nya multi-turn — setelah deck pertama jadi, bisa minta revisi lewat pesan lanjutan tanpa mulai dari nol.

## Kenapa dibangun
Butuh cara cepat bikin deck presentasi dari ide/brief singkat tanpa kerja manual berulang, dan tanpa terikat ke satu fitur chat AI tertentu — ingin tool yang bebas ganti provider LLM sesuai kebutuhan biaya/kualitas. Dipilih bentuk web chat (bukan CLI) supaya prosesnya terasa seperti mengobrol dengan asisten yang bikin slide — brief awal, lihat hasil, minta revisi, sampai puas — tanpa perlu mengetik ulang command tiap kali mau mengubah sesuatu.

## Untuk siapa
Cuma untuk diri sendiri, dijalankan lokal di mesin sendiri lewat browser.

## "Berhasil" itu seperti apa
Buka `http://localhost:...` di browser, ketik brief di chat, dapat balasan berisi ringkasan + link download `.pptx` yang terbuka mulus di PowerPoint/LibreOffice tanpa perlu "repair". Bisa kirim pesan lanjutan ("ganti warna jadi biru", "tambah slide penutup") dan dapat file `.pptx` baru yang mencerminkan revisi itu, dalam sesi chat yang sama.

## Trigger / urgensi
Tidak ada tenggat eksternal — inisiatif personal untuk mengurangi kerja repetitif bikin deck manual.

## Evidence (kalau ini fix bug)
N/A — ini pengembangan tool baru, bukan perbaikan bug.

## Estimasi waktu
Kasar: MVP (schema + render dasar + server + frontend chat sederhana) sekitar 5–7 hari kerja santai, bukan proyek full-time — sedikit lebih lama dari versi CLI karena ada frontend dan session/multi-turn.
