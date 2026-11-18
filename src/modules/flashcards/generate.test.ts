import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCardPrompt, CARD_CONTEXT_CHARS, planBatches, validateCards } from "./generate.js";

const PAGES = new Set([1, 2, 3]);
const good = (over: Record<string, unknown> = {}) => ({ front: "Gateway XOR là gì?", back: "Chọn đúng một luồng.", page: 2, ...over });

test("thẻ hợp lệ được giữ nguyên và cắt khoảng trắng", () => {
  assert.deepEqual(validateCards([good({ front: "  Câu?  " })], PAGES, 10), [{ front: "Câu?", back: "Chọn đúng một luồng.", page: 2 }]);
});

test("loại thẻ thiếu mặt, trang ngoài ngữ cảnh, không phải object", () => {
  for (const bad of [good({ front: " " }), good({ back: "" }), good({ page: 99 }), good({ page: "2" }), good({ page: 1.5 }), null, 5, "x"]) {
    assert.equal(validateCards([bad], PAGES, 10).length, 0, JSON.stringify(bad));
  }
});

test("loại thẻ trùng câu hỏi (không phân biệt hoa thường) và dừng ở số lượng tối đa", () => {
  assert.equal(validateCards([good(), good({ front: "GATEWAY xor là gì?" })], PAGES, 10).length, 1);
  assert.equal(validateCards([1, 2, 3].map((p) => good({ front: `Câu ${p}?`, page: p })), PAGES, 2).length, 2);
});

test("prompt có nhãn trang và số thẻ cần tạo", () => {
  assert.match(buildCardPrompt([{ page: 3, text: "nội dung" }], 12), /Tạo 12 thẻ từ:\n\n\[trang 3\]\nnội dung/);
});

const chunk = (page: number, len = 1000) => ({ page, text: "x".repeat(len) });

test("planBatches: tài liệu dài chia nhiều lô trải đều, tổng số thẻ đúng yêu cầu", () => {
  const chunks = Array.from({ length: 100 }, (_, i) => chunk(i + 1, 4000)); // 400k ký tự, nhiều lô
  const plan = planBatches(chunks, 100);
  assert.equal(plan.length, 7); // ceil(100/15)
  assert.equal(plan.reduce((n, b) => n + b.count, 0), 100);
  for (const b of plan) assert.ok(b.passages.reduce((n, p) => n + p.text.length, 0) <= CARD_CONTEXT_CHARS);
  const firstPages = plan.map((b) => b.passages[0]!.page);
  assert.deepEqual(firstPages, [...firstPages].sort((a, b) => a - b), "lô theo thứ tự trang");
  assert.ok(firstPages[firstPages.length - 1]! > 50, "có lô ở nửa sau tài liệu");
});

test("planBatches: tài liệu ngắn dùng một lô, không đòi quá 25 thẻ mỗi lô, tài liệu rỗng thì không có lô", () => {
  assert.deepEqual(planBatches([chunk(1), chunk(2)], 10).map((b) => b.count), [10]);
  assert.deepEqual(planBatches([chunk(1)], 100).map((b) => b.count), [25]);
  assert.deepEqual(planBatches([], 10), []);
});
