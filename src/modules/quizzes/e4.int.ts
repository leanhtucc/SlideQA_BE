import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, cleanup, grantConsent, seedDocument, signup, type TestUser } from "../../test/helpers.js";
import { setLlmClient, type LlmClient, type LlmRequest } from "../../lib/llm/index.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const Q = "/api/v1/quizzes";
const A = "/api/v1/attempts";
const C = "/api/v1/conversations";

const item = (page: number, correct = 1, over: Record<string, unknown> = {}) => ({
  question: `Câu hỏi về trang ${page}?`,
  options: [`A${page}`, `B${page}`, `C${page}`, `D${page}`],
  correct,
  explanation: `Giải thích trang ${page}.`,
  page,
  ...over,
});
function llmReturning(items: object[]) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      return { text: JSON.stringify(items), tokensIn: 100, tokensOut: 30 };
    },
  };
  return { calls, client };
}

async function quizWith3(u: TestUser, documentId: string) {
  setLlmClient(llmReturning([item(1), item(2), item(3)]).client);
  const q = await request(app).post(Q).set(u.auth).send({ documentId, count: 3 });
  assert.equal(q.status, 201);
  return q.body as { id: string; items: { id: string; page: number }[] };
}
const start = async (u: TestUser, quizId: string) => (await request(app).post(`${Q}/${quizId}/attempts`).set(u.auth)).body.id as string;
const answerItem = (u: TestUser, attemptId: string, itemId: string, chosenIndex: number) => request(app).put(`${A}/${attemptId}/answers/${itemId}`).set(u.auth).send({ chosenIndex });
const finish = (u: TestUser, attemptId: string) => request(app).post(`${A}/${attemptId}/finish`).set(u.auth);

// ---------- quiz theo cả môn ----------

test("quiz cả môn: lấy đoạn từ mọi tài liệu, mỗi câu gắn đúng tài liệu theo trường doc", async () => {
  const u = await signup();
  await grantConsent(u);
  const a = await seedDocument(u.id, { name: "A.pdf", pages: ["Nội dung tài liệu A trang một", "Tài liệu A trang hai"] });
  const b = await seedDocument(u.id, { courseId: a.courseId, name: "B.pdf", pages: ["Nội dung tài liệu B trang một"] });
  const f = llmReturning([item(2, 0, { doc: 1 }), item(1, 0, { doc: 2, question: "Câu về B?" })]);
  setLlmClient(f.client);

  const res = await request(app).post(Q).set(u.auth).send({ courseId: a.courseId, count: 2 });
  assert.equal(res.status, 201);
  assert.equal(res.body.documentId, null);
  assert.equal(res.body.courseId, a.courseId);
  assert.match(f.calls[0]!.user, /Tài liệu 1: A\.pdf/);
  assert.match(f.calls[0]!.user, /Tài liệu 2: B\.pdf/);
  assert.match(f.calls[0]!.system, /"doc"/);
  assert.deepEqual(res.body.items.map((i: { documentId: string }) => i.documentId), [a.documentId, b.documentId]);

  const list = (await request(app).get(Q).set(u.auth)).body;
  assert.equal(list[0].documentName, null);
  assert.equal(list[0].courseName, "Môn thử");
});

test("quiz cả môn: không nêu doc thì gắn với tài liệu đầu tiên có trang đó; từ chối tài liệu lẫn môn, khoảng trang, môn của người khác", async () => {
  const u = await signup();
  await grantConsent(u);
  const a = await seedDocument(u.id, { pages: ["Trang một của A"] });
  const b = await seedDocument(u.id, { courseId: a.courseId, pages: ["Trang một của B"] });
  setLlmClient(llmReturning([item(1)]).client);
  const res = await request(app).post(Q).set(u.auth).send({ courseId: a.courseId, count: 1 });
  assert.equal(res.body.items[0].documentId, a.documentId);
  void b;

  for (const body of [{ courseId: a.courseId, documentId: a.documentId }, {}, { courseId: a.courseId, fromPage: 1 }]) {
    assert.equal((await request(app).post(Q).set(u.auth).send(body)).status, 422, JSON.stringify(body));
  }
  const other = await signup();
  await grantConsent(other);
  assert.equal((await request(app).post(Q).set(other.auth).send({ courseId: a.courseId })).status, 404);
});

test("quiz cả môn: môn không có tài liệu nào dùng được thì 422, không gọi AI", async () => {
  const u = await signup();
  await grantConsent(u);
  const a = await seedDocument(u.id, { status: "processing" });
  const f = llmReturning([item(1)]);
  setLlmClient(f.client);
  const res = await request(app).post(Q).set(u.auth).send({ courseId: a.courseId });
  assert.equal(res.status, 422);
  assert.equal(f.calls.length, 0);
});

// ---------- báo câu có vấn đề ----------

test("báo câu sai: câu biến mất khỏi quiz và các lượt sau, điểm và tổng không tính câu đó", async () => {
  const u = await signup();
  await grantConsent(u);
  const { documentId } = await seedDocument(u.id);
  const quiz = await quizWith3(u, documentId);
  const attempt = await start(u, quiz.id);
  const [i1, i2, i3] = quiz.items;
  assert.equal((await answerItem(u, attempt, i1!.id, 1)).body.isCorrect, true);
  assert.equal((await answerItem(u, attempt, i2!.id, 0)).body.isCorrect, false);

  const flag = await request(app).put(`${Q}/${quiz.id}/items/${i1!.id}/flag`).set(u.auth).send({ flagged: true });
  assert.equal(flag.status, 200);
  assert.deepEqual(flag.body, { flagged: true });

  const open = (await request(app).get(`${A}/${attempt}`).set(u.auth)).body;
  assert.equal(open.total, 2);
  assert.equal(open.items.length, 2);

  const done = (await finish(u, attempt)).body;
  assert.deepEqual([done.score, done.total], [0, 2], "câu đúng bị báo lỗi không còn được tính");
  assert.equal((await request(app).get(`${Q}/${quiz.id}`).set(u.auth)).body.items.length, 2);
  assert.equal((await answerItem(u, attempt, i3!.id, 0)).status, 409);

  const next = (await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth)).body;
  assert.equal(next.total, 2);
  assert.ok(!next.items.some((i: { id: string }) => i.id === i1!.id));

  const unflag = await request(app).put(`${Q}/${quiz.id}/items/${i1!.id}/flag`).set(u.auth).send({ flagged: false });
  assert.equal(unflag.body.flagged, false);
});

test("báo câu sai: người khác hoặc câu không thuộc quiz thì 404; thiếu flagged thì 422", async () => {
  const u = await signup();
  await grantConsent(u);
  const { documentId } = await seedDocument(u.id);
  const quiz = await quizWith3(u, documentId);
  const other = await signup();
  const url = `${Q}/${quiz.id}/items/${quiz.items[0]!.id}/flag`;
  assert.equal((await request(app).put(url).set(other.auth).send({ flagged: true })).status, 404);
  assert.equal((await request(app).put(url).send({ flagged: true })).status, 401);
  assert.equal((await request(app).put(url).set(u.auth).send({})).status, 422);
  const second = await quizWith3(u, documentId);
  assert.equal((await request(app).put(`${Q}/${quiz.id}/items/${second.items[0]!.id}/flag`).set(u.auth).send({ flagged: true })).status, 404);
});

// ---------- làm lại câu sai ----------

test("làm lại câu sai: quiz mới chỉ gồm câu sai và bỏ trống, không gọi AI, không cần đồng ý", async () => {
  const u = await signup();
  await grantConsent(u);
  const { documentId } = await seedDocument(u.id);
  const quiz = await quizWith3(u, documentId);
  const attempt = await start(u, quiz.id);
  const [i1, i2] = quiz.items;
  await answerItem(u, attempt, i1!.id, 1); // đúng
  await answerItem(u, attempt, i2!.id, 0); // sai; câu 3 bỏ trống

  assert.equal((await request(app).post(`${A}/${attempt}/retry-wrong`).set(u.auth)).status, 409, "chưa kết thúc thì chưa làm lại được");
  await finish(u, attempt);

  const f = llmReturning([]);
  setLlmClient(f.client);
  const res = await request(app).post(`${A}/${attempt}/retry-wrong`).set(u.auth);
  assert.equal(res.status, 201);
  assert.equal(f.calls.length, 0);
  assert.notEqual(res.body.id, quiz.id);
  assert.equal(res.body.documentId, documentId);
  assert.equal(res.body.count, 2);
  assert.deepEqual(res.body.items.map((i: { page: number }) => i.page), [2, 3]);
  assert.equal(res.body.items[0].correctIndex, undefined, "đáp án vẫn ẩn khi làm bài");

  const retry = await request(app).post(`${Q}/${res.body.id}/attempts`).set(u.auth);
  assert.equal(retry.status, 201);
  assert.equal(retry.body.total, 2);
  assert.equal((await request(app).get(`${Q}/${quiz.id}`).set(u.auth)).body.attempts.length, 1, "quiz gốc không bị đụng tới");
});

test("làm lại câu sai: đúng hết thì 409; người khác thì 404; câu bị báo lỗi không được đưa vào", async () => {
  const u = await signup();
  await grantConsent(u);
  const { documentId } = await seedDocument(u.id);
  const quiz = await quizWith3(u, documentId);
  const attempt = await start(u, quiz.id);
  for (const it of quiz.items) await answerItem(u, attempt, it.id, 1);
  await finish(u, attempt);
  assert.equal((await request(app).post(`${A}/${attempt}/retry-wrong`).set(u.auth)).status, 409);
  const other = await signup();
  assert.equal((await request(app).post(`${A}/${attempt}/retry-wrong`).set(other.auth)).status, 404);

  const quiz2 = await quizWith3(u, documentId);
  const at2 = await start(u, quiz2.id);
  await finish(u, at2); // bỏ trống cả ba
  await request(app).put(`${Q}/${quiz2.id}/items/${quiz2.items[0]!.id}/flag`).set(u.auth).send({ flagged: true });
  const res = await request(app).post(`${A}/${at2}/retry-wrong`).set(u.auth);
  assert.equal(res.body.count, 2);
});

// ---------- đánh giá câu trả lời ----------

test("đánh giá câu trả lời: 👍 👎 và bỏ đánh giá, chỉ trên tin của trợ lý và hội thoại của mình", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: ["Gateway XOR chọn một luồng"] });
  setLlmClient(null);
  const conv = (await request(app).post(C).set(u.auth).send({})).body.id as string;
  const asked = (await request(app).post(`${C}/${conv}/messages`).set(u.auth).send({ question: "Gateway XOR là gì?" })).body;
  const url = (id: string, c = conv) => `${C}/${c}/messages/${id}/feedback`;

  assert.equal(asked.feedback, null);
  assert.deepEqual((await request(app).put(url(asked.id)).set(u.auth).send({ value: -1 })).body, { feedback: -1 });
  const got = (await request(app).get(`${C}/${conv}`).set(u.auth)).body;
  assert.equal(got.messages.find((m: { id: string }) => m.id === asked.id).feedback, -1);
  assert.deepEqual((await request(app).put(url(asked.id)).set(u.auth).send({ value: 1 })).body, { feedback: 1 });
  assert.deepEqual((await request(app).put(url(asked.id)).set(u.auth).send({ value: null })).body, { feedback: null });

  assert.equal((await request(app).put(url(asked.id)).set(u.auth).send({ value: 2 })).status, 422);
  assert.equal((await request(app).put(url(asked.id)).send({ value: 1 })).status, 401);
  const userMsg = got.messages.find((m: { role: string }) => m.role === "user");
  assert.equal((await request(app).put(url(userMsg.id)).set(u.auth).send({ value: 1 })).status, 404, "không đánh giá tin của chính mình");
  const other = await signup();
  assert.equal((await request(app).put(url(asked.id)).set(other.auth).send({ value: 1 })).status, 404);
});
