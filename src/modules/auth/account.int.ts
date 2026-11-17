import "../../db/guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["LOGIN_RATE_MAX"] = "1000";
process.env["RESET_RATE_MAX"] = "1000";
process.env["STORAGE_DIR"] = mkdtempSync(join(tmpdir(), "slideqa-acct-"));
const { app } = await import("../../app.js");
const { prisma } = await import("../../prisma.js");
const { storage } = await import("../../lib/storage/index.js");

const created: string[] = [];
after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: created } } });
  await prisma.$disconnect();
});

const PW = "mat-khau-thu-123";
const NEW_PW = "mat-khau-moi-456";
const A = (p: string) => `/api/v1/auth${p}`;

async function signup() {
  const email = `acct-${randomUUID()}@example.test`;
  created.push(email);
  const res = await request(app).post(A("/register")).send({ email, password: PW, displayName: "Tester", acceptTerms: true });
  assert.equal(res.status, 201);
  return { email, token: res.body.accessToken as string, refresh: res.body.refreshToken as string };
}

/** Chạy một hành động và lấy token đặt lại từ nội dung thư (thư hiện chỉ ghi ra console, quyết định Q8). */
async function captureResetToken(email: string): Promise<string | null> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const res = await request(app).post(A("/forgot")).send({ email });
    assert.equal(res.status, 204);
  } finally {
    console.log = orig;
  }
  return logs.join("\n").match(/reset\?token=([\w-]+)/)?.[1] ?? null;
}

test("quên mật khẩu: email không tồn tại cũng trả 204 và không gửi thư", async () => {
  assert.equal(await captureResetToken(`khong-co-${randomUUID()}@example.test`), null);
});

test("đặt lại mật khẩu: dùng được một lần, đăng nhập bằng mật khẩu mới, thu hồi phiên cũ", async () => {
  const u = await signup();
  const token = await captureResetToken(u.email);
  assert.ok(token);
  const row = await prisma.passwordReset.findFirstOrThrow({ where: { user: { email: u.email } } });
  assert.notEqual(row.tokenHash, token); // chỉ lưu băm
  assert.ok(row.expiresAt.getTime() - Date.now() <= 30 * 60_000 + 1000);

  const ok = await request(app).post(A("/reset")).send({ token, password: NEW_PW });
  assert.equal(ok.status, 204);
  assert.equal((await request(app).post(A("/login")).send({ email: u.email, password: NEW_PW })).status, 200);
  assert.equal((await request(app).post(A("/login")).send({ email: u.email, password: PW })).status, 401);
  assert.equal((await request(app).post(A("/refresh")).send({ refreshToken: u.refresh })).status, 401);

  const again = await request(app).post(A("/reset")).send({ token, password: "mat-khau-khac-789" });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, "invalid_reset_token");
});

test("đặt lại mật khẩu: token sai, hết hạn, hoặc đã bị liên kết mới thay thế đều bị từ chối", async () => {
  const u = await signup();
  assert.equal((await request(app).post(A("/reset")).send({ token: "khong-phai-token", password: NEW_PW })).status, 400);

  const old = await captureResetToken(u.email);
  const fresh = await captureResetToken(u.email);
  assert.ok(old && fresh && old !== fresh);
  assert.equal((await request(app).post(A("/reset")).send({ token: old, password: NEW_PW })).status, 400);

  await prisma.passwordReset.updateMany({ where: { user: { email: u.email }, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await request(app).post(A("/reset")).send({ token: fresh, password: NEW_PW })).status, 400);
});

test("đặt lại mật khẩu: mật khẩu mới yếu bị chặn và token chưa bị đốt", async () => {
  const u = await signup();
  const token = await captureResetToken(u.email);
  const weak = await request(app).post(A("/reset")).send({ token, password: "ngan" });
  assert.equal(weak.status, 422);
  assert.equal((await request(app).post(A("/reset")).send({ token, password: NEW_PW })).status, 204);
});

test("đổi mật khẩu: sai mật khẩu hiện tại bị từ chối; đúng thì phiên cũ bị thu hồi", async () => {
  const u = await signup();
  const auth = { Authorization: `Bearer ${u.token}` };
  const wrong = await request(app).post("/api/v1/me/password").set(auth).send({ currentPassword: "sai-mat-khau", newPassword: NEW_PW });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, "wrong_password");

  const ok = await request(app).post("/api/v1/me/password").set(auth).send({ currentPassword: PW, newPassword: NEW_PW });
  assert.equal(ok.status, 204);
  assert.equal((await request(app).post(A("/refresh")).send({ refreshToken: u.refresh })).status, 401);
  assert.equal((await request(app).post(A("/login")).send({ email: u.email, password: NEW_PW })).status, 200);
});

test("đổi tên hiển thị: lưu và kiểm tra độ dài", async () => {
  const u = await signup();
  const auth = { Authorization: `Bearer ${u.token}` };
  const ok = await request(app).patch("/api/v1/me").set(auth).send({ displayName: "  Tên mới  " });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.displayName, "Tên mới");
  assert.equal((await request(app).patch("/api/v1/me").set(auth).send({ displayName: "" })).status, 422);
  assert.equal((await request(app).patch("/api/v1/me").set(auth).send({ displayName: "x".repeat(81) })).status, 422);
});

test("xóa tài khoản: cần đúng mật khẩu; xóa sạch dữ liệu và cả tệp PDF", async () => {
  const u = await signup();
  const auth = { Authorization: `Bearer ${u.token}` };
  const user = await prisma.user.findUniqueOrThrow({ where: { email: u.email } });
  const course = await prisma.course.create({ data: { userId: user.id, name: "Môn thử" } });
  const key = `${user.id}/${randomUUID()}.pdf`;
  const src = join(process.env["STORAGE_DIR"]!, "..", `src-${randomUUID()}.pdf`);
  (await import("node:fs")).writeFileSync(src, "%PDF-1.4 test");
  await storage.put(key, src);
  await prisma.document.create({ data: { userId: user.id, courseId: course.id, name: "a.pdf", storageKey: key, sizeBytes: 13, contentHash: randomUUID(), status: "ready", pages: 1 } });
  await prisma.conversation.create({ data: { userId: user.id, title: "Hội thoại" } });
  const file = join(process.env["STORAGE_DIR"]!, key);
  assert.ok(existsSync(file));

  const wrong = await request(app).delete("/api/v1/me").set(auth).send({ password: "sai-mat-khau" });
  assert.equal(wrong.status, 403);
  assert.ok(await prisma.user.findUnique({ where: { id: user.id } }));

  assert.equal((await request(app).delete("/api/v1/me").set(auth).send({ password: PW })).status, 204);
  assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
  assert.equal(await prisma.course.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.document.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.passwordReset.count({ where: { userId: user.id } }), 0);
  assert.ok(!existsSync(file), "tệp PDF gốc phải bị xóa");
  assert.equal((await request(app).post(A("/login")).send({ email: u.email, password: PW })).status, 401);
});
