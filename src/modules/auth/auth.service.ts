import { Prisma, type User } from "@prisma/client";
import { env } from "../../config/env.js";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";
import { DUMMY_HASH, hashPassword, newRefreshToken, sha256, verifyPassword } from "../../utils/hash.js";
import { signAccessToken } from "../../utils/jwt.js";

export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  llmConsentAt: u.llmConsentAt,
});

async function issueTokens(userId: string, role: User["role"], device: string | null) {
  const refreshToken = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(refreshToken),
      device,
      expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000),
    },
  });
  return { accessToken: signAccessToken({ userId, role }), refreshToken, expiresIn: env.ACCESS_TTL_SECONDS };
}

export async function register(
  input: { email: string; password: string; displayName: string },
  device: string | null,
) {
  let user: User;
  try {
    user = await prisma.user.create({
      data: {
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        termsVersion: env.TERMS_VERSION,
        termsAcceptedAt: new Date(),
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError(409, "email_taken", "Email này đã được dùng.");
    }
    throw e;
  }
  return { user: publicUser(user), ...(await issueTokens(user.id, user.role, device)) };
}

export async function login(input: { email: string; password: string }, device: string | null) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Luôn so sánh một lần bcrypt, kể cả khi không có user, để không lộ email nào tồn tại.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !ok) {
    throw new AppError(401, "invalid_credentials", "Email hoặc mật khẩu chưa đúng.");
  }
  if (user.status === "locked") throw new AppError(403, "account_locked", "Tài khoản đã bị khóa.");
  return { user: publicUser(user), ...(await issueTokens(user.id, user.role, device)) };
}

const invalidRefresh = () => new AppError(401, "invalid_refresh_token", "Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.");

/** Xoay vòng: mỗi refresh token chỉ dùng được một lần. Dùng lại token cũ = nghi bị đánh cắp, thu hồi cả họ. */
export async function refresh(token: string) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!row) throw invalidRefresh();
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw invalidRefresh();
  }
  if (row.expiresAt <= new Date()) throw invalidRefresh();
  if (row.user.status === "locked") throw new AppError(403, "account_locked", "Tài khoản đã bị khóa.");
  // Thu hồi có điều kiện: hai request đồng thời cùng token thì chỉ một request thắng.
  const { count } = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count === 0) throw invalidRefresh();
  return issueTokens(row.userId, row.user.role, row.device);
}

export async function logout(token: string) {
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new AppError(401, "unauthorized", "Bạn cần đăng nhập.");
  return publicUser(user);
}
