import { Prisma, type User } from "@prisma/client";
import { env } from "../../config/env.js";
import { sendMail } from "../../lib/mail/index.js";
import { storage } from "../../lib/storage/index.js";
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

// ---------- quên / đặt lại / đổi mật khẩu, hồ sơ, xóa tài khoản (E1) ----------

const revokeAllSessions = (userId: string, db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

/** Tạo token một lần (hết hạn sau RESET_TTL_MINUTES) và gửi liên kết. Email không tồn tại thì im lặng, không báo khác biệt. */
export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status === "locked") return;
  const token = newRefreshToken();
  await prisma.$transaction([
    prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }), // chỉ liên kết mới nhất có hiệu lực
    prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + env.RESET_TTL_MINUTES * 60_000) } }),
  ]);
  await sendMail({
    to: user.email,
    subject: "Đặt lại mật khẩu Slide QA",
    text: `Mở liên kết sau để đặt mật khẩu mới (hết hạn sau ${env.RESET_TTL_MINUTES} phút, dùng một lần):\n${env.WEB_URL}/reset?token=${token}\n\nNếu bạn không yêu cầu, hãy bỏ qua thư này.`,
  });
}

export async function resetPassword(token: string, password: string) {
  const bad = () => new AppError(400, "invalid_reset_token", "Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.");
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) throw bad();
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    // Đánh dấu đã dùng có điều kiện: hai request đồng thời thì chỉ một request thắng.
    const { count } = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count === 0) throw bad();
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await revokeAllSessions(row.userId, tx); // đổi mật khẩu thì mọi phiên cũ phải đăng nhập lại
  });
}

/** Xác nhận mật khẩu hiện tại cho thao tác nhạy cảm. Tài khoản chưa có mật khẩu (chỉ Google) chưa dùng được luồng này. */
async function verifyCurrentPassword(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, "unauthorized", "Bạn cần đăng nhập.");
  if (!user.passwordHash) throw new AppError(409, "no_password", "Tài khoản này chưa đặt mật khẩu.");
  if (!(await verifyPassword(password, user.passwordHash))) throw new AppError(403, "wrong_password", "Mật khẩu chưa đúng.");
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  await verifyCurrentPassword(userId, currentPassword);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await revokeAllSessions(userId, tx);
  });
}

export async function updateProfile(userId: string, displayName: string) {
  return publicUser(await prisma.user.update({ where: { id: userId }, data: { displayName } }));
}

/** Xóa tài khoản: xóa hàng trong DB (cascade) rồi xóa tệp PDF gốc. Cần mật khẩu để xác nhận. */
export async function deleteAccount(userId: string, password: string) {
  await verifyCurrentPassword(userId, password);
  const docs = await prisma.document.findMany({ where: { userId }, select: { storageKey: true } });
  await prisma.user.delete({ where: { id: userId } });
  // Tệp xóa sau DB: nếu lỗi giữa chừng thì chỉ còn tệp mồ côi, không còn dữ liệu gắn với người dùng.
  await Promise.allSettled(docs.map((d) => storage.remove(d.storageKey)));
}
