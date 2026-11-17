import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const FAKE_KEY = "khoa-gia-cho-test";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost:5432/test";
process.env["JWT_ACCESS_SECRET"] = "test-secret-test-secret-test-secret-123";
process.env["GEMINI_API_KEY"] = FAKE_KEY;
process.env["GEMINI_MODEL"] = "gemini-2.5-flash";
const { gemini } = await import("./gemini.js");
const { LlmError } = await import("./types.js");

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
const seen: { url: string; init: RequestInit }[] = [];
const stub = (res: () => Response) => {
  seen.length = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => (seen.push({ url, init }), res())) as typeof fetch;
};
const REQ = { system: "SYS", user: "USER", maxTokens: 300 };

test("complete: đúng URL, khóa nằm trong header (không trong URL), lấy chữ và token", async () => {
  stub(() => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Xin " }, { text: "chào [1]" }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 } })));
  const r = await gemini.complete(REQ);
  assert.deepEqual(r, { text: "Xin chào [1]", tokensIn: 11, tokensOut: 4 });
  assert.equal(seen[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.ok(!seen[0]?.url.includes(FAKE_KEY));
  assert.equal((seen[0]?.init.headers as Record<string, string>)["x-goog-api-key"], FAKE_KEY);
  const body = JSON.parse(String(seen[0]?.init.body));
  assert.equal(body.systemInstruction.parts[0].text, "SYS");
  assert.equal(body.contents[0].parts[0].text, "USER");
  assert.equal(body.generationConfig.maxOutputTokens, 300);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test("lỗi: 429/5xx thử lại được, 400 thì không; trả rỗng (bị lọc an toàn) là lỗi không thử lại; lỗi không chứa nội dung", async () => {
  for (const [status, retryable] of [[429, true], [503, true], [400, false]] as const) {
    stub(() => new Response("noi dung bi mat", { status }));
    await assert.rejects(gemini.complete(REQ), (e: Error) => e instanceof LlmError && e.retryable === retryable && !e.message.includes("bi mat"));
  }
  stub(() => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })));
  await assert.rejects(gemini.complete(REQ), (e: Error) => e instanceof LlmError && !e.retryable);
});

test("stream: dùng streamGenerateContent?alt=sse, phát từng đoạn, kể cả khi sự kiện bị cắt đôi giữa hai gói", async () => {
  const ev = (t: string, usage?: object) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }], ...(usage ? { usageMetadata: usage } : {}) })}\r\n\r\n`;
  const a = ev("Theo ");
  const parts = [a.slice(0, 15), a.slice(15) + ev("tài liệu ") + ev("[1].", { promptTokenCount: 20, candidatesTokenCount: 6 })];
  stub(() => new Response(new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(new TextEncoder().encode(p))), c.close()) })));
  const got: string[] = [];
  const r = await gemini.complete({ ...REQ, onDelta: (t) => got.push(t) });
  assert.match(seen[0]?.url ?? "", /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(got, ["Theo ", "tài liệu ", "[1]."]);
  assert.deepEqual(r, { text: "Theo tài liệu [1].", tokensIn: 20, tokensOut: 6 });
});
