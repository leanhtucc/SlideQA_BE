import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCardPrompt, validateCards } from "./generate.js";

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
