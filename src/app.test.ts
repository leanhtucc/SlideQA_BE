import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// env.ts đọc process.env lúc import, nên đặt trước rồi mới import động.
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["ANTHROPIC_API_KEY"] = ""; // rỗng (không xóa) để dotenv không nạp khóa thật từ .env
process.env["LLM_PROVIDER"] = "anthropic"; // .env của máy có thể đặt gemini/mock
process.env["GEMINI_API_KEY"] = "";
const { app } = await import("./app.js");

test("health báo ok và AI tắt khi không có khóa", async () => {
  const res = await request(app).get("/api/v1/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, llmEnabled: false, llmProvider: "anthropic" });
});

test("đường dẫn lạ trả 404 đúng định dạng lỗi", async () => {
  const res = await request(app).get("/api/v1/khong-co");
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "not_found");
});

test("JSON hỏng trả 400, không lộ chi tiết nội bộ", async () => {
  const res = await request(app).post("/api/v1/health").set("content-type", "application/json").send("{bad");
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "bad_json");
});

test("/me không có token trả 401", async () => {
  const res = await request(app).get("/api/v1/me");
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "unauthorized");
});

test("validation lỗi trả 422 kèm lỗi từng trường, không cần DB", async () => {
  const res = await request(app).post("/api/v1/auth/register").send({ email: "x", password: "short", displayName: "", acceptTerms: false });
  assert.equal(res.status, 422);
  assert.deepEqual(Object.keys(res.body.error.fields).sort(), ["acceptTerms", "displayName", "email", "password"]);
});
