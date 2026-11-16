import "../../db/guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";

process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["LOGIN_RATE_MAX"] = "1000";
const { app } = await import("../../app.js");
const { prisma } = await import("../../prisma.js");

const created: string[] = [];
after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: created } } });
  await prisma.$disconnect();
});

const PW = "mat-khau-thu-123";
const api = (p: string) => `/api/v1/auth${p}`;
async function signup(over: Record<string, unknown> = {}) {
  const email = `t-${randomUUID()}@example.test`;
  created.push(email);
  const res = await request(app).post(api("/register")).send({ email, password: PW, displayName: "Tester", acceptTerms: true, ...over });
  return { email, res };
}

test("đăng ký: trả user + cặp token, lưu băm bcrypt và phiên bản điều khoản", async () => {
  const { email, res } = await signup();
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, email);
  assert.ok(res.body.accessToken && res.body.refreshToken);
  assert.equal(res.body.expiresIn, 900);
  assert.ok(!JSON.stringify(res.body).includes(PW) && !("passwordHash" in res.body.user));
  const row = await prisma.user.findUniqueOrThrow({ where: { email } });
  assert.match(row.passwordHash ?? "", /^\$2[aby]\$/);
  assert.notEqual(row.passwordHash, PW);
  assert.ok(row.termsAcceptedAt && row.termsVersion);
  const rt = await prisma.refreshToken.findFirstOrThrow({ where: { userId: row.id } });
  assert.notEqual(rt.tokenHash, res.body.refreshToken, "DB chỉ lưu băm, không lưu token gốc");
});

test("đăng ký: email trùng (khác hoa thường) trả 409", async () => {
  const { email } = await signup();
  const res = await request(app).post(api("/register")).send({ email: email.toUpperCase(), password: PW, displayName: "X", acceptTerms: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "email_taken");
});

test("đăng ký: mật khẩu ngắn, thiếu đồng ý điều khoản đều trả 422 theo từng trường", async () => {
  const a = await signup({ password: "1234567" });
  assert.equal(a.res.status, 422);
  assert.ok(a.res.body.error.fields.password);
  const b = await signup({ acceptTerms: false });
  assert.equal(b.res.status, 422);
  assert.ok(b.res.body.error.fields.acceptTerms);
  assert.equal(await prisma.user.count({ where: { email: { in: [a.email, b.email] } } }), 0);
});

test("đăng nhập: đúng thì 200, sai mật khẩu và email lạ cùng một thông báo 401", async () => {
  const { email } = await signup();
  const ok = await request(app).post(api("/login")).send({ email, password: PW });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken);
  const wrong = await request(app).post(api("/login")).send({ email, password: "sai-mat-khau-1" });
  const unknown = await request(app).post(api("/login")).send({ email: `khong-co-${randomUUID()}@example.test`, password: PW });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test("đăng nhập: tài khoản bị khóa trả 403", async () => {
  const { email } = await signup();
  await prisma.user.update({ where: { email }, data: { status: "locked" } });
  const res = await request(app).post(api("/login")).send({ email, password: PW });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "account_locked");
});

test("refresh: xoay vòng, token cũ bị từ chối và dùng lại thì thu hồi cả họ", async () => {
  const { res: reg } = await signup();
  const r1 = await request(app).post(api("/refresh")).send({ refreshToken: reg.body.refreshToken });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refreshToken, reg.body.refreshToken);
  // Dùng lại token cũ → 401 và thu hồi mọi token còn lại của user (nghi bị đánh cắp).
  const reuse = await request(app).post(api("/refresh")).send({ refreshToken: reg.body.refreshToken });
  assert.equal(reuse.status, 401);
  const afterReuse = await request(app).post(api("/refresh")).send({ refreshToken: r1.body.refreshToken });
  assert.equal(afterReuse.status, 401);
});

test("refresh: token hết hạn hoặc không tồn tại trả 401", async () => {
  const { email, res: reg } = await signup();
  await prisma.refreshToken.updateMany({ where: { user: { email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await request(app).post(api("/refresh")).send({ refreshToken: reg.body.refreshToken })).status, 401);
  assert.equal((await request(app).post(api("/refresh")).send({ refreshToken: "khong-ton-tai" })).status, 401);
});

test("refresh: hai request đồng thời cùng một token chỉ một request thành công", async () => {
  const { res: reg } = await signup();
  const rs = await Promise.all([1, 2, 3].map(() => request(app).post(api("/refresh")).send({ refreshToken: reg.body.refreshToken })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
});

test("logout: thu hồi refresh token, gọi lặp lại vẫn 204", async () => {
  const { res: reg } = await signup();
  assert.equal((await request(app).post(api("/logout")).send({ refreshToken: reg.body.refreshToken })).status, 204);
  assert.equal((await request(app).post(api("/logout")).send({ refreshToken: reg.body.refreshToken })).status, 204);
  assert.equal((await request(app).post(api("/refresh")).send({ refreshToken: reg.body.refreshToken })).status, 401);
});

test("/me: cần access token hợp lệ", async () => {
  const { email, res: reg } = await signup();
  const ok = await request(app).get("/api/v1/me").set("authorization", `Bearer ${reg.body.accessToken}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, email);

  assert.equal((await request(app).get("/api/v1/me")).status, 401);
  assert.equal((await request(app).get("/api/v1/me").set("authorization", "Bearer rac")).status, 401);

  const expired = jwt.sign({ role: "learner" }, process.env["JWT_ACCESS_SECRET"]!, { subject: reg.body.user.id, expiresIn: -10 });
  assert.equal((await request(app).get("/api/v1/me").set("authorization", `Bearer ${expired}`)).status, 401);

  const forged = jwt.sign({ role: "admin" }, "secret-khac-secret-khac-secret-khac-1", { subject: reg.body.user.id, expiresIn: 60 });
  assert.equal((await request(app).get("/api/v1/me").set("authorization", `Bearer ${forged}`)).status, 401);

  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: reg.body.user.id, role: "admin" })).toString("base64url")}.`;
  assert.equal((await request(app).get("/api/v1/me").set("authorization", `Bearer ${none}`)).status, 401);
});
