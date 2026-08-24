"use strict";

/**
 * Frontend chat CiptaSlide — polos, tanpa framework.
 * - sessionId dibuat sekali per tab via POST /api/sessions, disimpan di sessionStorage.
 * - Kalau /api/chat balas 404 (server restart), tampilkan saran mulai chat baru.
 * - Input dinonaktifkan selama menunggu balasan (hindari race condition session yang sama).
 */

const STORAGE_KEY = "ciptaslide.sessionId";

const chatWindow = /** @type {HTMLElement} */ (document.getElementById("chat-window"));
const form = /** @type {HTMLFormElement} */ (document.getElementById("chat-form"));
const input = /** @type {HTMLTextAreaElement} */ (document.getElementById("chat-input"));
const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById("send-btn"));

let sessionId = null;
let pending = false;

function scrollToBottom() {
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addBubble(kind, text) {
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  div.textContent = text;
  chatWindow.appendChild(div);
  scrollToBottom();
  return div;
}

function addDownloadLink(url) {
  const div = document.createElement("div");
  div.className = "bubble assistant download";
  const a = document.createElement("a");
  a.href = url;
  a.textContent = `⬇ Download ${decodeURIComponent(url.split("/").pop() || "deck.pptx")}`;
  a.download = "";
  div.appendChild(a);
  chatWindow.appendChild(div);
  scrollToBottom();
}

function setPending(value) {
  pending = value;
  sendBtn.disabled = value;
  input.disabled = value;
  if (value) {
    addBubble("assistant loading", "Sedang merencanakan & merender deck… (bisa beberapa detik)");
  } else {
    const loader = chatWindow.querySelector(".loading");
    if (loader) loader.remove();
  }
}

async function ensureSession() {
  const existing = sessionStorage.getItem(STORAGE_KEY);
  if (existing) {
    // Sesi mungkin sudah mati (server restart) — /api/chat akan memberi 404 dan kita reset di sana.
    sessionId = existing;
    return;
  }
  const res = await fetch("/api/sessions", { method: "POST" });
  if (!res.ok) throw new Error(`Gagal membuat sesi (HTTP ${res.status})`);
  const data = await res.json();
  sessionId = data.sessionId;
  sessionStorage.setItem(STORAGE_KEY, sessionId);
}

function resetSession() {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionId = null;
}

async function sendMessage(text) {
  try {
    await ensureSession();
  } catch (err) {
    addBubble("error", `Gagal menyiapkan sesi: ${err.message}`);
    return;
  }

  setPending(true);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      if (res.status === 404 && data && data.error === "session_tidak_dikenal") {
        resetSession();
        addBubble(
          "error",
          `${data.message}\nKetik ulang brief untuk memulai sesi baru — pesan ini tidak terkirim.`
        );
      } else {
        addBubble("error", (data && data.message) || `Terjadi error (HTTP ${res.status}).`);
      }
      return;
    }

    addBubble("assistant", data.reply);
    if (data.downloadUrl) {
      addDownloadLink(data.downloadUrl);
    }
  } catch (err) {
    addBubble("error", `Tidak bisa menghubungi server: ${err.message}`);
  } finally {
    setPending(false);
    input.focus();
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pending) return;
  const text = input.value.trim();
  if (!text) return;
  addBubble("user", text);
  input.value = "";
  sendMessage(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

scrollToBottom();
input.focus();
