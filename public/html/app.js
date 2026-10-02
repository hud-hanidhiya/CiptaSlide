"use strict";

/**
 * Workbench HTML -> PPTX (PRD section 17).
 *
 * - ES2020 polos, tanpa framework dan tanpa build step; dilayani statis dari /public.
 * - Pratinjau dirender di iframe `sandbox=""`: script, form, navigasi top-level, dan
 *   popup dimatikan, jadi HTML pengguna hanya bisa menghasilkan piksel.
 * - Semua string dari pengguna masuk DOM lewat textContent/value/setAttribute.
 *   Tidak ada sink HTML mentah di berkas ini.
 */

const API_BASE = "/api/v1";
const STORAGE_PREFIX = "ciptaslide.html2pptx.";
const PREVIEW_DEBOUNCE_MS = 350;
const PERSIST_DEBOUNCE_MS = 500;
const CSS_PX_PER_INCH = 96;

/** Ukuran preset dalam inci — cermin FORMAT_SIZES di src/convert/options.ts. */
const FORMAT_SIZES_INCH = {
  "16:9": { widthInch: 13.333, heightInch: 7.5 },
  "4:3": { widthInch: 10, heightInch: 7.5 },
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Template bawaan. Isinya hanya pernah masuk ke iframe lewat `srcdoc`,
 * tidak pernah ke DOM halaman ini.
 */
const TEMPLATES = {
  simple: {
    label: "Simple",
    html: [
      "<style>",
      "h1 {",
      "  font-size: 44px;",
      "  margin: 0 0 16px;",
      "}",
      "",
      "p {",
      "  font-size: 20px;",
      "  color: #4a5568;",
      "  line-height: 1.5;",
      "}",
      "</style>",
      "",
      '<h1 data-pptx-font-size="44">Judul Presentasi</h1>',
      "<p>Paragraf pembuka yang menjelaskan isi deck. Edit HTML di panel kiri,",
      "lalu tekan <strong>Convert to PPTX</strong>.</p>",
    ].join("\n"),
  },

  twoSlides: {
    label: "Two Slides",
    html: [
      "<style>",
      "section[data-slide] h2 {",
      "  font-size: 40px;",
      "  margin: 0 0 18px;",
      "}",
      "",
      "section[data-slide] ul {",
      "  font-size: 22px;",
      "  margin: 0;",
      "  padding-left: 28px;",
      "}",
      "",
      "section[data-slide] li {",
      "  margin-bottom: 10px;",
      "}",
      "",
      "section[data-slide] p {",
      "  font-size: 20px;",
      "  color: #4a5568;",
      "}",
      "</style>",
      "",
      '<section data-slide data-slide-background="#FFFFFF">',
      "  <h2>Dua Slide</h2>",
      "  <ul>",
      "    <li>Setiap <code>&lt;section data-slide&gt;</code> menjadi satu slide.</li>",
      "    <li>Gunakan tombol nomor di bawah preview untuk berpindah slide.</li>",
      "  </ul>",
      "</section>",
      "",
      '<section data-slide data-slide-background="#F3F6FB">',
      "  <h2>Slide Kedua</h2>",
      "  <p data-pptx-color=\"#4A5568\">Background per slide ditulis lewat",
      "  <code>data-slide-background</code>, atau lewat panel Background di bawah.</p>",
      "</section>",
    ].join("\n"),
  },

  cards: {
    label: "Cards",
    html: [
      "<style>",
      ".cards {",
      "  display: flex;",
      "  gap: 24px;",
      "}",
      "",
      ".card {",
      "  flex: 1;",
      "  background: #f3f6fb;",
      "  border-radius: 12px;",
      "  padding: 24px;",
      "}",
      "",
      ".card h3 {",
      "  font-size: 26px;",
      "  margin: 0 0 12px;",
      "  color: #1f3b73;",
      "}",
      "",
      ".card p {",
      "  font-size: 17px;",
      "  margin: 0 0 8px;",
      "  color: #4a5568;",
      "}",
      "</style>",
      "",
      '<h1 style="font-size: 40px; margin: 0 0 28px;">Tiga Kartu</h1>',
      '<div class="cards">',
      '  <div class="card" data-pptx-background="#F3F6FB" data-pptx-shape="roundRect">',
      "    <h3>Editable</h3>",
      "    <p>Teks menjadi objek PowerPoint asli — masih bisa diedit.</p>",
      "  </div>",
      '  <div class="card" data-pptx-background="#E8F3EC" data-pptx-shape="roundRect">',
      "    <h3>Pixel</h3>",
      "    <p>Subtree diratakan menjadi satu gambar, dengan fidelity layout tinggi.</p>",
      "  </div>",
      '  <div class="card" data-pptx-background="#FBF3E4" data-pptx-shape="roundRect">',
      "    <h3>Catatan</h3>",
      "    <p>Elemen di bawah ini dilewati mesin konversi.</p>",
      '    <p data-pptx-ignore="true">Diabaikan (data-pptx-ignore).</p>',
      "  </div>",
      "</div>",
    ].join("\n"),
  },

  data: {
    label: "Data",
    html: [
      "<style>",
      "table {",
      "  width: 100%;",
      "  border-collapse: collapse;",
      "  font-size: 18px;",
      "}",
      "",
      "thead th {",
      "  background: #1f3b73;",
      "  color: #ffffff;",
      "  padding: 10px;",
      "  text-align: left;",
      "}",
      "",
      "tbody td {",
      "  border-bottom: 1px solid #d7dee8;",
      "  padding: 10px;",
      "}",
      "",
      "ul {",
      "  font-size: 20px;",
      "}",
      "</style>",
      "",
      '<h1 style="font-size: 36px; margin: 0 0 20px;">Data &amp; Daftar</h1>',
      "<ul>",
      "  <li>Daftar bullet dikonversi menjadi bullet PowerPoint.</li>",
      "  <li>Tabel dengan <code>&lt;thead&gt;</code> + <code>&lt;tbody&gt;</code> jadi objek tabel.</li>",
      "</ul>",
      "<table>",
      "  <thead>",
      "    <tr><th>Quarter</th><th>Revenue</th><th>Growth</th></tr>",
      "  </thead>",
      "  <tbody>",
      '    <tr><td>Q1</td><td>Rp 1,2 M</td><td>+12%</td></tr>',
      '    <tr><td>Q2</td><td>Rp 1,5 M</td><td>+25%</td></tr>',
      '    <tr><td>Q3</td><td>Rp 1,4 M</td><td>-6%</td></tr>',
      "  </tbody>",
      "</table>",
    ].join("\n"),
  },
};

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} tidak ditemukan.`);
  return el;
}

const ui = {
  editor: /** @type {HTMLTextAreaElement} */ (byId("html-input")),
  clearBtn: /** @type {HTMLButtonElement} */ (byId("clear-btn")),
  tabPreview: /** @type {HTMLButtonElement} */ (byId("tab-preview")),
  tabReport: /** @type {HTMLButtonElement} */ (byId("tab-report")),
  paneMeta: /** @type {HTMLElement} */ (byId("pane-meta")),
  panelPreview: /** @type {HTMLElement} */ (byId("panel-preview")),
  panelReport: /** @type {HTMLElement} */ (byId("panel-report")),
  stage: /** @type {HTMLElement} */ (byId("stage")),
  stageFit: /** @type {HTMLElement} */ (byId("stage-fit")),
  stageEmpty: /** @type {HTMLElement} */ (byId("stage-empty")),
  frame: /** @type {HTMLIFrameElement} */ (byId("preview-frame")),
  switcher: /** @type {HTMLElement} */ (byId("slide-switcher")),
  sizeLabel: /** @type {HTMLElement} */ (byId("size-label")),
  modeChip: /** @type {HTMLElement} */ (byId("mode-chip")),
  durationChip: /** @type {HTMLElement} */ (byId("duration-chip")),
  statusChip: /** @type {HTMLElement} */ (byId("status-chip")),
  diagnostics: /** @type {HTMLElement} */ (byId("diagnostics")),
  bgColor: /** @type {HTMLInputElement} */ (byId("bg-color")),
  customWidth: /** @type {HTMLInputElement} */ (byId("custom-width")),
  customHeight: /** @type {HTMLInputElement} */ (byId("custom-height")),
  fontFamily: /** @type {HTMLSelectElement} */ (byId("font-family")),
  validateBtn: /** @type {HTMLButtonElement} */ (byId("validate-btn")),
  convertBtn: /** @type {HTMLButtonElement} */ (byId("convert-btn")),
  downloadLink: /** @type {HTMLAnchorElement} */ (byId("download-link")),
  downloadLabel: /** @type {HTMLElement} */ (byId("download-label")),
  statusLine: /** @type {HTMLElement} */ (byId("status-line")),
};

/** Ids elemen stats, dipetakan ke key stats API. */
const STAT_CELLS = {
  slides: byId("stat-slides"),
  elements: byId("stat-elements"),
  converted: byId("stat-converted"),
  fallback: byId("stat-fallback"),
  warnings: byId("stat-warnings"),
  errors: byId("stat-errors"),
};

/** Monoton naik; respons dengan seq lama dibuang (out-of-order / race). */
let previewSeq = 0;
let previewTimer = 0;
let persistTimer = 0;
let convertBusy = false;
let slideCount = 0;
let activeSlide = 0;
let slideWidthPx = 1279.968;
let slideHeightPx = 720;

/* ---------------------------------------------------------------- state I/O */

function storageGet(key) {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch (err) {
    // Private mode / storage diblokir: jalankan tanpa persistensi.
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch (err) {
    /* Kuota penuh atau storage diblokir — bukan kondisi fatal. */
  }
}

/**
 * @param {string} name Nama radio group.
 * @returns {string} Nilai radio yang terpilih.
 */
function radioValue(name) {
  const checked = /** @type {HTMLInputElement | null} */ (
    document.querySelector(`input[name="${name}"]:checked`)
  );
  return checked ? checked.value : "";
}

/**
 * @param {string} name Nama radio group.
 * @param {string} value Nilai yang mau dipilih.
 */
function setRadio(name, value) {
  const inputs = document.querySelectorAll(`input[name="${name}"]`);
  for (const input of inputs) {
    input.checked = input.value === value;
  }
}

/** @returns {string} Background tervalidasi `#rrggbb`. */
function currentBackground() {
  return HEX_COLOR.test(ui.bgColor.value) ? ui.bgColor.value.toLowerCase() : "#ffffff";
}

/**
 * Ukuran slide aktif dalam CSS px, dihitung lokal supaya iframe langsung ikut
 * resize saat setting berubah — tanpa menunggu balasan API.
 *
 * @returns {{widthInch: number, heightInch: number}}
 */
function currentSizeInch() {
  const format = radioValue("format");
  if (format === "custom") {
    const widthInch = Number(ui.customWidth.value);
    const heightInch = Number(ui.customHeight.value);
    if (Number.isFinite(widthInch) && widthInch > 0 && Number.isFinite(heightInch) && heightInch > 0) {
      return { widthInch, heightInch };
    }
    // Server memakai 16:9 kalau customSize tidak valid.
  }
  const preset = FORMAT_SIZES_INCH[format === "4:3" ? "4:3" : "16:9"];
  return { widthInch: preset.widthInch, heightInch: preset.heightInch };
}

/** Body request untuk validate/preview/convert. */
function requestBody() {
  const format = radioValue("format");
  /** @type {Record<string, unknown>} */
  const options = {
    format: format === "" ? "16:9" : format,
    background: currentBackground(),
    defaultFontFamily: ui.fontFamily.value,
    mode: radioValue("mode") || "editable",
  };

  if (options.format === "custom") {
    const { widthInch, heightInch } = currentSizeInch();
    if (Number.isFinite(widthInch) && Number.isFinite(heightInch)) {
      options.customSize = { widthInch, heightInch };
    }
  }

  return { html: ui.editor.value, options };
}

/* ------------------------------------------------------------------- preview */

/**
 * Bangun dokumen pratinjau. Wrapper slide disimpan di dalam `srcdoc` supaya
 * HTML pengguna tidak pernah masuk ke DOM halaman ini.
 *
 * @param {string} html HTML pengguna.
 * @param {string} background Warna background slide.
 * @returns {string} Dokumen HTML lengkap untuk iframe.
 */
function buildSrcdoc(html, background) {
  const width = Math.round(slideWidthPx * 100) / 100;
  const height = Math.round(slideHeightPx * 100) / 100;
  // Setiap section[data-slide] dipaksa setinggi satu slide, jadi offset slide
  // aktif cuma indeks dikali tinggi slide.
  const offset = Math.round(activeSlide * height * 100) / 100;

  // Base sheet ditulis lebih dulu: <style> pengguna menang pada spesifisitas sama.
  return [
    '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><style>',
    "html,body{margin:0;padding:0;}",
    ".wb-viewport{position:relative;overflow:hidden;",
    `width:${width}px;height:${height}px;}`,
    `.wb-track{position:relative;width:${width}px;transform:translateY(-${offset}px);}`,
    `section[data-slide]{width:${width}px;height:${height}px;overflow:hidden;}`,
    "</style></head>",
    `<body style="background:${background};color:#1A1A1A;">`,
    '<div class="wb-viewport"><div class="wb-track">',
    html,
    "</div></div></body></html>",
  ].join("");
}

function renderFrame() {
  const html = ui.editor.value;
  if (html.trim() === "") {
    ui.stageFit.hidden = true;
    ui.stageEmpty.hidden = false;
    ui.stageEmpty.textContent = "Preview muncul setelah HTML diisi.";
    ui.switcher.hidden = true;
    ui.sizeLabel.textContent = "—";
    return;
  }

  ui.stageEmpty.hidden = true;
  ui.stageFit.hidden = false;

  const background = currentBackground();
  ui.frame.style.background = background;
  // Diulang tiap render: srcdoc tanpa sandbox kosong tetap tidak bisa menjalankan script.
  ui.frame.setAttribute("sandbox", "");
  ui.frame.setAttribute("referrerpolicy", "no-referrer");
  ui.frame.setAttribute("srcdoc", buildSrcdoc(html, background));
}

/** Skala preview mengikuti ukuran pane; transform tidak mengubah layout flow. */
function fitFrame() {
  const box = ui.stage.getBoundingClientRect();
  const padding = 24; // padding .wb-stage 12px per sisi
  const availableWidth = box.width - padding;
  const availableHeight = box.height - padding;
  // Pane disembunyikan saat tab Report aktif; selectTab() menghitung ulang saat dikembalikan.
  if (availableWidth <= 0 || availableHeight <= 0) return;

  // Tidak diperbesar di atas 1:1 supaya teks tetap tajam di layar kecil.
  const scale = Math.min(availableWidth / slideWidthPx, availableHeight / slideHeightPx, 1);
  ui.stageFit.style.width = `${slideWidthPx}px`;
  ui.stageFit.style.height = `${slideHeightPx}px`;
  ui.stageFit.style.transform = `scale(${scale})`;
}

function renderSwitcher() {
  ui.switcher.replaceChildren();
  if (slideCount <= 1) {
    ui.switcher.hidden = true;
    return;
  }

  ui.switcher.hidden = false;
  for (let index = 0; index < slideCount; index += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wb-switcher-btn";
    button.textContent = String(index + 1);
    button.setAttribute("aria-current", index === activeSlide ? "true" : "false");
    button.addEventListener("click", () => {
      activeSlide = index;
      renderSwitcher();
      renderFrame();
    });
    ui.switcher.appendChild(button);
  }
}

/** @param {string} message Pesan yang ditampilkan di area preview. */
function showFrameError(message) {
  ui.stageFit.hidden = true;
  ui.stageEmpty.hidden = false;
  ui.stageEmpty.textContent = message;
}

/* -------------------------------------------------------------------- report */

/**
 * @param {string} level Level diagnostic dari server.
 * @param {string} stage Tahap pipeline.
 * @param {string} message Pesan.
 * @param {{property?: string, element?: string, slideIndex?: number}} extra Konteks.
 */
function appendDiagnostic(level, stage, message, extra) {
  const levelName = level === "error" || level === "warning" || level === "info" ? level : "info";

  const item = document.createElement("li");
  item.className = `wb-diag ${levelName}`;

  const badge = document.createElement("span");
  badge.className = "wb-diag-badge";
  badge.textContent = levelName;
  item.appendChild(badge);

  const stageEl = document.createElement("span");
  stageEl.className = "wb-diag-badge";
  stageEl.textContent = String(stage || "—");
  item.appendChild(stageEl);

  const text = document.createElement("span");
  text.className = "wb-diag-msg";
  text.textContent = String(message || "");
  item.appendChild(text);

  const metaParts = [];
  if (extra && typeof extra.property === "string" && extra.property !== "") {
    metaParts.push(`property: ${extra.property}`);
  }
  if (extra && typeof extra.element === "string" && extra.element !== "") {
    metaParts.push(`element: <${extra.element}>`);
  }
  if (extra && Number.isFinite(extra.slideIndex)) {
    metaParts.push(`slide ${Number(extra.slideIndex) + 1}`);
  }
  if (metaParts.length > 0) {
    const meta = document.createElement("span");
    meta.className = "wb-diag-meta";
    meta.textContent = metaParts.join(" · ");
    item.appendChild(meta);
  }

  ui.diagnostics.appendChild(item);
}

/**
 * @param {Record<string, unknown> | null | undefined} stats Statistik dari API.
 * @param {unknown} diagnostics Daftar diagnostic dari API.
 * @param {{text: string, kind: "ok" | "warn" | "error", durationMs?: unknown}} status
 */
function renderReport(stats, diagnostics, status) {
  /** @type {Record<string, number>} */
  const source = stats && typeof stats === "object" ? stats : {};

  for (const key of Object.keys(STAT_CELLS)) {
    const value = Number(source[key]);
    const cell = STAT_CELLS[key];
    cell.textContent = Number.isFinite(value) ? String(value) : "0";
  }

  const errors = Number(source.errors) || 0;
  ui.panelReport.classList.toggle("is-failed", errors > 0);

  ui.modeChip.textContent = `mode: ${radioValue("mode") || "editable"}`;
  ui.durationChip.textContent = Number.isFinite(Number(status.durationMs))
    ? `${Number(status.durationMs)} ms`
    : "—";

  ui.statusChip.textContent = status.text;
  ui.statusChip.className =
    status.kind === "" ? "wb-chip" : `wb-chip is-${status.kind === "ok" ? "ok" : status.kind}`;

  ui.diagnostics.replaceChildren();
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length === 0) {
    const empty = document.createElement("li");
    empty.className = "wb-diag-empty";
    empty.textContent = "Tidak ada diagnostic.";
    ui.diagnostics.appendChild(empty);
    return;
  }

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const diagnostic = /** @type {Record<string, unknown>} */ (entry);
    appendDiagnostic(
      String(diagnostic.level),
      String(diagnostic.stage),
      String(diagnostic.message),
      {
        property: /** @type {string | undefined} */ (diagnostic.property),
        element: /** @type {string | undefined} */ (diagnostic.element),
        slideIndex: /** @type {number | undefined} */ (diagnostic.slideIndex),
      },
    );
  }
}

/* ---------------------------------------------------------------------- tabs */

/** @param {"preview" | "report"} name Tab yang mau aktif. */
function selectTab(name) {
  const showPreview = name === "preview";
  ui.tabPreview.setAttribute("aria-selected", showPreview ? "true" : "false");
  ui.tabReport.setAttribute("aria-selected", showPreview ? "false" : "true");
  ui.panelPreview.hidden = !showPreview;
  ui.panelReport.hidden = showPreview;
  if (showPreview) fitFrame();
}

/** @param {string} text @param {"ok" | "warn" | "error" | ""} [kind] */
function setStatus(text, kind) {
  ui.statusLine.textContent = text;
  ui.statusLine.className = kind ? `wb-status is-${kind}` : "wb-status";
}

/* ----------------------------------------------------------------------- api */

/**
 * @param {string} path Path relatif terhadap /api/v1.
 * @param {unknown} body Body JSON.
 * @returns {Promise<Record<string, unknown>>} Payload JSON.
 */
async function postJson(path, body) {
  const response = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload.message === "string" && payload.message !== ""
        ? payload.message
        : `Permintaan gagal (HTTP ${response.status}).`;
    throw new Error(message);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Respons server tidak bisa dibaca.");
  }
  return /** @type {Record<string, unknown>} */ (payload);
}

/** @param {Record<string, unknown>} data Payload /preview. */
function applyPreview(data) {
  const slides = Array.isArray(data.slides) ? data.slides : [];
  slideCount = slides.length;

  const widthPx = Number(data.slideWidthPx);
  const heightPx = Number(data.slideHeightPx);
  if (Number.isFinite(widthPx) && widthPx > 0) slideWidthPx = widthPx;
  if (Number.isFinite(heightPx) && heightPx > 0) slideHeightPx = heightPx;

  if (activeSlide > slideCount - 1) activeSlide = Math.max(0, slideCount - 1);

  const widthInch = Number(data.slideWidthInch);
  const heightInch = Number(data.slideHeightInch);
  ui.sizeLabel.textContent =
    `${Math.round(slideWidthPx)} × ${Math.round(slideHeightPx)} px` +
    (Number.isFinite(widthInch) && Number.isFinite(heightInch) ? ` · ${widthInch} × ${heightInch} in` : "");

  renderSwitcher();
  renderFrame();
  fitFrame();

  renderReport(data.report, data.diagnostics, {
    text: slideCount > 0 ? "preview ok" : "tidak ada slide",
    kind: slideCount > 0 ? "ok" : "warn",
  });
}

async function refreshPreview() {
  if (ui.editor.value.trim() === "") {
    previewSeq += 1;
    renderFrame();
    return;
  }

  const seq = ++previewSeq;
  ui.paneMeta.textContent = "preview…";
  try {
    const data = await postJson("/preview", requestBody());
    if (seq !== previewSeq) return; // ada request yang lebih baru: buang respons basi
    applyPreview(data);
    ui.paneMeta.textContent = `${slideCount} slide`;
  } catch (err) {
    if (seq !== previewSeq) return;
    ui.paneMeta.textContent = "preview gagal";
    setStatus(err instanceof Error ? err.message : String(err), "error");
    showFrameError(err instanceof Error ? err.message : String(err));
  }
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = 0;
    void refreshPreview();
  }, PREVIEW_DEBOUNCE_MS);
}

async function runValidate() {
  if (ui.editor.value.trim() === "") {
    setStatus("Isi HTML dulu sebelum validasi.", "error");
    return;
  }

  ui.validateBtn.disabled = true;
  ui.paneMeta.textContent = "validasi…";
  try {
    const data = await postJson("/validate", requestBody());
    const stats = /** @type {Record<string, unknown> | null} */ (data.stats);
    const valid = data.valid === true;
    renderReport(stats, data.warnings, {
      text: valid ? "valid" : "tidak valid",
      kind: valid ? "ok" : "error",
      durationMs: data.durationMs,
    });
    ui.paneMeta.textContent = "siap";
    selectTab("report");
    setStatus(valid ? "HTML valid dan siap dikonversi." : "HTML tidak valid — perbaiki dulu.", valid ? "ok" : "error");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderReport(null, [], { text: "validasi gagal", kind: "error" });
    ui.paneMeta.textContent = "siap";
    selectTab("report");
    setStatus(message, "error");
  } finally {
    ui.validateBtn.disabled = false;
  }
}

/**
 * @param {Record<string, unknown>} data Payload /convert.
 */
function showDownload(data) {
  const url = typeof data.downloadUrl === "string" ? data.downloadUrl : "";
  if (url === "") {
    ui.downloadLink.hidden = true;
    return;
  }
  const filename =
    typeof data.filename === "string" && data.filename !== ""
      ? decodeSafe(data.filename)
      : decodeSafe(url.split("/").pop() || "deck.pptx");

  ui.downloadLink.setAttribute("href", url);
  ui.downloadLink.setAttribute("download", filename);
  ui.downloadLabel.textContent = `⬇ ${filename}`;
  ui.downloadLink.hidden = false;
}

/** @param {string} value @returns {string} Percent-decoded, aman terhadap input rusak. */
function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

async function runConvert() {
  if (convertBusy) return;
  if (ui.editor.value.trim() === "") {
    setStatus("Isi HTML dulu sebelum konversi.", "error");
    return;
  }

  convertBusy = true;
  const idleLabel = ui.convertBtn.textContent || "Convert to PPTX";
  ui.convertBtn.disabled = true;
  ui.convertBtn.setAttribute("aria-busy", "true");
  ui.convertBtn.textContent = "Mengonversi…";
  ui.paneMeta.textContent = "convert…";

  try {
    const data = await postJson("/convert", requestBody());
    showDownload(data);
    renderReport(data.stats, data.diagnostics, {
      text: "konversi sukses",
      kind: "ok",
      durationMs: data.durationMs,
    });
    ui.paneMeta.textContent = "siap";
    selectTab("report");
    setStatus(`Selesai dalam ${data.durationMs} ms — ${formatBytes(data.bytes)}.`, "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderReport(null, [], { text: "konversi gagal", kind: "error" });
    ui.paneMeta.textContent = "siap";
    selectTab("report");
    setStatus(message, "error");
  } finally {
    convertBusy = false;
    ui.convertBtn.disabled = false;
    ui.convertBtn.removeAttribute("aria-busy");
    ui.convertBtn.textContent = idleLabel;
  }
}

/** @param {unknown} bytes @returns {string} Ukuran human-friendly. */
function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

/* ------------------------------------------------------------------ persist */

/** @param {string} name Nama radio group. */
function syncSizeInputsEnabled(name) {
  const enabled = radioValue(name) === "custom";
  ui.customWidth.disabled = !enabled;
  ui.customHeight.disabled = !enabled;
}

function saveSettings() {
  storageSet(
    "settings",
    JSON.stringify({
      format: radioValue("format"),
      mode: radioValue("mode"),
      background: currentBackground(),
      defaultFontFamily: ui.fontFamily.value,
      customWidthInch: Number(ui.customWidth.value),
      customHeightInch: Number(ui.customHeight.value),
    }),
  );
}

function restoreSettings() {
  const raw = storageGet("settings");
  if (!raw) return;

  /** @type {Record<string, unknown> | null} */
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  if (parsed.format === "16:9" || parsed.format === "4:3" || parsed.format === "custom") {
    setRadio("format", parsed.format);
  }
  if (parsed.mode === "editable" || parsed.mode === "pixel" || parsed.mode === "hybrid") {
    setRadio("mode", parsed.mode);
  }
  if (typeof parsed.background === "string" && HEX_COLOR.test(parsed.background)) {
    ui.bgColor.value = parsed.background;
  }
  if (typeof parsed.defaultFontFamily === "string") {
    for (const option of ui.fontFamily.options) {
      if (option.value === parsed.defaultFontFamily) {
        ui.fontFamily.value = parsed.defaultFontFamily;
        break;
      }
    }
  }
  if (Number.isFinite(Number(parsed.customWidthInch))) {
    ui.customWidth.value = String(Number(parsed.customWidthInch));
  }
  if (Number.isFinite(Number(parsed.customHeightInch))) {
    ui.customHeight.value = String(Number(parsed.customHeightInch));
  }
}

function schedulePersistHtml() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    storageSet("html", ui.editor.value);
  }, PERSIST_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------- wiring */

function applyLocalSize() {
  const { widthInch, heightInch } = currentSizeInch();
  slideWidthPx = widthInch * CSS_PX_PER_INCH;
  slideHeightPx = heightInch * CSS_PX_PER_INCH;
}

function initSettings() {
  for (const name of ["format", "mode"]) {
    for (const input of document.querySelectorAll(`input[name="${name}"]`)) {
      input.addEventListener("change", () => {
        if (name === "format") {
          syncSizeInputsEnabled("format");
          applyLocalSize();
        }
        saveSettings();
        renderFrame();
        fitFrame();
        schedulePreview();
      });
    }
  }

  ui.customWidth.addEventListener("input", () => {
    applyLocalSize();
    saveSettings();
    renderFrame();
    fitFrame();
    schedulePreview();
  });
  ui.customHeight.addEventListener("input", () => {
    applyLocalSize();
    saveSettings();
    renderFrame();
    fitFrame();
    schedulePreview();
  });
  ui.bgColor.addEventListener("input", () => {
    saveSettings();
    renderFrame();
    schedulePreview();
  });
  ui.fontFamily.addEventListener("change", () => {
    saveSettings();
    schedulePreview();
  });
}

function initTemplates() {
  /** @type {NodeListOf<HTMLButtonElement>} */
  const buttons = document.querySelectorAll("[data-template]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-template") || "";
      const template = Object.prototype.hasOwnProperty.call(TEMPLATES, key)
        ? TEMPLATES[key]
        : null;
      if (!template) return;

      ui.editor.value = template.html;
      activeSlide = 0;
      storageSet("template", key);
      storageSet("html", template.html);
      setStatus(`Template "${template.label}" dimuat.`, "");
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = 0;
      void refreshPreview();
    });
  }

  ui.clearBtn.addEventListener("click", () => {
    ui.editor.value = "";
    activeSlide = 0;
    slideCount = 0;
    // Batalkan preview terjadwal dan abaikan balasan yang sedang jalan.
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = 0;
    previewSeq += 1;
    storageSet("html", "");
    storageSet("template", "");
    renderFrame();
    renderReport(null, [], { text: "belum divalidasi", kind: "" });
    ui.paneMeta.textContent = "siap";
    setStatus("Editor dikosongkan.", "");
  });
}

function initTabs() {
  ui.tabPreview.addEventListener("click", () => selectTab("preview"));
  ui.tabReport.addEventListener("click", () => selectTab("report"));
}

function init() {
  restoreSettings();
  syncSizeInputsEnabled("format");
  applyLocalSize();

  const savedHtml = storageGet("html");
  if (savedHtml !== null) {
    ui.editor.value = savedHtml;
  } else {
    // Default: template multi-slide supaya switcher langsung terlihat.
    const lastTemplate = storageGet("template") || "twoSlides";
    const fallback = Object.prototype.hasOwnProperty.call(TEMPLATES, lastTemplate)
      ? TEMPLATES[lastTemplate]
      : TEMPLATES.twoSlides;
    ui.editor.value = fallback.html;
    storageSet("template", lastTemplate);
    storageSet("html", fallback.html);
  }

  initSettings();
  initTemplates();
  initTabs();

  ui.editor.addEventListener("input", () => {
    schedulePersistHtml();
    schedulePreview();
  });

  ui.validateBtn.addEventListener("click", () => {
    void runValidate();
  });
  ui.convertBtn.addEventListener("click", () => {
    void runConvert();
  });

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => fitFrame()).observe(ui.stage);
  } else {
    window.addEventListener("resize", fitFrame);
  }

  renderFrame();
  fitFrame();
  void refreshPreview();
}

init();