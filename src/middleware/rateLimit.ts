import type { Request, RequestHandler } from "express";
import { AppError } from "./error.js";

interface Options {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}

// shortcut: bộ đếm trong bộ nhớ của một tiến trình; khi chạy nhiều bản API thì chuyển sang DB/Redis.
export function rateLimit({ windowMs, max, key = (r) => r.ip ?? "unknown" }: Options): RequestHandler {
  const hits = new Map<string, { n: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    const k = key(req);
    let h = hits.get(k);
    if (!h || h.resetAt <= now) {
      h = { n: 0, resetAt: now + windowMs };
      hits.set(k, h);
    }
    if (++h.n > max) {
      const retry = Math.ceil((h.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      return next(new AppError(429, "rate_limited", `Quá nhiều lần thử. Hãy thử lại sau ${retry} giây.`));
    }
    next();
  };
}
