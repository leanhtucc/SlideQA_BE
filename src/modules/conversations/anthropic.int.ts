import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

// Máy chủ giả đúng định dạng Messages API; chưa bao giờ gọi API Anthropic thật.
const KEY = "sk-ant-test-khong-phai-khoa-that";
const seen: { headers: IncomingMessage["headers"]; body: any }[] = [];
let script: (n: number) => { status: number; json?: unknown } = () => ({ status: 200 });

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
    const { status, json } = script(seen.length);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json ?? {}));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

process.env["ANTHROPIC_API_KEY"] = KEY;
process.env["ANTHROPIC_BASE_URL"] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env["ANTHROPIC_MODEL"] = "claude-test-model";
const { app, cleanup, grantConsent, seedDocument, signup } = await import("../../test/helpers.js");
const { setLlmClient } = await import("../../lib/llm/index.js");
setLlmClient(undefined); // dùng client Anthropic thật trỏ tới máy chủ giả
after(async () => {
  server.close();
  await cleanup();
});

const OKJSON = { content: [{ type: "text", text: "Gateway XOR chọn một luồng [1]." }], usage: { input_tokens: 77, output_tokens: 9 } };
async function setup() {
  const u = await signup();
  await seedDocument(u.id);
  await grantConsent(u);
  const id = (await request(app).post("/api/v1/conversations").set(u.auth).send({})).body.id as string;
  seen.length = 0;
  return { u, id };
}
const ask = (u: { auth: { authorization: string } }, id: string) =>
  request(app).post(`/api/v1/conversations/${id}/messages`).set(u.auth).send({ question: "gateway XOR dùng để làm gì" });

test("health báo AI bật khi có khóa", async () => {
  assert.equal((await request(app).get("/api/v1/health")).body.llmEnabled, true);
});

test("gọi đúng định dạng Messages API và ghi token thật", async () => {
  const { u, id } = await setup();
  script = () => ({ status: 200, json: OKJSON });
  const res = await ask(u, id);
  assert.equal(res.body.mode, "llm");
  assert.match(res.body.content, /Gateway XOR chọn một luồng \[1\]/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.headers["x-api-key"], KEY);
  assert.equal(seen[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen[0]!.body.model, "claude-test-model");
  assert.equal(seen[0]!.body.messages[0].role, "user");
  assert.match(seen[0]!.body.messages[0].content, /CÂU HỎI: gateway XOR dùng để làm gì/);
  assert.ok(!JSON.stringify(res.body).includes(KEY), "khóa API không lộ ra client");
});

test("máy chủ AI trả 503: thử lại 2 lần (3 request) rồi trả đoạn gốc (NFR-14)", async () => {
  const { u, id } = await setup();
  script = () => ({ status: 503 });
  const res = await ask(u, id);
  assert.equal(seen.length, 3);
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "extractive");
  assert.ok(res.body.sources.length > 0);
});

test("lỗi 500 rồi thành công ở lần thử lại: vẫn llm", async () => {
  const { u, id } = await setup();
  script = (n) => (n === 1 ? { status: 500 } : { status: 200, json: OKJSON });
  const res = await ask(u, id);
  assert.equal(seen.length, 2);
  assert.equal(res.body.mode, "llm");
});

test("lỗi 401 (sai khóa) không thử lại và không lộ lỗi chi tiết ra client", async () => {
  const { u, id } = await setup();
  script = () => ({ status: 401, json: { error: { message: "invalid x-api-key" } } });
  const res = await ask(u, id);
  assert.equal(seen.length, 1);
  assert.equal(res.body.mode, "extractive");
  assert.ok(!JSON.stringify(res.body).includes("x-api-key"));
});

test("phản hồi rỗng được coi là lỗi, không phải câu trả lời", async () => {
  const { u, id } = await setup();
  script = () => ({ status: 200, json: { content: [], usage: {} } });
  assert.equal((await ask(u, id)).body.mode, "extractive");
});
