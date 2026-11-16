import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
const { rateLimit } = await import("./rateLimit.js");
const { errorHandler } = await import("./error.js");

const makeApp = (windowMs: number) => {
  const a = express();
  a.get("/x", rateLimit({ windowMs, max: 3 }), (_q, r) => void r.json({ ok: true }));
  a.use(errorHandler);
  return a;
};

test("vượt giới hạn thì 429 kèm Retry-After", async () => {
  const a = makeApp(60_000);
  for (let i = 0; i < 3; i++) assert.equal((await request(a).get("/x")).status, 200);
  const res = await request(a).get("/x");
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, "rate_limited");
  assert.ok(Number(res.headers["retry-after"]) >= 1);
});

test("hết cửa sổ thời gian thì đếm lại", async () => {
  const a = makeApp(60);
  for (let i = 0; i < 4; i++) await request(a).get("/x");
  await new Promise((r) => setTimeout(r, 90));
  assert.equal((await request(a).get("/x")).status, 200);
});

test("/auth/login bị giới hạn 5 lần mỗi phút mỗi IP (NFR-09)", async () => {
  const { app } = await import("../app.js");
  for (let i = 0; i < 5; i++) {
    // Body thiếu → 422 trước khi chạm DB, nhưng vẫn tính vào giới hạn.
    assert.equal((await request(app).post("/api/v1/auth/login").send({})).status, 422);
  }
  const res = await request(app).post("/api/v1/auth/login").send({});
  assert.equal(res.status, 429);
});
