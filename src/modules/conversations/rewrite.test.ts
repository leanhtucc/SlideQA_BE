import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRewrite, fallbackQuery, HISTORY_MESSAGES, needsRewrite, toHistory } from "./rewrite.js";

test("needsRewrite: câu ngắn hoặc có từ tham chiếu (có dấu hay không dấu) cần viết lại", () => {
  for (const q of ["Nó dùng khi nào?", "no dung khi nao", "Còn cái kia?", "Giải thích thêm đi", "Ví dụ nữa?", "Nó khác gì so với XOR trong tài liệu này?"]) {
    assert.equal(needsRewrite(q), true, q);
  }
});

test("needsRewrite: câu dài, đầy đủ và không có từ tham chiếu thì không cần", () => {
  assert.equal(needsRewrite("Gateway song song chia luồng thành nhiều nhánh chạy đồng thời ra sao"), false);
  assert.equal(needsRewrite("Sự kiện kết thúc đóng quy trình nghiệp vụ như thế nào ở mức mô hình"), false);
});

test("cleanRewrite: lấy dòng đầu, bỏ dấu ngoặc kép và tiền tố, từ chối rỗng hoặc quá dài", () => {
  assert.equal(cleanRewrite('"Pool và lane dùng để làm gì?"\nGiải thích: ...'), "Pool và lane dùng để làm gì?");
  assert.equal(cleanRewrite("Câu hỏi: Gateway XOR khác AND thế nào?"), "Gateway XOR khác AND thế nào?");
  assert.equal(cleanRewrite("   \n  "), null);
  assert.equal(cleanRewrite("x".repeat(400)), null);
});

test("toHistory: chỉ giữ tin gần nhất và cắt ngắn câu trả lời của trợ lý", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), content: i % 2 === 0 ? `hỏi ${i}` : "d".repeat(900) }));
  const h = toHistory(rows);
  assert.equal(h.length, HISTORY_MESSAGES);
  assert.equal(h[0]?.content, "hỏi 4");
  assert.ok(h.filter((t) => t.role === "assistant").every((t) => t.content.length <= 400));
});

test("fallbackQuery: ghép câu hỏi gần nhất của người học; chưa có lịch sử thì giữ nguyên", () => {
  const h = [
    { role: "user" as const, content: "Pool và lane là gì?" },
    { role: "assistant" as const, content: "Dùng để phân chia trách nhiệm [1]" },
  ];
  assert.equal(fallbackQuery(h, "Chúng dùng để làm gì?"), "Pool và lane là gì? Chúng dùng để làm gì?");
  assert.equal(fallbackQuery([], "Chúng dùng để làm gì?"), "Chúng dùng để làm gì?");
});
