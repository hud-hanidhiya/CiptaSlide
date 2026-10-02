# HTML -> PPTX - Architecture Notes

Dokumen ini menjelaskan **conversion engine** HTML->PPTX yang menjadi fitur utama
CiptaSlide. Pipeline deck-LLM yang sudah ada (docs/03, docs/04) tetap utuh; engine
baru adalah jalur kedua yang tidak butuh LLM sama sekali.

## Prinsip arsitektur

> **Bukan screenshot-sebagai-mekanisme-utama.**

Urutannya:

```
HTML
 ->
Sanitizer + Parser (whitelist)          src/html/sanitize.ts
 ->
DOM + CSS -> Computed Style (cascade)    src/css/cascade.ts
 ->
Layout Engine -> LayoutBox (px)          src/layout/layoutEngine.ts
 ->
Intermediate Representation (IR)        src/shared/ir.ts
 ->
PPTX Writer (pptxgenjs)                 src/render/htmlPptxWriter.ts
 ->
presentation.pptx  +  ConversionReport
```

Teks, tabel, gambar, shape, dan garis menjadi **objek PowerPoint yang editable**.
Raster hanya dipakai sebagai *fallback* untuk subtree yang ditandai
`data-pptx-as-image`, bukan sebagai jalur utama.

Alasan memilih IR di tengah: golden-file test bisa menguji IR tanpa pptxgenjs,
`convert`/`preview`/`validate` berbagi pipeline yang identik, dan writer PPTX
menjadi fungsi murni dari IR.

## Kontrak koordinat

| Lapisan | Satuan | Catatan |
|---|---|---|
| CSS | px | input pengguna |
| Cascade | px | semua relative unit sudah diresolusi |
| Layout (`LayoutBox`) | px | `x`/`y` relatif terhadap **border-box origin** parent |
| IR (`SlideElement.box`) | px absolut | relatif ke kiri-atas slide |
| PPTX | inch / point | konversi **sekali** di `htmlPptxWriter.ts` |

`96 px = 1 inch`. Konversi hanya boleh terjadi di satu tempat agar batas satuan
bisa diaudit; itulah alasan `pxToInch` tidak pernah dipanggil di luar writer.

## Kontrak koordinat turunan

`LayoutBox.x` adalah offset terhadap **border-box origin** parent - bukan
content-box origin.

Layout engine menaruh setiap anak di **padding edge** parent, jadi `child.x`
sudah memuat padding dan border parent. Setiap pembaca koordinat
(`mapSlideElements` dan `absoluteBoxOf`) karena itu cukup menjumlahkan
offset-offset itu apa adanya:

```text
absolute(child) = absolute(parent) + child.x
```

Menambahkan `borderLeft + paddingLeft` lagi di titik mana pun akan menggeser
setiap subtree ber-padding dua kali lipat. Ini pernah jadi bug nyata yang
tertangkap golden test.

Aturan ini diimplementasikan di `mapSlideElements` dan `absoluteBoxOf`, dan
diuji di `tests/layout.test.ts`.

## Layout engine: subset yang diimplementasikan

| Fitur | Status | Catatan |
|---|---|---|
| Block flow + margin collapsing | YA | collapse = max(dua margin) |
| Inline formatting context | YA | line box packing, baseline diasumsikan 0.8em |
| Flex row/column, gap, justify/align | YA | item diukur max-content lalu grow/shrink |
| `flex-wrap` | YA | multi-line flow |
| Table | YA sederhana | lebar eksplisit menang, sisa dibagi rata |
| `position: absolute/relative` | YA | inset diukur terhadap slide |
| `box-sizing` | YA | content-box dan border-box |
| CSS Grid | TIDAK | warning + fallback ke block flow |
| Inline-block on its own line | TIDAK | lihat "Keterbatasan" |
| Float | TIDAK | warning |
| `text-overflow: ellipsis` | parsial | hanya di sel tabel |

Yang **tidak** ada: web fonts, CSS custom property bertingkat, `@media` query
dievaluasi, `float`, `transform`, `animation`, `filter`, `clip-path`.

Semua properti di luar daftar itu menghasilkan **diagnostic** (`level: warning`),
bukan diam-diam diabaikan - ini memetakan langsung ke blok report di PRD bagian23.

## Catatan implementasi pptxgenjs

Tiga hal di library `pptxgenjs` yang tidak intuitif dan sudah ditangani di
`htmlPptxWriter.ts`. Semuanya ditemukan lewat inspeksi XML, bukan dari dokumentasi.

1. **`bullet.type` hanya mengenal `"number"`.** Cabang `typeof bullet === "object"`
   di library hanya menulis `<a:buChar>` pada cabang `else if`, yaitu ketika
   `type` **tidak** diisi. Jadi `{ type: "bullet", characterCode }` menghasilkan
   bullet kosong tanpa error. Glyph bullet harus `{ characterCode }` saja.
2. **`characterCode` harus hex 4 digit.** Nilainya divalidasi library dengan
   `/^[0-9A-Fa-f]{4}$/`, lalu ditulis sebagai `&#xNNNN;`. Glyph aslinanya
   ditolak, jadi `hexCodePoint()` mengonversinya lebih dulu.
3. **`bullet` harus pada run yang membawa teks,** bukan pada run kosong terpisah.
   Run kosong tidak menghasilkan `<a:buChar>` sama sekali.

Nomor list memakai `{ type: "number", numberStartAt }`; `startAt` masih
disediakan library tapi sudah deprecated.

#