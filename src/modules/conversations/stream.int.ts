import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, cleanup, grantConsent, seedDocument, signup } from "../../test/helpers.js";
import { setLlmClient, type LlmClient } from "../../lib/llm/index.js";

after(async () => {
  setLlmClient(undefined);
  await cleanup();
});
beforeEach(() => setLlmClient(undefined));

const C = "/api/v1/conversations";
const SLIDES = ["Gateway độc quyền XOR chọn đúng một luồng đi dựa trên điều kiện."];

const askSse = (u: { auth: { authorization: string } }, id: string) =>
  request(app)
    .post(`${C}/${id}/messages`)
    .set(u.auth)
    .set("Accept", "text/event-stream")
    .send({ question: "Gateway XOR là gì?" })
    .buffer(true)
    .parse((res, cb) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (d += c));
      res.on("end", () => cb(null, d));
    });

const events = (body: string) =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null") }));

async function setup() {
  const u = await signup();
  await seedDocument(u.id, { pages: SLIDES });
  await grantConsent(u);
  const id = (await request(app).post(C).set(u.auth).send({})).body.id as string;
  return { u, id };
}

test("Accept: text/event-stream: nhận từng đoạn chữ rồi tin nhắn đầy đủ, đã lưu", async () => {
  const { u, id } = await setup();
  setLlmClient({
    async complete({ onDelta }) {
      for (const t of ["Theo ", "tài liệu ", "[1]."]) onDelta?.(t);
      return { text: "Theo tài liệu [1].", tokensIn: 5, tokensOut: 3 };
    },
  });
  const res = await askSse(u, id);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /text\/event-stream/);
  const ev = events(res.body as string);
  assert.deepEqual(ev.slice(0, 3).map((e) => [e.event, e.data.text]), [["delta", "Theo "], ["delta", "tài liệu "], ["delta", "[1]."]]);
  const done = ev.at(-1);
  assert.equal(done?.event, "done");
  assert.equal(done?.data.content, "Theo tài liệu [1].");
  assert.equal(done?.data.mode, "llm");
  const saved = (await request(app).get(`${C}/${id}`).set(u.auth)).body.messages;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].content, "Theo tài liệu [1].");
});

test("không có chữ nào để phát (không qua AI): trả JSON như cũ", async () => {
  const { u, id } = await setup();
  setLlmClient(null);
  const res = await request(app).post(`${C}/${id}/messages`).set(u.auth).set("Accept", "text/event-stream").send({ question: "Gateway XOR là gì?" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] ?? "", /json/);
  assert.equal(res.body.mode, "extractive");
});

test("lỗi trước khi có chữ: vẫn là JSON lỗi thường", async () => {
  const { u } = await setup();
  const res = await request(app).post(`${C}/00000000-0000-4000-8000-000000000000/messages`).set(u.auth).set("Accept", "text/event-stream").send({ question: "x" });
  assert.equal(res.status, 404);
});

test("AI lỗi giữa chừng sau khi đã phát chữ: không thử lại (không lặp chữ), dùng đoạn gốc", async () => {
  const { u, id } = await setup();
  let calls = 0;
  const client: LlmClient = {
    async complete({ onDelta }) {
      calls++;
      onDelta?.("Theo ");
      throw new Error("boom");
    },
  };
  setLlmClient(client);
  const ev = events((await askSse(u, id)).body as string);
  assert.equal(calls, 1);
  assert.equal(ev.at(-1)?.event, "done");
  assert.equal(ev.at(-1)?.data.mode, "extractive");
});
