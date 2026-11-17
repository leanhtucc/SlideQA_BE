import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { app, cleanup, prisma, processNextJob, signup, storageDir, type TestUser } from "../../test/helpers.js";
import { BM25Index } from "../../lib/search/bm25.js";
import { makePdf } from "../../test/pdf.js";

after(cleanup);
const D = "/api/v1/documents";

async function course(u: TestUser, name = "Môn thử") {
  return (await request(app).post("/api/v1/courses").set(u.auth).send({ name })).body.id as string;
}
const upload = (u: TestUser, courseId: string, file: Buffer, filename = "slide.pdf") =>
  request(app).post(D).set(u.auth).field("courseId", courseId).attach("file", file, { filename, contentType: "application/pdf" });
/** Chạy job trích chữ của đúng tài liệu này (không nhận job của test khác). */
const work = async (id: string) => assert.equal(await processNextJob(id), true);
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const parts: Buffer[] = [];
  res.on("data", (c: Buffer) => parts.push(c));
  res.on("end", () => cb(null, Buffer.concat(parts)));
};

test("không có token thì 401", async () => {
  assert.equal((await request(app).get(D)).status, 401);
  assert.equal((await request(app).post(D)).status, 401);
});

test("tải PDF: 202 processing → worker → ready, giữ đúng số trang cho từng đoạn", async () => {
  const u = await signup();
  const cid = await course(u);
  const res = await upload(u, cid, makePdf(["Gateway XOR chon dung mot luong", "Pool va lane phan chia trach nhiem", "Su kien bat dau va ket thuc"]), "Slide BPMN.pdf");
  assert.equal(res.status, 202);
  assert.equal(res.body.status, "processing");
  assert.equal(res.body.name, "Slide BPMN.pdf");
  const id = res.body.id as string;

  await work(id);
  const doc = (await request(app).get(`${D}/${id}`).set(u.auth)).body;
  assert.equal(doc.status, "ready");
  assert.equal(doc.pages, 3);
  assert.equal(doc.emptyPages, 0);
  assert.equal(doc.warning, null);

  const chunks = await prisma.chunk.findMany({ where: { documentId: id }, orderBy: { page: "asc" } });
  assert.deepEqual(chunks.map((c) => c.page), [1, 2, 3]);
  assert.match(chunks[1]?.text ?? "", /Pool va lane/);

  const idx = new BM25Index(chunks.map((c) => ({ id: c.id, docId: c.documentId, page: c.page, part: c.part, text: c.text })));
  assert.equal(idx.search("lane trach nhiem", 1)[0]?.chunk.page, 2);
});

test("trang không có chữ: đếm và cảnh báo (FR-DOC-04)", async () => {
  const u = await signup();
  const res = await upload(u, await course(u), makePdf(["Co chu", "", "Co chu nua", ""]));
  await work(res.body.id);
  const doc = (await request(app).get(`${D}/${res.body.id}`).set(u.auth)).body;
  assert.equal(doc.status, "ready");
  assert.equal(doc.emptyPages, 2);
  assert.match(doc.warning, /2\/4 trang không có chữ/);
  assert.deepEqual((await prisma.chunk.findMany({ where: { documentId: res.body.id } })).map((c) => c.page).sort(), [1, 3]);
});

test("PDF hỏng: nhận file, worker đánh dấu failed, thử lại vẫn failed, tài liệu ready thì không thử lại được", async () => {
  const u = await signup();
  const cid = await course(u);
  const bad = Buffer.from("%PDF-1.4\nđây không phải PDF thật, chỉ có phần đầu giả\n%%EOF");
  const res = await upload(u, cid, bad, "hong.pdf");
  assert.equal(res.status, 202);
  await work(res.body.id);
  const failed = (await request(app).get(`${D}/${res.body.id}`).set(u.auth)).body;
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Không đọc được PDF|Không đọc được nội dung/);

  const retry = await request(app).post(`${D}/${res.body.id}/retry`).set(u.auth);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.status, "processing");
  assert.equal(retry.body.error, null);
  await work(res.body.id);
  assert.equal((await request(app).get(`${D}/${res.body.id}`).set(u.auth)).body.status, "failed");

  const ok = await upload(u, cid, makePdf(["noi dung"]));
  await work(ok.body.id);
  assert.equal((await request(app).post(`${D}/${ok.body.id}/retry`).set(u.auth)).status, 409);
});

test("từ chối tệp không phải PDF, thiếu tệp, thiếu/sai môn học; không để lại gì", async () => {
  const u = await signup();
  const other = await signup();
  const cid = await course(u);
  const before = await prisma.document.count({ where: { userId: u.id } });

  assert.equal((await upload(u, cid, Buffer.from("chỉ là văn bản"), "ghi-chu.pdf")).status, 422, "đuôi .pdf nhưng nội dung không phải PDF");
  assert.equal((await upload(u, cid, makePdf(["x"]), "anh.png")).status, 422, "đúng PDF nhưng đuôi khác");
  const notPdf = await upload(u, cid, Buffer.from("x"), "a.txt");
  assert.equal(notPdf.body.error.code, "not_pdf");
  assert.equal((await request(app).post(D).set(u.auth).field("courseId", cid)).status, 400);
  assert.equal((await request(app).post(D).set(u.auth).attach("file", makePdf(["x"]), "a.pdf")).status, 422);
  assert.equal((await upload(other, cid, makePdf(["x"]))).status, 404, "không tải vào môn của người khác");

  assert.equal(await prisma.document.count({ where: { userId: u.id } }), before);
  assert.equal(await prisma.document.count({ where: { userId: other.id } }), 0);
});

test("tên tệp: bỏ đường dẫn, giữ tiếng Việt; khóa lưu trữ do server sinh", async () => {
  const u = await signup();
  const res = await upload(u, await course(u), makePdf(["x"]), "../../etc/Bài giảng tuần 3.pdf");
  assert.equal(res.status, 202);
  assert.equal(res.body.name, "Bài giảng tuần 3.pdf");
  const row = await prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
  assert.match(row.storageKey, new RegExp(`^${u.id}/[0-9a-f-]{36}\\.pdf$`));
  assert.ok(existsSync(join(storageDir, row.storageKey)));
});

test("hai tài khoản không truy cập chéo tài liệu: xem, sửa, xóa, thử lại, tải tệp đều 404 (NFR-07)", async () => {
  const alice = await signup();
  const bob = await signup();
  const aliceCourse = await course(alice);
  const doc = (await upload(alice, aliceCourse, makePdf(["bi mat"]))).body.id as string;
  await work(doc);

  assert.deepEqual((await request(app).get(D).set(bob.auth)).body, []);
  assert.deepEqual((await request(app).get(`${D}?courseId=${aliceCourse}`).set(bob.auth)).body, []);
  assert.equal((await request(app).get(`${D}/${doc}`).set(bob.auth)).status, 404);
  assert.equal((await request(app).patch(`${D}/${doc}`).set(bob.auth).send({ name: "x" })).status, 404);
  assert.equal((await request(app).post(`${D}/${doc}/retry`).set(bob.auth)).status, 404);
  assert.equal((await request(app).get(`${D}/${doc}/file`).set(bob.auth)).status, 404);
  assert.equal((await request(app).delete(`${D}/${doc}`).set(bob.auth)).status, 404);

  assert.equal((await request(app).get(`${D}/${doc}`).set(alice.auth)).status, 200);
  assert.equal(await prisma.chunk.count({ where: { documentId: doc } }), 1);
});

test("stream PDF: 200 đủ, 206 theo Range, 416 khi sai, đúng header (FR-DOC-06)", async () => {
  const u = await signup();
  const pdf = makePdf(["noi dung de tai ve"]);
  const id = (await upload(u, await course(u), pdf)).body.id as string;
  const url = `${D}/${id}/file`;

  const full = await request(app).get(url).set(u.auth).buffer(true).parse(binary);
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, pdf);
  assert.equal(full.headers["content-type"], "application/pdf");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["cross-origin-resource-policy"], "cross-origin");

  const part = await request(app).get(url).set(u.auth).set("Range", "bytes=0-9").buffer(true).parse(binary);
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 0-9/${pdf.length}`);
  assert.deepEqual(part.body, pdf.subarray(0, 10));

  const tail = await request(app).get(url).set(u.auth).set("Range", "bytes=-5").buffer(true).parse(binary);
  assert.equal(tail.status, 206);
  assert.deepEqual(tail.body, pdf.subarray(pdf.length - 5));

  const open = await request(app).get(url).set(u.auth).set("Range", `bytes=${pdf.length - 3}-`).buffer(true).parse(binary);
  assert.equal(open.status, 206);
  assert.equal(open.body.length, 3);

  const bad = await request(app).get(url).set(u.auth).set("Range", `bytes=${pdf.length + 100}-`);
  assert.equal(bad.status, 416);
  assert.equal(bad.headers["content-range"], `bytes */${pdf.length}`);
  assert.equal((await request(app).get(url)).status, 401);
});

test("đổi tên, chuyển sang môn khác của mình; không chuyển sang môn của người khác", async () => {
  const u = await signup();
  const bob = await signup();
  const c1 = await course(u, "A");
  const c2 = await course(u, "B");
  const bobCourse = await course(bob);
  const id = (await upload(u, c1, makePdf(["x"]))).body.id as string;

  const r = await request(app).patch(`${D}/${id}`).set(u.auth).send({ name: "  Tên mới.pdf ", courseId: c2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, "Tên mới.pdf");
  assert.equal(r.body.courseId, c2);
  assert.equal((await request(app).get(`${D}?courseId=${c1}`).set(u.auth)).body.length, 0);
  assert.equal((await request(app).get(`${D}?courseId=${c2}`).set(u.auth)).body.length, 1);

  assert.equal((await request(app).patch(`${D}/${id}`).set(u.auth).send({ courseId: bobCourse })).status, 404);
  assert.equal((await request(app).patch(`${D}/${id}`).set(u.auth).send({})).status, 422);
});

test("xóa tài liệu: mất chỉ mục và tệp gốc; xóa môn cũng xóa tệp (FR-DOC-05, FR-CRS-03)", async () => {
  const u = await signup();
  const cid = await course(u);
  const a = (await upload(u, cid, makePdf(["mot"]))).body.id as string;
  const b = (await upload(u, cid, makePdf(["hai"]))).body.id as string;
  await work(a);
  const keyA = (await prisma.document.findUniqueOrThrow({ where: { id: a } })).storageKey;
  const keyB = (await prisma.document.findUniqueOrThrow({ where: { id: b } })).storageKey;
  assert.ok(existsSync(join(storageDir, keyA)));

  assert.equal((await request(app).delete(`${D}/${a}`).set(u.auth)).status, 204);
  assert.equal(await prisma.chunk.count({ where: { documentId: a } }), 0);
  assert.equal(existsSync(join(storageDir, keyA)), false);
  assert.equal((await request(app).get(`${D}/${a}`).set(u.auth)).status, 404);

  assert.equal((await request(app).delete(`/api/v1/courses/${cid}`).set(u.auth)).status, 204);
  assert.equal(existsSync(join(storageDir, keyB)), false);
});

test("job của tài liệu đã bị xóa giữa chừng không gây lỗi", async () => {
  const u = await signup();
  const id = (await upload(u, await course(u), makePdf(["x"]))).body.id as string;
  await request(app).delete(`${D}/${id}`).set(u.auth);
  await work(id); // không ném lỗi; job kết thúc
  assert.equal(await prisma.job.count({ where: { payload: { path: ["documentId"], equals: id }, status: "done" } }), 1);
});

test("tải trùng nội dung: cùng content_hash (để P3 hỏi người dùng)", async () => {
  const u = await signup();
  const cid = await course(u);
  const pdf = makePdf(["giong nhau"]);
  const a = (await upload(u, cid, pdf, "a.pdf")).body.id as string;
  const b = (await upload(u, cid, pdf, "b.pdf")).body.id as string;
  const dup = (await upload(u, cid, pdf, "c.pdf")).body;
  assert.deepEqual(dup.duplicateOf, { id: a, name: "a.pdf" });
  assert.equal((await upload(u, cid, makePdf(["khac"]), "d.pdf")).body.duplicateOf, null);
  const other = await signup(); // người khác tải cùng tệp thì không phải trùng
  assert.equal((await upload(other, await course(other), pdf)).body.duplicateOf, null);
  const rows = await prisma.document.findMany({ where: { id: { in: [a, b] } } });
  assert.equal(rows[0]?.contentHash, rows[1]?.contentHash);
  assert.match(rows[0]?.contentHash ?? "", /^[0-9a-f]{64}$/);
});

test("cổng P1: PDF 100 trang xử lý nền xong dưới 60 giây và tìm đúng trang (NFR-03)", async () => {
  const u = await signup();
  const pages = Array.from({ length: 100 }, (_, i) => `Trang so ${i + 1} noi dung rieng zebra${i + 1} va mot it chu chung`);
  const id = (await upload(u, await course(u), makePdf(pages))).body.id as string;
  const t0 = Date.now();
  await work(id);
  const secs = (Date.now() - t0) / 1000;
  const doc = (await request(app).get(`${D}/${id}`).set(u.auth)).body;
  assert.equal(doc.status, "ready");
  assert.equal(doc.pages, 100);
  assert.ok(secs < 60, `mất ${secs}s`);
  console.log(`  100 trang xử lý trong ${secs.toFixed(2)}s`);

  const chunks = await prisma.chunk.findMany({ where: { documentId: id } });
  const idx = new BM25Index(chunks.map((c) => ({ id: c.id, docId: c.documentId, page: c.page, part: c.part, text: c.text })));
  for (const n of [1, 37, 73, 100]) assert.equal(idx.search(`zebra${n}`, 1)[0]?.chunk.page, n);
});
