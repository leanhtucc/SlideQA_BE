import bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

export const hashPassword = (plain: string) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/** Băm cố định để so sánh khi email không tồn tại, tránh lộ email qua thời gian phản hồi. */
export const DUMMY_HASH = bcrypt.hashSync("không-phải-mật-khẩu-thật", env.BCRYPT_ROUNDS);

/** Refresh token là chuỗi ngẫu nhiên; DB chỉ lưu băm SHA-256 của nó. */
export const newRefreshToken = () => randomBytes(48).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
