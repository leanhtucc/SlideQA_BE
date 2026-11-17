import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["MAIL_PROVIDER"] = "brevo";
process.env["BREVO_API_KEY"] = "khoa-gia-cho-test";
process.env["MAIL_FROM_EMAIL"] = "gui@example.test";
const { sendMail } = await import("./index.js");

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
const MAIL = { to: "nguoi-nhan@example.test", subject: "Chủ đề", text: "Liên kết bí mật: https://x/reset?token=abc" };

test("brevo: gửi đúng địa chỉ, người gửi, nội dung; khóa nằm trong header", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => ((seen = { url, init }), new Response("{}", { status: 201 }))) as typeof fetch;
  await sendMail(MAIL);
  assert.equal(seen?.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal((seen?.init.headers as Record<string, string>)["api-key"], "khoa-gia-cho-test");
  const body = JSON.parse(String(seen?.init.body));
  assert.deepEqual(body.to, [{ email: "nguoi-nhan@example.test" }]);
  assert.equal(body.sender.email, "gui@example.test");
  assert.equal(body.subject, "Chủ đề");
  assert.equal(body.textContent, MAIL.text);
});

test("brevo lỗi hoặc mất mạng: không ném ra ngoài và không ghi địa chỉ hay liên kết vào log", async () => {
  const logs: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    globalThis.fetch = (async () => new Response("loi", { status: 401 })) as typeof fetch;
    await sendMail(MAIL);
    globalThis.fetch = (async () => {
      throw new Error("mang");
    }) as typeof fetch;
    await sendMail(MAIL);
  } finally {
    console.error = err;
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => !l.includes("nguoi-nhan") && !l.includes("token=")));
});
