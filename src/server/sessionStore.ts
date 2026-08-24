import { randomUUID } from "node:crypto";
import { SessionNotFoundError } from "../errors";
import type { Deck } from "../schema/deck.schema";

/** Ringkasan satu giliran chat — untuk histori frontend, BUKAN JSON Deck penuh (guardrail payload). */
export interface ChatTurnSummary {
  role: "user" | "assistant";
  summary: string;
}

export interface SessionState {
  sessionId: string;
  /** null sebelum giliran initial selesai sukses. */
  deck: Deck | null;
  lastPptxFile: string | null;
  turns: ChatTurnSummary[];
  createdAt: number;
}

/**
 * Repository in-memory sederhana — SATU-SATUNYA tempat mutable state proyek ini.
 * Hilang total saat server restart (batasan sadar, lihat docs/03-spec.md §Data flow).
 * Tanpa TTL di v1: sesi hidup selama proses server hidup.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  /** Buat sesi baru (dipanggil endpoint POST /api/sessions dari frontend saat tab dibuka). */
  create(): SessionState {
    const sessionId = randomUUID();
    const state: SessionState = {
      sessionId,
      deck: null,
      lastPptxFile: null,
      turns: [],
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /** Ambil sesi yang wajib sudah ada; throw SessionNotFoundError kalau tidak dikenal (mis. server restart). */
  require(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new SessionNotFoundError(sessionId);
    }
    return state;
  }
}

export const sessionStore = new SessionStore();
