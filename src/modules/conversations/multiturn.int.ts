import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, cleanup, grantConsent, seedDocument, signup } from "../../test/helpers.js";
import { setLlmClient, type LlmClient, type LlmRequest } from "../../lib/llm/index.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const C = "/api/v1/conversations";
type Auth = { auth: { authorization: string } };
const ask = (u: Auth, id: string, question: string) => request(app).post(`${C}/${id}/messages`).set(u.auth).send({ question });
const newConv = async (u: Auth) => (await request(app).post(C).set(u.auth).send({})).body.id as string;

const SLIDES = [
  "Gateway độc quyền XOR chọn đúng một luồng đi dựa trên điều kiện.",
  "Gateway song song AND chia luồng thành nhiều nhánh chạy đồng thời.",
  "Pool và lane dùng để phân chia trách nhiệm giữa các bên tham gia.",
  "Sự kiện bắt đầu khởi tạo quy trình, sự kiện kết thúc đóng quy trình.",
  "Sequence flow là mũi tên nối các phần tử theo thứ tự thực hiện.",
];

/** Bộ 5 câu nối tiếp: [câu hỏi đầu, câu nối tiếp, trang đúng của câu nối tiếp]. */
const FOLLOW_UPS: [string, string, number][] = [
  ["Gateway XOR là gì?", "Nó chọn luồng dựa vào gì?", 1],
  ["Gateway song song AND là gì?", "Nó chạy đồng thời mấy nhánh?", 2],
  ["Pool và lane là gì?", "Chúng dùng để làm gì?", 3],
  ["Sự kiện kết thúc là gì?", "Còn sự kiện bắt đầu thì sao?", 4],
  ["Sequence flow là gì?", "Nó nối các phần tử theo thứ tự nào?", 5],
];

function scripted(rewrites: Record<string, string> = {}, fail = false) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(req) {
      calls.push(req);
      const isRewrite = req.system.includes("viết lại câu hỏi nối tiếp");
      if (isRewrite) {
        if (fail) throw new Error("rewrite boom");
        const q = /CÂU HỎI NỐI TIẾP: (.*)$/.exec(req.user)?.[1] ?? "";
        return { text: rewrites[q] ?? q, tokensIn: 40, tokensOut: 15 };
      }
      return { text: "Theo tài liệu [1].", tokensIn: 100, tokensOut: 10 };
    },
  };
  return { calls, client, rewriteCalls: () => calls.filter((c) => c.system.includes("viết lại câu hỏi nối tiếp")) };
}

for (const [first, follow, page] of FOLLOW_UPS) {
  test(`không có AI (dự phòng): "${follow}" sau "${first}" vẫn tìm đúng trang ${page}`, async () => {
    setLlmClient(null);
    const u = await signup();
    await seedDocument(u.id, { pages: SLIDES });
    const id = await newConv(u);
    assert.equal((await ask(u, id, first)).status, 200);
    const res = await ask(u, id, follow);
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "extractive");
    assert.equal(res.body.sources[0]?.page, page, `câu nối tiếp phải trỏ đúng trang ${page}`);
    assert.equal(res.body.searchQuery, null);
  });
}

test("câu nối tiếp hỏi riêng lẻ (không có lịch sử) không tìm được đoạn: chứng tỏ lịch sử có tác dụng", async () => {
  setLlmClient(null);
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  const alone = await ask(u, await newConv(u), "Nó thì sao?");
  assert.equal(alone.body.mode, "no-match");

  const id = await newConv(u);
  await ask(u, id, "Pool và lane là gì?");
  const withHistory = await ask(u, id, "Nó thì sao?");
  assert.equal(withHistory.body.sources[0]?.page, 3);
});

test("có AI + đồng ý: viết lại câu nối tiếp, tìm bằng câu đã viết lại, lưu và trả searchQuery", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  await grantConsent(u);
  const s = scripted({ "Chúng dùng để làm gì?": "Pool và lane dùng để làm gì trong BPMN?" });
  setLlmClient(s.client);
  const id = await newConv(u);

  await ask(u, id, "Pool và lane là gì?");
  assert.equal(s.rewriteCalls().length, 0, "câu đầu tiên của hội thoại không cần viết lại");

  const res = await ask(u, id, "Chúng dùng để làm gì?");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "llm");
  assert.equal(res.body.sources[0].page, 3);
  assert.equal(res.body.searchQuery, "Pool và lane dùng để làm gì trong BPMN?");

  const rw = s.rewriteCalls();
  assert.equal(rw.length, 1);
  assert.match(rw[0]!.user, /Người học: Pool và lane là gì\?/, "lịch sử gồm câu hỏi trước");
  assert.match(rw[0]!.user, /Trợ lý: /, "và câu trả lời trước");
  assert.match(rw[0]!.user, /CÂU HỎI NỐI TIẾP: Chúng dùng để làm gì\?/);

  const answerCall = s.calls[s.calls.length - 1]!;
  assert.match(answerCall.user, /LỊCH SỬ HỘI THOẠI/);
  assert.match(answerCall.user, /Câu hỏi đầy đủ: Pool và lane dùng để làm gì trong BPMN\?/);
  assert.match(answerCall.system, /không phải nguồn sự thật/);

  const conv = (await request(app).get(`${C}/${id}`).set(u.auth)).body;
  const last = conv.messages[conv.messages.length - 1];
  assert.equal(last.searchQuery, "Pool và lane dùng để làm gì trong BPMN?");
  assert.equal(conv.messages[0].searchQuery ?? null, null);
});

test("câu dài, đầy đủ thì không gọi viết lại (tiết kiệm một lần gọi AI)", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  await grantConsent(u);
  const s = scripted();
  setLlmClient(s.client);
  const id = await newConv(u);
  await ask(u, id, "Pool và lane là gì?");
  const res = await ask(u, id, "Gateway song song AND chia luồng thành nhiều nhánh chạy đồng thời ra sao");
  assert.equal(res.status, 200);
  assert.equal(s.rewriteCalls().length, 0);
  assert.equal(res.body.searchQuery, null);
});

test("chưa đồng ý: tuyệt đối không gửi lịch sử hay câu hỏi cho AI, vẫn dùng dự phòng", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  const s = scripted();
  setLlmClient(s.client);
  const id = await newConv(u);
  await ask(u, id, "Pool và lane là gì?");
  const res = await ask(u, id, "Chúng dùng để làm gì?");
  assert.equal(s.calls.length, 0);
  assert.equal(res.body.mode, "extractive");
  assert.equal(res.body.sources[0].page, 3);
});

test("AI viết lại bị lỗi: dùng dự phòng và vẫn trả lời, không vỡ", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  await grantConsent(u);
  const s = scripted({}, true);
  setLlmClient(s.client);
  const id = await newConv(u);
  await ask(u, id, "Pool và lane là gì?");
  const res = await ask(u, id, "Chúng dùng để làm gì?");
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "llm");
  assert.equal(res.body.sources[0].page, 3);
  assert.equal(res.body.searchQuery, null);
});

test("UsageLog cộng cả token của bước viết lại", async () => {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  await grantConsent(u);
  setLlmClient(scripted().client);
  const id = await newConv(u);
  await ask(u, id, "Pool và lane là gì?");
  await ask(u, id, "Chúng dùng để làm gì?");
  const { prisma } = await import("../../test/helpers.js");
  const logs = await prisma.usageLog.findMany({ where: { userId: u.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.map((l) => [l.tokensIn, l.tokensOut]), [[100, 10], [140, 25]]);
});
