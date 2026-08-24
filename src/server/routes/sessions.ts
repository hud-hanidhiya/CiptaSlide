import { Router, type Request, type Response } from "express";
import { SessionStore, sessionStore as defaultSessionStore } from "../sessionStore";

/**
 * POST /api/sessions — buat sesi chat baru (dipanggil frontend saat tab dibuka / mulai brief baru).
 * Pemisahan ini yang memungkinkan POST /api/chat menolak sessionId tak dikenal dengan 404
 * (deteksi sesi mati setelah server restart), sesuai docs/03-spec.md §Error handling.
 */
export function createSessionsRouter(store: SessionStore = defaultSessionStore): Router {
  const router = Router();

  router.post("/sessions", (_req: Request, res: Response) => {
    const state = store.create();
    res.status(201).json({ sessionId: state.sessionId });
  });

  return router;
}
