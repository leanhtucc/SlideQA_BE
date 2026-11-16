import type { RequestHandler } from "express";
import { AppError } from "./error.js";
import { verifyAccessToken, type AccessClaims } from "../utils/jwt.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: AccessClaims;
  }
}

/** Yêu cầu header `Authorization: Bearer <access token>`; đặt req.auth. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const m = /^Bearer (.+)$/.exec(req.header("authorization") ?? "");
  if (!m?.[1]) return next(new AppError(401, "unauthorized", "Bạn cần đăng nhập."));
  try {
    req.auth = verifyAccessToken(m[1]);
    next();
  } catch {
    next(new AppError(401, "unauthorized", "Phiên đăng nhập không hợp lệ hoặc đã hết hạn."));
  }
};

/** Lấy userId đã xác thực; mọi truy vấn dữ liệu phải lọc theo giá trị này (NFR-07). */
export const authUserId = (req: { auth?: AccessClaims }): string => {
  if (!req.auth) throw new AppError(401, "unauthorized", "Bạn cần đăng nhập.");
  return req.auth.userId;
};
