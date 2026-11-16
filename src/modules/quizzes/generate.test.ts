import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuizPrompt, parseQuizJson, takePassages, validateItems } from "./generate.js";

const good = (over: Record<string, unknown> = {}) => ({
  question: "Gateway XOR làm gì?",
  options: ["Chọn một luồng", "Chạy mọi luồng", "Kết thúc quy trình", "Bắt đầu quy trình"],
  correct: 0,
  explanation: "XOR chọn đúng một luồng.",
  page: 2,
  ...over,
});
const PAGES = new Set([1, 2, 3]);

test("câu hợp lệ được giữ nguyên", () => {
  const [q] = validateItems([good()], PAGES, 10);
  assert.deepEqual(q, { question: "Gateway XOR làm gì?", options: ["Chọn một luồng", "Chạy mọi luồng", "Kết thúc quy trình", "Bắt đầu quy trình"], correctIndex: 0, explanation: "XOR chọn đúng một luồng.", page: 2 });
});

test("loại câu có số trang không tồn tại trong ngữ cảnh (FR-QZ-02)", () => {
  assert.equal(validateItems([good({ page: 99 })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ page: 0 })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ page: "2" })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ page: 2.5 })], PAGES, 10).length, 0);
});

test("loại câu không đủ 4 đáp án khác nhau hoặc đáp án đúng ngoài 0-3", () => {
  assert.equal(validateItems([good({ options: ["a", "b", "c"] })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ options: ["a", "b", "c", "d", "e"] })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ options: ["a", "B", "c", "b"] })], PAGES, 10).length, 0, "trùng đáp án");
  assert.equal(validateItems([good({ options: ["a", "b", "c", ""] })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ options: ["a", "b", "c", 4] })], PAGES, 10).length, 0);
  for (const correct of [4, -1, 1.5, "0", null]) assert.equal(validateItems([good({ correct })], PAGES, 10).length, 0, String(correct));
});

test("loại câu thiếu câu hỏi hoặc giải thích, phần tử không phải object", () => {
  assert.equal(validateItems([good({ question: " " })], PAGES, 10).length, 0);
  assert.equal(validateItems([good({ explanation: "" })], PAGES, 10).length, 0);
  assert.equal(validateItems([null, 5, "x", [], good()], PAGES, 10).length, 1);
});

test("loại câu trùng và cắt theo số lượng yêu cầu", () => {
  const many = [1, 2, 3, 4].map((i) => good({ question: `Câu ${i}?` }));
  assert.equal(validateItems([good(), good()], PAGES, 10).length, 1);
  assert.equal(validateItems(many, PAGES, 2).length, 2);
});

test("chấp nhận khóa correctIndex thay cho correct", () => {
  const { correct: _c, ...rest } = good();
  assert.equal(validateItems([{ ...rest, correctIndex: 3 }], PAGES, 10)[0]?.correctIndex, 3);
});

test("parseQuizJson: bọc ```json, có lời dẫn, hoặc không phải JSON", () => {
  const arr = JSON.stringify([good()]);
  assert.equal(parseQuizJson(arr)?.length, 1);
  assert.equal(parseQuizJson("```json\n" + arr + "\n```")?.length, 1);
  assert.equal(parseQuizJson("Đây là câu hỏi:\n" + arr + "\nChúc bạn học tốt")?.length, 1);
  assert.equal(parseQuizJson("không có mảng nào"), null);
  assert.equal(parseQuizJson("[{hỏng json"), null);
  assert.equal(parseQuizJson('{"a": 1}'), null);
});

test("takePassages: tôn trọng ngân sách ký tự, giữ thứ tự và số trang", () => {
  const chunks = [1, 2, 3, 4].map((page) => ({ page, text: "x".repeat(500) }));
  const out = takePassages(chunks, 1200);
  assert.deepEqual(out.map((p) => p.page), [1, 2, 3]);
  assert.equal(out.reduce((n, p) => n + p.text.length, 0), 1200, "đoạn cuối bị cắt cho vừa");
  assert.equal(takePassages(chunks, 0).length, 0);
});

test("buildQuizPrompt gắn nhãn [trang N] và số câu", () => {
  const p = buildQuizPrompt([{ page: 7, text: "nội dung" }], 3);
  assert.match(p, /^Tạo 3 câu từ:/);
  assert.match(p, /\[trang 7\]\nnội dung/);
});
