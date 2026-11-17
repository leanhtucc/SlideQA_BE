import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, cleanup, grantConsent, seedDocument, signup, type TestUser } from "../../test/helpers.js";
import { setLlmClient } from "../../lib/llm/index.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const S = "/api/v1/stats";
const stats = async (u: TestUser) => (await request(app).get(S).set(u.auth)).body;

async function playQuiz(u: TestUser, documentId: string, count: number, picks: number[]) {
  const items = Array.from({ length: count }, (_, i) => ({ question: `Q${i + 1} ${Math.random()}?`, options: ["a", "b", "c", "d"], correct: 1, explanation: "e", page: i + 1 }));
  setLlmClient({ complete: async () => ({ text: JSON.stringify(items), tokensIn: 1, tokensOut: 1 }) });
  const quiz = (await request(app).post("/api/v1/quizzes").set(u.auth).send({ documentId, count })).body;
  const attempt = (await request(app).post(`/api/v1/quizzes/${quiz.id}/attempts`).set(u.auth)).body.id as string;
  for (const [i, p] of picks.entries()) await request(app).put(`/api/v1/attempts/${attempt}/answers/${quiz.items[i].id}`).set(u.auth).send({ chosenIndex: p });
  await request(app).post(`/api/v1/attempts/${attempt}/finish`).set(u.auth);
}

test("không có token thì 401", async () => {
  assert.equal((await request(app).get(S)).status, 401);
});

test("người dùng mới: mọi số bằng 0 và chưa có điểm trung bình", async () => {
  const u = await signup();
  assert.deepEqual(await stats(u), {
    documents: 0,
    questions: 0,
    quizzes: 0,
    attempts: 0,
    averageScorePct: null,
    flashcards: { total: 0, due: 0 },
    courses: [],
    weakTopics: [],
  });
});

test("đếm tài liệu, câu hỏi, quiz, thẻ; điểm trung bình theo từng môn; chỗ hay sai", async () => {
  const u = await signup();
  await grantConsent(u);
  const a = await seedDocument(u.id, { name: "A.pdf", pages: ["Gateway XOR chọn một luồng", "Gateway AND song song", "Pool và lane"] });
  const b = await seedDocument(u.id, { name: "B.pdf", pages: ["Nội dung khác", "Thêm nội dung"] });

  setLlmClient(null);
  const conv = (await request(app).post("/api/v1/conversations").set(u.auth).send({})).body.id as string;
  await request(app).post(`/api/v1/conversations/${conv}/messages`).set(u.auth).send({ question: "Gateway XOR là gì?" });
  await request(app).post(`/api/v1/conversations/${conv}/messages`).set(u.auth).send({ question: "Gateway AND là gì?" });
  await request(app).post("/api/v1/flashcards").set(u.auth).send({ front: "f", back: "b" });

  await playQuiz(u, a.documentId, 2, [1, 1]); // môn A: 100%
  await playQuiz(u, a.documentId, 2, [1, 0]); // môn A: 50%, sai câu trang 2
  await playQuiz(u, b.documentId, 2, [0, 0]); // môn B: 0%, sai trang 1 và 2

  const s = await stats(u);
  assert.deepEqual([s.documents, s.questions, s.quizzes, s.attempts], [2, 2, 3, 3]);
  assert.deepEqual(s.flashcards, { total: 1, due: 1 });
  assert.equal(s.averageScorePct, 50, "(100 + 50 + 0) / 3");
  const byCourse = Object.fromEntries(s.courses.map((c: { id: string }) => [c.id, c]));
  assert.deepEqual([byCourse[a.courseId].averageScorePct, byCourse[a.courseId].attempts, byCourse[a.courseId].documents], [75, 2, 1]);
  assert.equal(byCourse[b.courseId].averageScorePct, 0);

  assert.equal(s.weakTopics.length, 3);
  assert.deepEqual(s.weakTopics.map((w: { documentName: string; page: number; wrong: number }) => [w.documentName, w.page, w.wrong]), [["B.pdf", 1, 1], ["A.pdf", 2, 1], ["B.pdf", 2, 1]], "bằng số lần sai thì theo trang");
});

test("thống kê chỉ của riêng mình, người khác không thấy dữ liệu của bạn", async () => {
  const u = await signup();
  await seedDocument(u.id);
  await request(app).post("/api/v1/flashcards").set(u.auth).send({ front: "f", back: "b" });
  const other = await signup();
  const s = await stats(other);
  assert.deepEqual([s.documents, s.flashcards.total, s.courses.length], [0, 0, 0]);
});
