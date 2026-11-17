import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupabaseStorage } from "./supabase.js";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
const s = new SupabaseStorage("https://x.supabase.co", "svc-key", "documents");
const calls: { url: string; init: RequestInit }[] = [];
const stub = (fn: (url: string, init: RequestInit) => Response) => {
  calls.length = 0;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => (calls.push({ url, init }), fn(url, init))) as typeof fetch;
};
const chunks = async (r: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c);
  return Buffer.concat(parts).toString();
};

test("put: POST vào bucket riêng, kèm khóa; lỗi thì ném mà không lộ nội dung", async () => {
  const f = join(tmpdir(), `sb-${Date.now()}.pdf`);
  await writeFile(f, "%PDF-1.4 data");
  stub(() => new Response("{}", { status: 200 }));
  await s.put("u1/a b.pdf", f);
  assert.equal(calls[0]?.url, "https://x.supabase.co/storage/v1/object/documents/u1/a%20b.pdf");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["authorization"], "Bearer svc-key");
  stub(() => new Response("secret body", { status: 500 }));
  await assert.rejects(s.put("u1/a.pdf", f), (e: Error) => e.message === "Supabase Storage put: 500 secret body");
  await rm(f);
});

test("size: lấy content-length từ HEAD; thiếu tệp thì ném lỗi", async () => {
  stub(() => new Response(null, { status: 200, headers: { "content-length": "1234" } }));
  assert.equal(await s.size("u1/a.pdf"), 1234);
  assert.equal(calls[0]?.init.method, "HEAD");
  stub(() => new Response(null, { status: 404 }));
  await assert.rejects(s.size("u1/a.pdf"));
});

test("read: trả nội dung, truyền Range; lỗi phía kho làm luồng lỗi", async () => {
  stub(() => new Response("PDFDATA", { status: 206 }));
  assert.equal(await chunks(s.read("u1/a.pdf", { start: 2, end: 5 })), "PDFDATA");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["range"], "bytes=2-5");
  stub(() => new Response("no", { status: 404 }));
  await assert.rejects(chunks(s.read("u1/a.pdf")));
});

test("remove: không lỗi nếu tệp không còn; lỗi khác thì ném", async () => {
  stub(() => new Response("{}", { status: 404 }));
  await s.remove("u1/a.pdf");
  assert.equal(calls[0]?.init.method, "DELETE");
  stub(() => new Response("{}", { status: 500 }));
  await assert.rejects(s.remove("u1/a.pdf"));
});

test("khóa kiểu mới sb_secret_: chỉ gửi apikey, không gửi Authorization Bearer", async () => {
  const sb = new SupabaseStorage("https://x.supabase.co", "sb_secret_khong-phai-khoa-that", "documents");
  stub(() => new Response(null, { status: 200, headers: { "content-length": "5" } }));
  await sb.size("u1/a.pdf");
  const h = calls[0]?.init.headers as Record<string, string>;
  assert.equal(h["apikey"], "sb_secret_khong-phai-khoa-that");
  assert.equal(h["authorization"], undefined);
});

test("URL dán nhầm có đuôi /rest/v1/ vẫn gọi đúng cổng storage", async () => {
  const sb = new SupabaseStorage("https://x.supabase.co/rest/v1/", "khoa", "documents");
  stub(() => new Response(null, { status: 200, headers: { "content-length": "5" } }));
  await sb.size("u1/a.pdf");
  assert.equal(calls[0]?.url, "https://x.supabase.co/storage/v1/object/authenticated/documents/u1/a.pdf");
});
