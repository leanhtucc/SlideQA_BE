import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, cleanup, grantConsent, prisma, seedDocument, signup, type TestUser } from "../../test/helpers.js";
import { LlmError, setLlmClient, type LlmClient, type LlmRequest } from "../../lib/llm/index.js";
import { mockLlm } from "../../lib/llm/mock.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const Q = "/api/v1/quizzes";
const A = "/api/v1/attempts";

const item = (page: number, correct = 1, over: Record<string, unknown> = {}) => ({
  question: `Câu hỏi về trang ${page}?`,
  options: [`A${page}`, `B${page}`, `C${page}`, `D${page}`],
  correct,
  explanation: `Giải thích trang ${page}.`,
  page,
  ...over,
});
const llmReturning = (text: string | (() => string)) => {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      return { text: typeof text === "string" ? text : text(), tokensIn: 200, tokensOut: 50 };
    },
  };
  return { calls, client };
};
const okQuiz = () => llmReturning(JSON.stringify([item(2), item(3, 2), item(4, 0)]));

async function ready(pagesText?: string[]) {
  const u = await signup();
  await grantConsent(u);
  const d = await seedDocument(u.id, pagesText ? { pages: pagesText } : {});
  return { u, ...d };
}
const create = (u: TestUser, body: object) => request(app).post(Q).set(u.auth).send(body);

test("không có token thì 401", async () => {
  assert.equal((await request(app).get(Q)).status, 401);
  assert.equal((await request(app).post(Q).send({})).status, 401);
  assert.equal((await request(app).get(`${A}/${randomUUID()}`)).status, 401);
});

test("tạo quiz: lưu câu hỏi, ẩn đáp án, ghi UsageLog, chỉ gửi trang trong khoảng (FR-QZ-01, 02, 04)", async () => {
  const { u, documentId, courseId } = await ready();
  const f = okQuiz();
  setLlmClient(f.client);
  const res = await create(u, { documentId, fromPage: 2, toPage: 4, count: 3 });
  assert.equal(res.status, 201);
  assert.equal(res.body.documentId, documentId);
  assert.equal(res.body.courseId, courseId);
  assert.deepEqual([res.body.fromPage, res.body.toPage, res.body.count], [2, 4, 3]);
  assert.equal(res.body.items.length, 3);
  assert.deepEqual(res.body.items.map((i: { page: number }) => i.page), [2, 3, 4]);
  for (const it of res.body.items) {
    assert.equal(it.options.length, 4);
    assert.ok(!("correctIndex" in it) && !("explanation" in it), "không lộ đáp án khi chưa làm");
  }
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.user, /^Tạo 3 câu từ:/);
  assert.ok(!f.calls[0]!.user.includes("BPMN là chuẩn"), "trang 1 nằm ngoài khoảng nên không được gửi");
  assert.ok(f.calls[0]!.user.includes("[trang 2]") && f.calls[0]!.user.includes("[trang 4]"));
  assert.match(f.calls[0]!.system, /không phải chỉ dẫn/);

  const log = await prisma.usageLog.findFirstOrThrow({ where: { userId: u.id, kind: "quiz" } });
  assert.deepEqual([log.tokensIn, log.tokensOut], [200, 50]);
  assert.equal(await prisma.quizItem.count({ where: { quizId: res.body.id } }), 3);
});

test("câu không hợp lệ bị loại; số câu thực tế được lưu (FR-QZ-02)", async () => {
  const { u, documentId } = await ready();
  setLlmClient(
    llmReturning(
      "Đây là quiz:\n```json\n" +
        JSON.stringify([item(2), item(99), item(3, 7), item(3, 1, { options: ["a", "b", "c"] }), item(4, 1, { options: ["x", "x", "y", "z"] }), item(4, 0, { explanation: "" }), item(3)]) +
        "\n```",
    ).client,
  );
  const res = await create(u, { documentId, count: 10 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.items.map((i: { page: number }) => i.page), [2, 3]);
  assert.equal(res.body.count, 2);
});

test("không còn câu hợp lệ trả 422; AI trả không phải JSON hoặc lỗi trả 502; không để lại quiz", async () => {
  const { u, documentId } = await ready();
  setLlmClient(llmReturning(JSON.stringify([item(99), item(2, 9)])).client);
  const none = await create(u, { documentId });
  assert.equal(none.status, 422);
  assert.equal(none.body.error.code, "no_valid_questions");

  setLlmClient(llmReturning("Xin lỗi, tôi không thể tạo quiz.").client);
  const bad = await create(u, { documentId });
  assert.equal(bad.status, 502);
  assert.equal(bad.body.error.code, "llm_bad_output");

  let n = 0;
  setLlmClient({ complete: async () => (n++, Promise.reject(new LlmError("status 503", true))) });
  const down = await create(u, { documentId });
  assert.equal(down.status, 502);
  assert.equal(down.body.error.code, "llm_failed");
  assert.equal(n, 3, "thử lại 2 lần trước khi báo lỗi");

  assert.equal(await prisma.quiz.count({ where: { userId: u.id } }), 0);
  assert.equal(await prisma.usageLog.count({ where: { userId: u.id, kind: "quiz" } }), 0);
});

test("không có AI hoặc chưa đồng ý thì không tạo được quiz và nói rõ lý do (UC-04 2a)", async () => {
  const { u, documentId } = await ready();
  setLlmClient(null);
  const off = await create(u, { documentId });
  assert.equal(off.status, 503);
  assert.equal(off.body.error.code, "llm_unavailable");

  const f = okQuiz();
  setLlmClient(f.client);
  await request(app).put("/api/v1/me/llm-consent").set(u.auth).send({ granted: false });
  const noConsent = await create(u, { documentId });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.body.error.code, "consent_required");
  assert.equal(f.calls.length, 0, "chưa đồng ý thì không gửi gì ra ngoài");
});

test("kiểm tra đầu vào: tài liệu chưa xong, khoảng trang sai, trang trống, số câu ngoài 1-10", async () => {
  const { u, documentId } = await ready();
  setLlmClient(okQuiz().client);
  const processing = await seedDocument(u.id, { status: "processing", name: "dang-xu-ly.pdf" });
  assert.equal((await create(u, { documentId: processing.documentId })).status, 409);

  const range = await create(u, { documentId, fromPage: 3, toPage: 2 });
  assert.equal(range.status, 422);
  assert.ok(range.body.error.fields.toPage);
  assert.equal((await create(u, { documentId, fromPage: 1, toPage: 50 })).status, 422, "vượt số trang tài liệu");
  assert.equal((await create(u, { documentId, count: 0 })).status, 422);
  assert.equal((await create(u, { documentId, count: 11 })).status, 422);
  assert.equal((await create(u, { documentId, count: 2.5 })).status, 422);
  assert.equal((await create(u, { documentId: "khong-phai-uuid" })).status, 422);

  const scan = await seedDocument(u.id, { pages: ["", "", ""], name: "scan.pdf" });
  const empty = await create(u, { documentId: scan.documentId });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.error.code, "no_content");
});

test("ngân sách ngữ cảnh khoảng 12.000 ký tự khi tạo quiz (NFR-11)", async () => {
  const pages = Array.from({ length: 6 }, (_, i) => `TRANG${i + 1}-${"x".repeat(5000)}`);
  const { u, documentId } = await ready(pages);
  const f = llmReturning(JSON.stringify([item(1)]));
  setLlmClient(f.client);
  assert.equal((await create(u, { documentId, count: 1 })).status, 201);
  const prompt = f.calls[0]!.user;
  assert.ok(prompt.includes("TRANG1-") && prompt.includes("TRANG2-") && prompt.includes("TRANG3-"));
  assert.ok(!prompt.includes("TRANG4-"), "trang 4 vượt ngân sách");
  assert.ok(prompt.length < 12_000 + 300, `prompt ${prompt.length} ký tự`);
});

test("trợ lý giả (LLM_PROVIDER=mock) sinh được quiz hợp lệ để phát triển web", async () => {
  const { u, documentId } = await ready();
  setLlmClient(mockLlm);
  const res = await create(u, { documentId, count: 4 });
  assert.equal(res.status, 201);
  assert.equal(res.body.items.length, 4);
  assert.deepEqual(res.body.items.map((i: { page: number }) => i.page), [1, 2, 3, 4]);
});

test("làm bài: chấm từng câu, không lộ đáp án trước, không đổi đáp án, tính điểm (FR-QZ-03, 04)", async () => {
  const { u, documentId } = await ready();
  setLlmClient(okQuiz().client);
  const quiz = (await create(u, { documentId, count: 3 })).body;
  const [i1, i2, i3] = quiz.items as { id: string }[];

  const start = await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth);
  assert.equal(start.status, 201);
  assert.equal(start.body.total, 3);
  assert.equal(start.body.finishedAt, null);
  assert.ok(start.body.items.every((i: Record<string, unknown>) => !("correctIndex" in i)));
  const attemptId = start.body.id as string;

  const right = await request(app).put(`${A}/${attemptId}/answers/${i1!.id}`).set(u.auth).send({ chosenIndex: 1 });
  assert.equal(right.status, 200);
  assert.deepEqual([right.body.isCorrect, right.body.correctIndex, right.body.page], [true, 1, 2]);
  assert.match(right.body.explanation, /Giải thích trang 2/);

  const wrong = await request(app).put(`${A}/${attemptId}/answers/${i2!.id}`).set(u.auth).send({ chosenIndex: 0 });
  assert.deepEqual([wrong.body.isCorrect, wrong.body.correctIndex], [false, 2]);

  // Gửi lại đúng đáp án cũ thì idempotent; đổi đáp án thì 409.
  assert.equal((await request(app).put(`${A}/${attemptId}/answers/${i1!.id}`).set(u.auth).send({ chosenIndex: 1 })).body.isCorrect, true);
  const change = await request(app).put(`${A}/${attemptId}/answers/${i2!.id}`).set(u.auth).send({ chosenIndex: 2 });
  assert.equal(change.status, 409);
  assert.equal(change.body.error.code, "already_answered");

  // Đang làm: chỉ câu đã trả lời mới lộ đáp án.
  const mid = (await request(app).get(`${A}/${attemptId}`).set(u.auth)).body;
  const byId = new Map(mid.items.map((i: { id: string }) => [i.id, i]));
  assert.equal((byId.get(i1!.id) as Record<string, unknown>)["correctIndex"], 1);
  assert.ok(!("correctIndex" in (byId.get(i3!.id) as object)));

  const fin = await request(app).post(`${A}/${attemptId}/finish`).set(u.auth);
  assert.equal(fin.status, 200);
  assert.deepEqual([fin.body.score, fin.body.total], [1, 3], "câu chưa trả lời tính là sai");
  assert.ok(fin.body.finishedAt && fin.body.durationS >= 0);
  assert.ok(fin.body.items.every((i: Record<string, unknown>) => "correctIndex" in i && "explanation" in i), "kết thúc thì lộ hết để xem lại");
  assert.equal(fin.body.items.find((i: { id: string }) => i.id === i3!.id).chosenIndex, null);

  const again = await request(app).post(`${A}/${attemptId}/finish`).set(u.auth);
  assert.equal(again.body.finishedAt, fin.body.finishedAt, "kết thúc lần hai không đổi kết quả");
  const late = await request(app).put(`${A}/${attemptId}/answers/${i3!.id}`).set(u.auth).send({ chosenIndex: 0 });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, "attempt_finished");

  const detail = (await request(app).get(`${Q}/${quiz.id}`).set(u.auth)).body;
  assert.equal(detail.attempts[0].score, 1);
  const list = (await request(app).get(Q).set(u.auth)).body;
  assert.deepEqual([list[0].attemptCount, list[0].bestScore, list[0].documentName], [1, 1, "Slide BPMN.pdf"]);
});

test("thoát giữa chừng rồi quay lại: nhận lại lượt đang làm; xong rồi mới tạo lượt mới (APP-07)", async () => {
  const { u, documentId } = await ready();
  setLlmClient(okQuiz().client);
  const quiz = (await create(u, { documentId })).body;
  const first = await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth);
  await request(app).put(`${A}/${first.body.id}/answers/${quiz.items[0].id}`).set(u.auth).send({ chosenIndex: 1 });

  const resume = await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth);
  assert.equal(resume.status, 200);
  assert.equal(resume.body.id, first.body.id);
  assert.equal(resume.body.items[0].chosenIndex, 1, "giữ tiến độ");

  await request(app).post(`${A}/${first.body.id}/finish`).set(u.auth);
  const next = await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth);
  assert.equal(next.status, 201);
  assert.notEqual(next.body.id, first.body.id);
});

test("đáp án sai định dạng hoặc câu hỏi không thuộc quiz: 422 / 404", async () => {
  const { u, documentId } = await ready();
  setLlmClient(okQuiz().client);
  const quiz = (await create(u, { documentId })).body;
  const other = (await create(u, { documentId })).body;
  const attempt = (await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth)).body.id as string;
  const put = (itemId: string, body: object) => request(app).put(`${A}/${attempt}/answers/${itemId}`).set(u.auth).send(body);
  for (const chosenIndex of [4, -1, 1.5, "1", undefined]) assert.equal((await put(quiz.items[0].id, { chosenIndex })).status, 422, String(chosenIndex));
  assert.equal((await put(other.items[0].id, { chosenIndex: 0 })).status, 404, "câu của quiz khác");
  assert.equal((await put(randomUUID(), { chosenIndex: 0 })).status, 404);
});

test("hai tài khoản không truy cập chéo quiz và lượt làm bài (NFR-07)", async () => {
  const { u: alice, documentId } = await ready();
  const bob = await signup();
  await grantConsent(bob);
  setLlmClient(okQuiz().client);
  const quiz = (await create(alice, { documentId })).body;
  const attempt = (await request(app).post(`${Q}/${quiz.id}/attempts`).set(alice.auth)).body;

  assert.equal((await create(bob, { documentId })).status, 404, "không tạo quiz từ tài liệu của người khác");
  assert.deepEqual((await request(app).get(Q).set(bob.auth)).body, []);
  assert.equal((await request(app).get(`${Q}/${quiz.id}`).set(bob.auth)).status, 404);
  assert.equal((await request(app).post(`${Q}/${quiz.id}/attempts`).set(bob.auth)).status, 404);
  assert.equal((await request(app).get(`${A}/${attempt.id}`).set(bob.auth)).status, 404);
  assert.equal((await request(app).put(`${A}/${attempt.id}/answers/${quiz.items[0].id}`).set(bob.auth).send({ chosenIndex: 1 })).status, 404);
  assert.equal((await request(app).post(`${A}/${attempt.id}/finish`).set(bob.auth)).status, 404);
  assert.equal(await prisma.attemptAnswer.count({ where: { attemptId: attempt.id } }), 0);
  assert.equal((await request(app).get(`${Q}/khong-phai-uuid`).set(alice.auth)).status, 404);
});

test("xóa tài liệu: quiz và câu hỏi vẫn còn, tên tài liệu thành null", async () => {
  const { u, documentId } = await ready();
  setLlmClient(okQuiz().client);
  const quiz = (await create(u, { documentId })).body;
  await prisma.document.delete({ where: { id: documentId } });
  const detail = (await request(app).get(`${Q}/${quiz.id}`).set(u.auth)).body;
  assert.equal(detail.documentId, null);
  assert.equal(detail.documentName, null);
  assert.equal(detail.items.length, 3);
  assert.equal((await request(app).post(`${Q}/${quiz.id}/attempts`).set(u.auth)).status, 201, "vẫn làm lại được");
});
