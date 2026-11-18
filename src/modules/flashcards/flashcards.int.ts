import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, cleanup, grantConsent, prisma, seedDocument, signup, type TestUser } from "../../test/helpers.js";
import { setLlmClient } from "../../lib/llm/index.js";
import { nextReview } from "./flashcards.service.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const F = "/api/v1/flashcards";
const card = (u: TestUser, body: object = { front: "Gateway XOR là gì?", back: "Chọn đúng một luồng" }) => request(app).post(F).set(u.auth).send(body);
const day = 86_400_000;

test("nextReview: nhớ đi 1→3→7→14 rồi giữ 14; quên về 1 ngày", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  const seq = [1, 3, 7, 14, 14].map((c) => nextReview(c, "remember", now).intervalDays);
  assert.deepEqual(seq, [3, 7, 14, 14, 14]);
  const f = nextReview(14, "forgot", now);
  assert.equal(f.intervalDays, 1);
  assert.equal(f.dueAt.getTime(), now.getTime() + day);
  assert.equal(nextReview(1, "remember", now).dueAt.getTime(), now.getTime() + 3 * day);
});

test("không có token thì 401", async () => {
  assert.equal((await request(app).get(F)).status, 401);
  assert.equal((await request(app).post(F).send({})).status, 401);
});

test("tạo thẻ thủ công: đến hạn ngay, kiểm tra đầu vào, tài liệu phải của mình", async () => {
  const u = await signup();
  const { documentId } = await seedDocument(u.id);
  const ok = await card(u, { front: "  Câu?  ", back: "Đáp án", page: 2, documentId });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.front, ok.body.page, ok.body.documentId, ok.body.intervalDays], ["Câu?", 2, documentId, 1]);
  assert.ok(new Date(ok.body.dueAt).getTime() <= Date.now() + 1000);

  for (const bad of [{ front: "", back: "x" }, { front: "x", back: " " }, { front: "x", back: "y", page: 0 }, { front: "x".repeat(501), back: "y" }]) {
    assert.equal((await card(u, bad)).status, 422, JSON.stringify(bad).slice(0, 40));
  }
  const other = await signup();
  assert.equal((await card(other, { front: "x", back: "y", documentId })).status, 404);
});

test("danh sách: chỉ thẻ của mình; due=true chỉ lấy thẻ đến hạn, sớm nhất trước", async () => {
  const u = await signup();
  const a = (await card(u, { front: "A", back: "a" })).body;
  const b = (await card(u, { front: "B", back: "b" })).body;
  await prisma.flashcard.update({ where: { id: b.id }, data: { dueAt: new Date(Date.now() + 2 * day) } });
  await prisma.flashcard.update({ where: { id: a.id }, data: { dueAt: new Date(Date.now() - day) } });
  const all = (await request(app).get(F).set(u.auth)).body;
  assert.deepEqual(all.map((c: { front: string }) => c.front), ["A", "B"]);
  const due = (await request(app).get(`${F}?due=true`).set(u.auth)).body;
  assert.deepEqual(due.map((c: { front: string }) => c.front), ["A"]);
  const other = await signup();
  assert.deepEqual((await request(app).get(F).set(other.auth)).body, []);
});

test("ôn thẻ: nhớ thì dời lịch theo mốc, quên thì về 1 ngày; người khác không ôn được", async () => {
  const u = await signup();
  const c = (await card(u)).body;
  const r1 = await request(app).post(`${F}/${c.id}/review`).set(u.auth).send({ result: "remember" });
  assert.equal(r1.body.intervalDays, 3);
  assert.ok(Math.abs(new Date(r1.body.dueAt).getTime() - (Date.now() + 3 * day)) < 5000);
  assert.equal((await request(app).get(`${F}?due=true`).set(u.auth)).body.length, 0, "ôn xong thì không còn đến hạn");
  const r2 = await request(app).post(`${F}/${c.id}/review`).set(u.auth).send({ result: "forgot" });
  assert.equal(r2.body.intervalDays, 1);

  assert.equal((await request(app).post(`${F}/${c.id}/review`).set(u.auth).send({ result: "maybe" })).status, 422);
  const other = await signup();
  assert.equal((await request(app).post(`${F}/${c.id}/review`).set(other.auth).send({ result: "remember" })).status, 404);
  assert.equal((await request(app).post(`${F}/${randomUUID()}/review`).set(u.auth).send({ result: "remember" })).status, 404);
});

test("xóa thẻ: của mình thì 204, người khác 404", async () => {
  const u = await signup();
  const c = (await card(u)).body;
  const other = await signup();
  assert.equal((await request(app).delete(`${F}/${c.id}`).set(other.auth)).status, 404);
  assert.equal((await request(app).delete(`${F}/${c.id}`).set(u.auth)).status, 204);
  assert.equal((await request(app).get(F).set(u.auth)).body.length, 0);
});

test("tạo thẻ từ câu sai của một lượt: chỉ câu sai và bỏ trống, không trùng khi bấm lại", async () => {
  const u = await signup();
  await grantConsent(u);
  const { documentId } = await seedDocument(u.id);
  const items = [1, 2, 3].map((p) => ({ question: `Câu ${p}?`, options: [`A${p}`, `B${p}`, `C${p}`, `D${p}`], correct: 1, explanation: `Giải thích ${p}.`, page: p }));
  setLlmClient({ complete: async () => ({ text: JSON.stringify(items), tokensIn: 1, tokensOut: 1 }) });
  const quiz = (await request(app).post("/api/v1/quizzes").set(u.auth).send({ documentId, count: 3 })).body;
  const attempt = (await request(app).post(`/api/v1/quizzes/${quiz.id}/attempts`).set(u.auth)).body.id as string;
  await request(app).put(`/api/v1/attempts/${attempt}/answers/${quiz.items[0].id}`).set(u.auth).send({ chosenIndex: 1 }); // đúng
  await request(app).put(`/api/v1/attempts/${attempt}/answers/${quiz.items[1].id}`).set(u.auth).send({ chosenIndex: 0 }); // sai

  assert.equal((await request(app).post(`${F}/from-attempt/${attempt}`).set(u.auth)).status, 409, "chưa nộp thì chưa tạo được");
  await request(app).post(`/api/v1/attempts/${attempt}/finish`).set(u.auth);

  const res = await request(app).post(`${F}/from-attempt/${attempt}`).set(u.auth);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { created: 2, skipped: 0 });
  const cards = (await request(app).get(F).set(u.auth)).body;
  assert.equal(cards.length, 2);
  const c2 = cards.find((c: { front: string }) => c.front === "Câu 2?");
  assert.equal(c2.back, "B2\nGiải thích 2. (trang 2)");
  assert.deepEqual([c2.page, c2.documentId], [2, documentId]);

  assert.deepEqual((await request(app).post(`${F}/from-attempt/${attempt}`).set(u.auth)).body, { created: 0, skipped: 2 });
  const other = await signup();
  assert.equal((await request(app).post(`${F}/from-attempt/${attempt}`).set(other.auth)).status, 404);
});

test("tạo thẻ từ tài liệu: cần đồng ý AI, loại thẻ sai trang, không tạo trùng khi bấm lại, thẻ đến hạn ngay", async () => {
  const u = await signup();
  const { documentId } = await seedDocument(u.id);
  const body = { documentId, count: 3 };
  assert.equal((await request(app).post(`${F}/from-document`).set(u.auth).send(body)).status, 503, "chưa bật AI");

  const cards = [
    { front: "Khái niệm A?", back: "Là A.", page: 1 },
    { front: "Khái niệm B?", back: "Là B.", page: 2 },
    { front: "Khái niệm ngoài tài liệu?", back: "Sai trang.", page: 999 },
  ];
  setLlmClient({ complete: async () => ({ text: JSON.stringify(cards), tokensIn: 10, tokensOut: 10 }) });
  assert.equal((await request(app).post(`${F}/from-document`).set(u.auth).send(body)).status, 403, "chưa đồng ý gửi dữ liệu");

  await grantConsent(u);
  const res = await request(app).post(`${F}/from-document`).set(u.auth).send(body);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { created: 2, skipped: 0 });
  assert.equal((await request(app).get(`${F}?due=true`).set(u.auth)).body.length, 2, "thẻ mới đến hạn ngay");

  assert.deepEqual((await request(app).post(`${F}/from-document`).set(u.auth).send(body)).body, { created: 0, skipped: 2 });
  assert.equal((await request(app).post(`${F}/from-document`).set(u.auth).send({ documentId, count: 21 })).status, 422);
  const other = await signup();
  assert.equal((await request(app).post(`${F}/from-document`).set(other.auth).send(body)).status, 404);
});
