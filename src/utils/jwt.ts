import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AccessClaims {
  userId: string;
  role: "learner" | "admin";
}

export function signAccessToken(c: AccessClaims): string {
  return jwt.sign({ role: c.role }, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    subject: c.userId,
    expiresIn: env.ACCESS_TTL_SECONDS,
  });
}

/** Ném lỗi nếu token sai, hết hạn hoặc không phải HS256. */
export function verifyAccessToken(token: string): AccessClaims {
  const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] });
  if (typeof p === "string" || !p.sub || (p["role"] !== "learner" && p["role"] !== "admin")) {
    throw new Error("claims không hợp lệ");
  }
  return { userId: p.sub, role: p["role"] };
}
