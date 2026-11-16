import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, cleanup, prisma, processNextJob, signup, type TestUser } from "../../test/helpers.js";
import { makePdf } from "../../test/pdf.js";
import { invalidateUserIndex, searchChunks } from "./index.js";

after(cleanup);

const SLIDES = [
  "BPMN là chuẩn mô hình hóa quy trình nghiệp vụ do OMG ban hành.",
  "Gateway độc quyền XOR chọn đúng một luồng đi dựa trên điều kiện.",
  "Pool và lane dùng để phân chia trách nhiệm giữa các bên tham gia.",
  "Sự kiện bắt đầu, sự kiện trung gian và sự kiện kết thúc là ba nhóm sự kiện.",
];

async function course(u: TestUser, name = "M") {
  return (await prisma.course.create({ data: { userId: u.id, name } })).id;
}
/** Tạo tài liệu đã sẵn sàng với mỗi trang một đoạn (chèn thẳng DB để dùng được tiếng Việt có dấu). */
async function doc(u: TestUser, courseId: string, name: string, pages = SLIDES, status: "ready" | "processing" | "failed" = "ready") {
  const d = await prisma.document.create({
    data: { userId: u.id, courseId, name, sizeBytes: 1, pages: pages.length, contentHash: "h", storageKey: `k/${name}`, status },
  });
  await prisma.chunk.createMany({ data: pages.map((text, i) => ({ documentId: d.id, page: i + 1, text })) });
  invalidateUserIndex(u.id);
  return d.id;
}

test("tìm đúng trang với câu hỏi có dấu và không dấu, kèm tên tài liệu và môn", async () => {
  const u = await signup();
  const c = await course(u);
  const d = await doc(u, c, "Slide BPMN.pdf");

  const a = await searchChunks(u.id, "gateway XOR dùng để làm gì");
  assert.equal(a[0]?.page, 2);
  assert.equal(a[0]?.documentId, d);
  assert.equal(a[0]?.documentName, "Slide BPMN.pdf");
  assert.equal(a[0]?.courseId, c);

  assert.equal((await searchChunks(u.id, "pool va lane phan chia trach nhiem"))[0]?.page, 3);
  assert.equal((await searchChunks(u.id, "su kien ket thuc"))[0]?.page, 4);
});

test("câu hỏi ngoài tài liệu, câu rỗng, câu quá dài: không có kết quả và không lỗi", async () => {
  const u = await signup();
  await doc(u, await course(u), "a.pdf");
  assert.deepEqual(await searchChunks(u.id, "công thức nấu phở bò"), []);
  assert.deepEqual(await searchChunks(u.id, ""), []);
  assert.deepEqual(await searchChunks(u.id, "   "), []);
  assert.ok(Array.isArray(await searchChunks(u.id, "gateway ".repeat(5000))));
});

test("không tìm thấy tài liệu của người khác (NFR-07)", async () => {
  const alice = await signup();
  const bob = await signup();
  const ad = await doc(alice, await course(alice), "alice.pdf", ["Từ khóa bí mật quokka chỉ có ở Alice."]);
  const bobCourse = await course(bob);
  const bd = await doc(bob, bobCourse, "bob.pdf");

  assert.equal((await searchChunks(alice.id, "quokka"))[0]?.documentId, ad);
  assert.deepEqual(await searchChunks(bob.id, "quokka"), []);

  // Bob cố chỉ định tài liệu/môn của Alice trong phạm vi vẫn không ra gì.
  assert.deepEqual(await searchChunks(bob.id, "quokka", { documentIds: [ad] }), []);
  const aliceCourse = (await prisma.document.findUniqueOrThrow({ where: { id: ad } })).courseId;
  assert.deepEqual(await searchChunks(bob.id, "quokka", { courseId: aliceCourse }), []);

  const hits = await searchChunks(bob.id, "gateway XOR");
  assert.ok(hits.length > 0 && hits.every((h) => h.documentId === bd));
});

test("lọc theo phạm vi: tất cả, một môn, một số tài liệu", async () => {
  const u = await signup();
  const c1 = await course(u, "A");
  const c2 = await course(u, "B");
  const d1 = await doc(u, c1, "một.pdf");
  const d2 = await doc(u, c1, "hai.pdf");
  const d3 = await doc(u, c2, "ba.pdf");

  const ids = (hs: { documentId: string }[]) => new Set(hs.map((h) => h.documentId));
  assert.deepEqual(ids(await searchChunks(u.id, "gateway XOR", {}, 10)), new Set([d1, d2, d3]));
  assert.deepEqual(ids(await searchChunks(u.id, "gateway XOR", { courseId: c1 }, 10)), new Set([d1, d2]));
  assert.deepEqual(ids(await searchChunks(u.id, "gateway XOR", { courseId: c2 }, 10)), new Set([d3]));
  assert.deepEqual(ids(await searchChunks(u.id, "gateway XOR", { documentIds: [d2, d3] }, 10)), new Set([d2, d3]));
  assert.deepEqual(ids(await searchChunks(u.id, "gateway XOR", { courseId: c1, documentIds: [d3] }, 10)), new Set(), "giao của hai điều kiện");
  assert.equal((await searchChunks(u.id, "gateway XOR", {}, 2)).length, 2, "giới hạn k");
});

test("chỉ tài liệu đã sẵn sàng mới được tìm", async () => {
  const u = await signup();
  const c = await course(u);
  await doc(u, c, "dang-xu-ly.pdf", ["Từ khóa narwhal đang xử lý."], "processing");
  await doc(u, c, "loi.pdf", ["Từ khóa narwhal bị lỗi."], "failed");
  assert.deepEqual(await searchChunks(u.id, "narwhal"), []);
});

test("chỉ mục tự cập nhật: tải lên xong, đổi tên, chuyển môn, xóa tài liệu, xóa môn", async () => {
  const u = await signup();
  const c1 = (await request(app).post("/api/v1/courses").set(u.auth).send({ name: "C1" })).body.id as string;
  const c2 = (await request(app).post("/api/v1/courses").set(u.auth).send({ name: "C2" })).body.id as string;

  assert.deepEqual(await searchChunks(u.id, "okapi"), [], "nạp cache khi còn rỗng");
  const up = await request(app).post("/api/v1/documents").set(u.auth).field("courseId", c1).attach("file", makePdf(["trang mot", "con okapi o trang hai"]), "dong-vat.pdf");
  assert.deepEqual(await searchChunks(u.id, "okapi"), [], "đang xử lý thì chưa tìm được");
  await processNextJob(up.body.id);
  const found = await searchChunks(u.id, "okapi");
  assert.equal(found[0]?.page, 2);
  assert.equal(found[0]?.documentName, "dong-vat.pdf");

  await request(app).patch(`/api/v1/documents/${up.body.id}`).set(u.auth).send({ name: "Động vật.pdf" });
  assert.equal((await searchChunks(u.id, "okapi"))[0]?.documentName, "Động vật.pdf");

  await request(app).patch(`/api/v1/documents/${up.body.id}`).set(u.auth).send({ courseId: c2 });
  assert.equal((await searchChunks(u.id, "okapi", { courseId: c1 })).length, 0);
  assert.equal((await searchChunks(u.id, "okapi", { courseId: c2 })).length, 1);

  await request(app).delete(`/api/v1/documents/${up.body.id}`).set(u.auth);
  assert.deepEqual(await searchChunks(u.id, "okapi"), []);

  const up2 = await request(app).post("/api/v1/documents").set(u.auth).field("courseId", c1).attach("file", makePdf(["okapi nua"]), "b.pdf");
  await processNextJob(up2.body.id);
  assert.equal((await searchChunks(u.id, "okapi")).length, 1);
  await request(app).delete(`/api/v1/courses/${c1}`).set(u.auth);
  assert.deepEqual(await searchChunks(u.id, "okapi"), []);
});

test("nhiều lần tìm đồng thời cho cùng người dùng cho cùng kết quả", async () => {
  const u = await signup();
  await doc(u, await course(u), "x.pdf");
  const rs = await Promise.all(Array.from({ length: 10 }, () => searchChunks(u.id, "gateway XOR")));
  assert.ok(rs.every((r) => r[0]?.page === 2 && r.length === rs[0]!.length));
});

test("hiệu năng: 5.000 đoạn của một người dùng, tìm dưới 1 giây (NFR-01)", async () => {
  const u = await signup();
  const c = await course(u);
  const words = Array.from({ length: 400 }, (_, i) => `tu${i}`);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pages = Array.from({ length: 5000 }, (_, i) => `${i === 4321 ? "dacbiet xylophone " : ""}${Array.from({ length: 60 }, () => words[Math.floor(rnd() * words.length)]).join(" ")}`);
  await doc(u, c, "lon.pdf", pages);

  const t0 = performance.now();
  const cold = await searchChunks(u.id, "xylophone");
  const coldMs = performance.now() - t0;
  assert.equal(cold[0]?.page, 4322);

  const t1 = performance.now();
  const warm = await searchChunks(u.id, "xylophone tu5 tu77");
  const warmMs = performance.now() - t1;
  assert.ok(warm.length > 0);
  console.log(`  5000 đoạn: nạp + tìm lần đầu ${coldMs.toFixed(0)} ms, tìm lần sau ${warmMs.toFixed(1)} ms`);
  assert.ok(warmMs < 1000, `tìm mất ${warmMs} ms`);
});
