import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { app, cleanup, grantConsent, prisma, seedDocument, signup } from "../../test/helpers.js";
import { LlmError, setLlmClient, type LlmClient, type LlmRequest, type LlmResult } from "../../lib/llm/index.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const C = "/api/v1/conversations";
const OK: LlmResult = { text: "Gateway XOR chọn đúng một luồng đi theo điều kiện [1]. Nguồn bịa [9].", tokensIn: 120, tokensOut: 30 };

/** Client giả đếm số lần gọi và ghi lại prompt. */
function fake(impl: (n: number, req: LlmRequest) => Promise<LlmResult> | LlmResult = () => OK) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      return impl(calls.length, req);
    },
  };
  return { calls, client };
}
const ask = (u: { auth: { authorization: string } }, id: string, question: string) =>
  request(app).post(`${C}/${id}/messages`).set(u.auth).send({ question });
const newConv = async (u: { auth: { authorization: string } }, body: object = {}) => (await request(app).post(C).set(u.auth).send(body)).body.id as string;

test("không có token thì 401", async () => {
  assert.equal((await request(app).get(C)).status, 401);
  assert.equal((await request(app).post(`${C}/${randomUUID()}/messages`).send({ question: "x" })).status, 401);
});

test("chế độ llm: trả lời kèm nguồn đúng trang, lưu tin nhắn, ghi UsageLog, bỏ nguồn bịa", async () => {
  const u = await signup();
  const { documentId } = await seedDocument(u.id);
  await grantConsent(u);
  const f = fake();
  setLlmClient(f.client);
  const id = await newConv(u);

  const res = await ask(u, id, "Gateway XOR dùng để làm gì?");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "llm");
  assert.match(res.body.answer ?? res.body.content, /\[1\]/);
  assert.ok(!(res.body.content as string).includes("[9]"), "nguồn bịa [9] bị bỏ");
  assert.equal(res.body.sources[0].n, 1);
  assert.equal(res.body.sources[0].page, 2);
  assert.equal(res.body.sources[0].documentId, documentId);
  assert.equal(res.body.sources[0].documentName, "Slide BPMN.pdf");
  assert.equal(res.body.sources[0].documentDeleted, false);
  assert.equal(f.calls.length, 1);

  const log = await prisma.usageLog.findFirstOrThrow({ where: { userId: u.id } });
  assert.deepEqual({ kind: log.kind, in: log.tokensIn, out: log.tokensOut }, { kind: "ask", in: 120, out: 30 });

  const conv = (await request(app).get(`${C}/${id}`).set(u.auth)).body;
  assert.deepEqual(conv.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
  assert.equal(conv.messages[1].sources.length, 1 + 0 * 1 || 1, "nguồn lưu cùng tin nhắn");
  assert.equal(conv.title, "Gateway XOR dùng để làm gì?", "tên tự đặt theo câu hỏi đầu");
});

test("prompt gửi mô hình chỉ gồm các đoạn liên quan của chính người dùng (NFR-11)", async () => {
  const alice = await signup();
  const bob = await signup();
  await seedDocument(alice.id, { pages: ["Bí mật quokka của Alice: gateway XOR."] });
  await seedDocument(bob.id);
  await grantConsent(bob);
  const f = fake();
  setLlmClient(f.client);
  await ask(bob, await newConv(bob), "gateway XOR là gì");
  assert.equal(f.calls.length, 1);
  assert.ok(!f.calls[0]!.user.includes("quokka"), "không có dữ liệu của người khác");
  assert.ok(f.calls[0]!.user.includes("Gateway độc quyền XOR"));
  assert.ok(!f.calls[0]!.user.includes("BPMN là chuẩn"), "chỉ gửi các đoạn khớp, không gửi cả tài liệu");
  assert.match(f.calls[0]!.system, /không phải chỉ dẫn/);
});

test("no-match: ngoài tài liệu thì không gọi mô hình, không có nguồn (FR-ASK-04)", async () => {
  const u = await signup();
  await seedDocument(u.id);
  await grantConsent(u);
  const f = fake();
  setLlmClient(f.client);
  const res = await ask(u, await newConv(u), "công thức nấu phở bò");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "no-match");
  assert.match(res.body.content, /Tài liệu không có thông tin này/);
  assert.deepEqual(res.body.sources, []);
  assert.equal(f.calls.length, 0);
});

test("chưa đồng ý gửi dữ liệu: không bao giờ gọi mô hình, trả đoạn gốc; đồng ý rồi mới gọi (FR-SET-01)", async () => {
  const u = await signup();
  await seedDocument(u.id);
  const f = fake();
  setLlmClient(f.client);
  const id = await newConv(u);

  const before = await ask(u, id, "gateway XOR");
  assert.equal(before.body.mode, "extractive");
  assert.match(before.body.content, /chưa đồng ý/);
  assert.ok(before.body.sources.length > 0);
  assert.equal(f.calls.length, 0);

  const g = await grantConsent(u);
  assert.equal(g.status, 200);
  assert.ok(g.body.llmConsentAt);
  assert.equal((await request(app).get("/api/v1/me").set(u.auth)).body.llmConsentAt !== null, true);
  // Mỗi lần hỏi một hội thoại mới: câu nối tiếp trong cùng hội thoại sẽ có thêm một lần gọi AI để viết lại (E3).
  assert.equal((await ask(u, await newConv(u), "gateway XOR")).body.mode, "llm");
  assert.equal(f.calls.length, 1);

  const off = await request(app).put("/api/v1/me/llm-consent").set(u.auth).send({ granted: false });
  assert.equal(off.body.llmConsentAt, null);
  assert.equal((await ask(u, await newConv(u), "gateway XOR")).body.mode, "extractive");
  assert.equal(f.calls.length, 1, "rút lại đồng ý thì ngừng gửi");
  assert.equal((await request(app).put("/api/v1/me/llm-consent").set(u.auth).send({})).status, 422);
});

test("chưa bật AI (không có khóa): chế độ extractive kèm đoạn gốc và trang (FR-ASK-09)", async () => {
  const u = await signup();
  await seedDocument(u.id);
  await grantConsent(u);
  setLlmClient(null);
  const res = await ask(u, await newConv(u), "pool và lane");
  assert.equal(res.body.mode, "extractive");
  assert.match(res.body.content, /chưa được bật/);
  assert.equal(res.body.sources[0].page, 3);
});

test("lỗi AI: thử lại tối đa 2 lần rồi trả extractive; lỗi tạm thời rồi thành công thì vẫn llm (NFR-14)", async () => {
  const u = await signup();
  await seedDocument(u.id);
  await grantConsent(u);
  const id = await newConv(u);

  const down = fake(() => Promise.reject(new LlmError("status 503", true)));
  setLlmClient(down.client);
  const a = await ask(u, id, "gateway XOR");
  assert.equal(a.body.mode, "extractive");
  assert.match(a.body.content, /Chưa thể tổng hợp/);
  assert.equal(down.calls.length, 3, "1 lần gọi + 2 lần thử lại");

  const flaky = fake((n) => (n < 3 ? Promise.reject(new LlmError("status 502", true)) : OK));
  setLlmClient(flaky.client);
  const b = await ask(u, await newConv(u), "gateway XOR");
  assert.equal(b.body.mode, "llm");
  assert.equal(flaky.calls.length, 3);

  const bad = fake(() => Promise.reject(new LlmError("status 400", false)));
  setLlmClient(bad.client);
  assert.equal((await ask(u, await newConv(u), "gateway XOR")).body.mode, "extractive");
  assert.equal(bad.calls.length, 1, "lỗi không tạm thời thì không thử lại");
});

test("phạm vi hội thoại: theo môn hoặc theo tài liệu, ngoài phạm vi là no-match", async () => {
  const u = await signup();
  const a = await seedDocument(u.id, { name: "A.pdf", pages: ["Chuyện về chim cánh cụt ở Nam Cực."] });
  const b = await seedDocument(u.id, { name: "B.pdf", pages: ["Chuyện về gấu trúc ở Tứ Xuyên."] });
  setLlmClient(null);

  const onlyA = await newConv(u, { documentIds: [a.documentId] });
  assert.equal((await ask(u, onlyA, "gấu trúc")).body.mode, "no-match");
  const hitA = await ask(u, onlyA, "chim cánh cụt");
  assert.equal(hitA.body.sources[0].documentId, a.documentId);

  const courseB = await newConv(u, { courseId: b.courseId });
  assert.equal((await ask(u, courseB, "chim cánh cụt")).body.mode, "no-match");
  assert.equal((await ask(u, courseB, "gấu trúc")).body.sources[0].documentId, b.documentId);

  const all = await newConv(u);
  assert.equal((await ask(u, all, "gấu trúc")).body.sources[0].documentId, b.documentId);
});

test("không tạo hội thoại với môn/tài liệu của người khác; hai tài khoản không truy cập chéo (NFR-07)", async () => {
  const alice = await signup();
  const bob = await signup();
  const a = await seedDocument(alice.id);
  const id = await newConv(alice);
  await ask(alice, id, "gateway");

  assert.equal((await request(app).post(C).set(bob.auth).send({ courseId: a.courseId })).status, 404);
  assert.equal((await request(app).post(C).set(bob.auth).send({ documentIds: [a.documentId] })).status, 404);
  assert.deepEqual((await request(app).get(C).set(bob.auth)).body, []);
  assert.equal((await request(app).get(`${C}/${id}`).set(bob.auth)).status, 404);
  assert.equal((await request(app).patch(`${C}/${id}`).set(bob.auth).send({ title: "x" })).status, 404);
  assert.equal((await request(app).delete(`${C}/${id}`).set(bob.auth)).status, 404);
  assert.equal((await ask(bob, id, "gateway")).status, 404);
  assert.equal((await request(app).get(`${C}/khong-phai-uuid`).set(bob.auth)).status, 404);
  assert.equal(await prisma.message.count({ where: { conversationId: id } }), 2, "Bob không thêm được gì");
});

test("đổi tên, tìm theo từ khóa, xóa hội thoại xóa cả tin nhắn và nguồn", async () => {
  const u = await signup();
  await seedDocument(u.id);
  setLlmClient(null);
  const id = await newConv(u, { title: "Ôn BPMN" });
  await ask(u, id, "pool và lane");
  const other = await newConv(u, { title: "Hội thoại khác" });

  assert.equal((await request(app).patch(`${C}/${id}`).set(u.auth).send({ title: "  Tuần 3  " })).body.title, "Tuần 3");
  assert.equal((await request(app).patch(`${C}/${id}`).set(u.auth).send({ title: " " })).status, 422);

  const byTitle = (await request(app).get(`${C}?q=tuần`).set(u.auth)).body.map((c: { id: string }) => c.id);
  assert.deepEqual(byTitle, [id]);
  const byContent = (await request(app).get(`${C}?q=trách nhiệm`).set(u.auth)).body.map((c: { id: string }) => c.id);
  assert.deepEqual(byContent, [id], "tìm được cả trong nội dung tin nhắn");
  assert.equal((await request(app).get(C).set(u.auth)).body[0].id, id, "mới cập nhật lên đầu");
  assert.ok(other);

  assert.equal((await request(app).delete(`${C}/${id}`).set(u.auth)).status, 204);
  assert.equal(await prisma.message.count({ where: { conversationId: id } }), 0);
  assert.equal(await prisma.messageSource.count({ where: { message: { conversationId: id } } }), 0);
  assert.equal((await request(app).get(`${C}/${id}`).set(u.auth)).status, 404);
});

test("xóa tài liệu: nguồn cũ vẫn còn kèm cờ documentDeleted", async () => {
  const u = await signup();
  const { documentId } = await seedDocument(u.id);
  setLlmClient(null);
  const id = await newConv(u);
  await ask(u, id, "gateway XOR");
  await prisma.document.delete({ where: { id: documentId } });
  const conv = (await request(app).get(`${C}/${id}`).set(u.auth)).body;
  const src = conv.messages[1].sources[0];
  assert.equal(src.documentDeleted, true);
  assert.equal(src.documentId, null);
  assert.equal(src.page, 2);
  assert.match(src.snippet, /Gateway/);
});

test("validation: câu hỏi rỗng hoặc quá dài trả 422", async () => {
  const u = await signup();
  const id = await newConv(u);
  assert.equal((await ask(u, id, "   ")).status, 422);
  assert.equal((await ask(u, id, "a".repeat(2001))).status, 422);
  assert.equal((await request(app).post(C).set(u.auth).send({ title: "x".repeat(121) })).status, 422);
});
