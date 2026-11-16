import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env["ASK_RATE_MAX"] = "3";
const { app, cleanup, seedDocument, signup } = await import("../../test/helpers.js");
after(cleanup);

test("hỏi quá 30 lượt/giờ/người dùng trả 429; người khác không bị ảnh hưởng (NFR-09)", async () => {
  const a = await signup();
  const b = await signup();
  await seedDocument(a.id);
  const ca = (await request(app).post("/api/v1/conversations").set(a.auth).send({})).body.id as string;
  const cb = (await request(app).post("/api/v1/conversations").set(b.auth).send({})).body.id as string;

  for (let i = 0; i < 3; i++) {
    assert.equal((await request(app).post(`/api/v1/conversations/${ca}/messages`).set(a.auth).send({ question: "câu hỏi ngoài tài liệu zzz" })).status, 200);
  }
  const res = await request(app).post(`/api/v1/conversations/${ca}/messages`).set(a.auth).send({ question: "câu thứ tư" });
  assert.equal(res.status, 429);
  assert.equal(res.body.error.code, "rate_limited");
  assert.ok(Number(res.headers["retry-after"]) > 0);

  assert.equal((await request(app).post(`/api/v1/conversations/${cb}/messages`).set(b.auth).send({ question: "câu của B" })).status, 200);
});
