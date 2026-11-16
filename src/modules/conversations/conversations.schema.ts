import { z } from "zod";

export const idParam = z.uuid();

export const createConversationBody = z.object({
  title: z.string().trim().min(1).max(120, "Tên hội thoại tối đa 120 ký tự.").optional(),
  /** Phạm vi hỏi: bỏ trống cả hai = tất cả tài liệu của bạn */
  courseId: z.uuid("courseId không hợp lệ.").optional(),
  documentIds: z.array(z.uuid()).max(50, "Tối đa 50 tài liệu trong một phạm vi.").optional(),
});

export const renameBody = z.object({ title: z.string().trim().min(1, "Tên hội thoại không được để trống.").max(120, "Tên hội thoại tối đa 120 ký tự.") });

export const askBody = z.object({
  question: z.string().trim().min(1, "Hãy nhập câu hỏi.").max(2000, "Câu hỏi tối đa 2000 ký tự."),
});

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const consentBody = z.object({ granted: z.boolean() });
