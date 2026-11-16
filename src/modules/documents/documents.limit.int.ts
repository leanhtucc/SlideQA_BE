import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// Giới hạn dung lượng đọc lúc import env, nên đặt trước và import động; file riêng = tiến trình riêng.
process.env["MAX_UPLOAD_BYTES"] = "2000";
const { app, cleanup, prisma, signup } = await import("../../test/helpers.js");
const { makePdf } = await import("../../test/pdf.js");
after(cleanup);

test("tệp vượt giới hạn dung lượng trả 413 và không tạo tài liệu (FR-DOC-01)", async () => {
  const u = await signup();
  const cid = (await request(app).post("/api/v1/courses").set(u.auth).send({ name: "M" })).body.id as string;
  const big = makePdf(Array.from({ length: 40 }, (_, i) => `trang ${i} ${"x".repeat(80)}`));
  assert.ok(big.length > 2000);
  const res = await request(app).post("/api/v1/documents").set(u.auth).field("courseId", cid).attach("file", big, "to.pdf");
  assert.equal(res.status, 413);
  assert.equal(res.body.error.code, "file_too_large");
  assert.equal(await prisma.document.count({ where: { userId: u.id } }), 0);

  const small = await request(app).post("/api/v1/documents").set(u.auth).field("courseId", cid).attach("file", makePdf(["nho"]), "nho.pdf");
  assert.equal(small.status, 202);
});
