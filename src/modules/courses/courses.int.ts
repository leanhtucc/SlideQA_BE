import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, cleanup, prisma, signup } from "../../test/helpers.js";

after(cleanup);
const C = "/api/v1/courses";

test("không có token thì mọi endpoint trả 401", async () => {
  assert.equal((await request(app).get(C)).status, 401);
  assert.equal((await request(app).post(C).send({ name: "x" })).status, 401);
  assert.equal((await request(app).patch(`${C}/${randomUUID()}`).send({ name: "x" })).status, 401);
  assert.equal((await request(app).delete(`${C}/${randomUUID()}`)).status, 401);
});

test("tạo, xem, sửa, xóa môn học", async () => {
  const u = await signup();
  const created = await request(app).post(C).set(u.auth).send({ name: "  Phân tích quy trình  ", code: "IS201", term: "HK1", examDate: "2027-01-12" });
  assert.equal(created.status, 201);
  assert.deepEqual(
    { name: created.body.name, code: created.body.code, term: created.body.term, examDate: created.body.examDate, documentCount: created.body.documentCount, quizCount: created.body.quizCount },
    { name: "Phân tích quy trình", code: "IS201", term: "HK1", examDate: "2027-01-12", documentCount: 0, quizCount: 0 },
  );
  const id = created.body.id as string;

  assert.equal((await request(app).get(`${C}/${id}`).set(u.auth)).body.name, "Phân tích quy trình");

  const patched = await request(app).patch(`${C}/${id}`).set(u.auth).send({ name: "QTNV", code: "", examDate: null });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, "QTNV");
  assert.equal(patched.body.code, null, "chuỗi rỗng xóa mã môn");
  assert.equal(patched.body.examDate, null);
  assert.equal(patched.body.term, "HK1", "trường không gửi thì giữ nguyên");

  assert.equal((await request(app).delete(`${C}/${id}`).set(u.auth)).status, 204);
  assert.equal((await request(app).get(`${C}/${id}`).set(u.auth)).status, 404);
});

test("validation: tên trống, ngày sai, PATCH rỗng đều trả 422 theo từng trường", async () => {
  const u = await signup();
  const a = await request(app).post(C).set(u.auth).send({ name: "   ", examDate: "12/01/2027" });
  assert.equal(a.status, 422);
  assert.ok(a.body.error.fields.name && a.body.error.fields.examDate);
  const { body } = await request(app).post(C).set(u.auth).send({ name: "Hợp lệ" });
  assert.equal((await request(app).patch(`${C}/${body.id}`).set(u.auth).send({})).status, 422);
});

test("hai tài khoản không truy cập chéo: danh sách, xem, sửa, xóa đều 404 (NFR-07)", async () => {
  const alice = await signup();
  const bob = await signup();
  const mine = (await request(app).post(C).set(alice.auth).send({ name: "Của Alice" })).body.id as string;
  await request(app).post(C).set(bob.auth).send({ name: "Của Bob" });

  const bobList = await request(app).get(C).set(bob.auth);
  assert.deepEqual(bobList.body.map((c: { name: string }) => c.name), ["Của Bob"]);

  assert.equal((await request(app).get(`${C}/${mine}`).set(bob.auth)).status, 404);
  assert.equal((await request(app).patch(`${C}/${mine}`).set(bob.auth).send({ name: "Bị chiếm" })).status, 404);
  assert.equal((await request(app).delete(`${C}/${mine}`).set(bob.auth)).status, 404);

  const still = await prisma.course.findUniqueOrThrow({ where: { id: mine } });
  assert.equal(still.name, "Của Alice");
  assert.equal(still.userId, alice.id);
});

test("404 giống nhau cho id không tồn tại và id sai định dạng", async () => {
  const u = await signup();
  const a = await request(app).get(`${C}/${randomUUID()}`).set(u.auth);
  const b = await request(app).get(`${C}/khong-phai-uuid`).set(u.auth);
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.body, b.body);
});

test("body gửi kèm userId/id không đổi được chủ sở hữu (mass assignment)", async () => {
  const alice = await signup();
  const bob = await signup();
  const res = await request(app).post(C).set(bob.auth).send({ name: "X", userId: alice.id, id: randomUUID() });
  assert.equal(res.status, 201);
  const row = await prisma.course.findUniqueOrThrow({ where: { id: res.body.id } });
  assert.equal(row.userId, bob.id);
  const patch = await request(app).patch(`${C}/${res.body.id}`).set(bob.auth).send({ name: "Y", userId: alice.id });
  assert.equal(patch.status, 200);
  assert.equal((await prisma.course.findUniqueOrThrow({ where: { id: res.body.id } })).userId, bob.id);
});

test("danh sách có số tài liệu/quiz; xóa môn xóa tài liệu theo (FR-CRS-03)", async () => {
  const u = await signup();
  const id = (await request(app).post(C).set(u.auth).send({ name: "Có dữ liệu" })).body.id as string;
  const doc = await prisma.document.create({
    data: { userId: u.id, courseId: id, name: "a.pdf", sizeBytes: 1, contentHash: "h", storageKey: "k" },
  });
  await prisma.quiz.create({ data: { userId: u.id, courseId: id, count: 1 } });

  const row = (await request(app).get(C).set(u.auth)).body[0];
  assert.equal(row.documentCount, 1);
  assert.equal(row.quizCount, 1);

  assert.equal((await request(app).delete(`${C}/${id}`).set(u.auth)).status, 204);
  assert.equal(await prisma.document.count({ where: { id: doc.id } }), 0);
});
