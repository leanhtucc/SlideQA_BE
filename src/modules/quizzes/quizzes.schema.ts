import { z } from "zod";

export const idParam = z.uuid();

export const createQuizBody = z
  .object({
    documentId: z.uuid("Hãy chọn tài liệu."),
    fromPage: z.number().int("Trang phải là số nguyên.").min(1, "Trang bắt đầu từ 1.").optional(),
    toPage: z.number().int("Trang phải là số nguyên.").min(1, "Trang bắt đầu từ 1.").optional(),
    count: z.number().int("Số câu phải là số nguyên.").min(1, "Tối thiểu 1 câu.").max(10, "Tối đa 10 câu.").default(5),
  })
  .refine((b) => b.fromPage === undefined || b.toPage === undefined || b.fromPage <= b.toPage, {
    path: ["toPage"],
    message: "Trang kết thúc phải lớn hơn hoặc bằng trang bắt đầu.",
  });

export const answerBody = z.object({
  chosenIndex: z.number().int("Đáp án phải là số nguyên.").min(0, "Đáp án từ 0 đến 3.").max(3, "Đáp án từ 0 đến 3."),
});
