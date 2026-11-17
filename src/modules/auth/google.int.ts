import "../../db/guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["LOGIN_RATE_MAX"] = "1000";
process.env["GOOGLE_CLIENT_ID"] = "test-client.apps.googleusercontent.com";
const { app } = await import("../../app.js");
const { prisma } = await import("../../prisma.js");
const { setGoogleVerifierForTests } = await import("../../lib/google/index.js");

const created: string[] = [];
after(async () => {
  setGoogleVerifierForTests(null);
  await prisma.user.deleteMany({ where: { email: { in: created } } });
  await prisma.$disconnect();
});

const PW = "mat-khau-thu-123";
const A = (p: string) => `/api/v1/auth${p}`;

/** Giả lập Google: chuỗi "ok:<sub>:<email>:<verified>:<tên>" được coi là token hợp lệ, còn lại bị từ chối như token giả. */
setGoogleVerifierForTests(async (c) => {
  const [tag, sub, email, verified, name] = c.split(":");
  if (tag !== "ok" || !sub || !email) throw new Error("bad token");
  return { sub, email, emailVerified: verified === "true", name: name ?? null };
});
const token = (sub: string, email: string, verified = true, name = "Người Google") => `ok:${sub}:${email}:${verified}:${name}`;
const fresh = () => {
  const email = `g-${randomUUID()}@example.test`;
  created.push(email);
  return { email, sub: `sub-${randomUUID()}` };
};

test("Google lần đầu: cần đồng ý điều khoản, rồi tạo tài khoản không mật khẩu và đăng nhập được", async () => {
  const g = fresh();
  const no = await request(app).post(A("/google")).send({ credential: token(g.sub, g.email) });
  assert.equal(no.status, 409);
  assert.equal(no.body.error.code, "terms_required");
  assert.equal(await prisma.user.count({ where: { email: g.email } }), 0);

  const ok = await request(app).post(A("/google")).send({ credential: token(g.sub, g.email), acceptTerms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.email, g.email);
  assert.equal(ok.body.user.displayName, "Người Google");
  assert.equal(ok.body.user.hasPassword, false);
  assert.ok(ok.body.accessToken && ok.body.refreshToken);
  const row = await prisma.user.findUniqueOrThrow({ where: { email: g.email } });
  assert.equal(row.googleId, g.sub);
  assert.equal(row.passwordHash, null);
  assert.ok(row.termsAcceptedAt && row.termsVersion);

  // Lần sau không cần acceptTerms nữa.
  assert.equal((await request(app).post(A("/google")).send({ credential: token(g.sub, g.email) })).status, 200);
  assert.equal(await prisma.user.count({ where: { email: g.email } }), 1);
  // Tài khoản không mật khẩu không đăng nhập được bằng mật khẩu.
  assert.equal((await request(app).post(A("/login")).send({ email: g.email, password: PW })).status, 401);
});

test("token giả hoặc email chưa xác minh bị từ chối, không tạo tài khoản", async () => {
  const g = fresh();
  const bad = await request(app).post(A("/google")).send({ credential: "token-gia-mao", acceptTerms: true });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, "invalid_google_token");
  const un = await request(app).post(A("/google")).send({ credential: token(g.sub, g.email, false), acceptTerms: true });
  assert.equal(un.status, 403);
  assert.equal(un.body.error.code, "google_email_unverified");
  assert.equal(await prisma.user.count({ where: { email: g.email } }), 0);
  assert.equal((await request(app).post(A("/google")).send({})).status, 422);
});

test("trùng email với tài khoản mật khẩu: gắn Google, xóa mật khẩu cũ và thu hồi phiên (chống chiếm email trước)", async () => {
  const g = fresh();
  const reg = await request(app).post(A("/register")).send({ email: g.email, password: PW, displayName: "Kẻ chiếm email", acceptTerms: true });
  assert.equal(reg.status, 201);

  const res = await request(app).post(A("/google")).send({ credential: token(g.sub, g.email) });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, reg.body.user.id);
  const row = await prisma.user.findUniqueOrThrow({ where: { email: g.email } });
  assert.equal(row.googleId, g.sub);
  assert.equal(row.passwordHash, null);
  assert.equal((await request(app).post(A("/login")).send({ email: g.email, password: PW })).status, 401);
  assert.equal((await request(app).post(A("/refresh")).send({ refreshToken: reg.body.refreshToken })).status, 401);
});

test("email đã gắn Google khác thì từ chối", async () => {
  const g = fresh();
  assert.equal((await request(app).post(A("/google")).send({ credential: token(g.sub, g.email), acceptTerms: true })).status, 200);
  const other = await request(app).post(A("/google")).send({ credential: token(`sub-${randomUUID()}`, g.email), acceptTerms: true });
  assert.equal(other.status, 409);
});

test("tài khoản bị khóa không đăng nhập được bằng Google", async () => {
  const g = fresh();
  await request(app).post(A("/google")).send({ credential: token(g.sub, g.email), acceptTerms: true });
  await prisma.user.update({ where: { email: g.email }, data: { status: "locked" } });
  assert.equal((await request(app).post(A("/google")).send({ credential: token(g.sub, g.email) })).status, 403);
});

test("không đổi mật khẩu được khi chưa có mật khẩu; xóa tài khoản bằng cách gõ lại email", async () => {
  const g = fresh();
  const res = await request(app).post(A("/google")).send({ credential: token(g.sub, g.email), acceptTerms: true });
  const auth = { Authorization: `Bearer ${res.body.accessToken}` };
  const pw = await request(app).post("/api/v1/me/password").set(auth).send({ currentPassword: "x", newPassword: "mat-khau-moi-456" });
  assert.equal(pw.status, 409);
  assert.equal(pw.body.error.code, "no_password");

  assert.equal((await request(app).delete("/api/v1/me").set(auth).send({ email: "sai@example.test" })).status, 403);
  assert.equal((await request(app).delete("/api/v1/me").set(auth).send({})).status, 422);
  assert.ok(await prisma.user.findUnique({ where: { email: g.email } }));
  assert.equal((await request(app).delete("/api/v1/me").set(auth).send({ email: g.email.toUpperCase() })).status, 204);
  assert.equal(await prisma.user.findUnique({ where: { email: g.email } }), null);
});

test("chưa cấu hình GOOGLE_CLIENT_ID thì báo tính năng chưa bật", async () => {
  const { env } = await import("../../config/env.js");
  const saved = env.GOOGLE_CLIENT_ID;
  Reflect.set(env, "GOOGLE_CLIENT_ID", undefined);
  try {
    const res = await request(app).post(A("/google")).send({ credential: "ok:x:y@z.test:true:T", acceptTerms: true });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "google_unavailable");
  } finally {
    Reflect.set(env, "GOOGLE_CLIENT_ID", saved);
  }
});
