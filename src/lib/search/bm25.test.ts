import { test } from "node:test";
import assert from "node:assert/strict";
import { BM25Index, chunkPages, foldDiacritics, tokenize } from "./bm25.js";

const pages = [
  { page: 1, text: "BPMN là chuẩn mô hình hóa quy trình nghiệp vụ do OMG ban hành." },
  { page: 2, text: "Gateway độc quyền XOR chọn đúng một luồng đi dựa trên điều kiện." },
  { page: 3, text: "Pool và lane dùng để phân chia trách nhiệm giữa các bên tham gia." },
  { page: 4, text: "Sự kiện bắt đầu, sự kiện trung gian và sự kiện kết thúc là ba nhóm sự kiện." },
];
const idx = new BM25Index(chunkPages("d1", pages));

test("bỏ dấu đúng, kể cả đ", () => {
  assert.equal(foldDiacritics("Đường đi điều kiện"), "Duong di dieu kien");
});

test("tìm đúng trang với câu hỏi có dấu", () => {
  assert.equal(idx.search("gateway XOR dùng để làm gì", 1)[0]?.chunk.page, 2);
});

test("tìm đúng trang với câu hỏi không dấu", () => {
  assert.equal(idx.search("pool va lane phan chia trach nhiem", 1)[0]?.chunk.page, 3);
});

test("câu hỏi ngoài chủ đề trả về rỗng", () => {
  assert.equal(idx.search("công thức nấu phở bò", 3).length, 0);
});

test("lọc theo tài liệu", () => {
  const two = new BM25Index([...chunkPages("a", pages), ...chunkPages("b", pages)]);
  const hits = two.search("gateway XOR", 5, (c) => c.docId === "b");
  assert.ok(hits.length > 0 && hits.every((h) => h.chunk.docId === "b"));
});

test("trang dài được cắt nhưng giữ số trang", () => {
  const long = [{ page: 7, text: Array.from({ length: 60 }, (_, i) => `Đoạn số ${i} ` + "x".repeat(60)).join("\n") }];
  const cs = chunkPages("d", long, 500);
  assert.ok(cs.length > 1 && cs.every((c) => c.page === 7));
});

test("tokenize sinh bigram", () => {
  assert.ok(tokenize("sự kiện kết thúc").includes("kien_ket"));
});
