import { z } from "zod";

export const idParam = z.uuid();

export const listQuery = z.object({ courseId: z.uuid("courseId không hợp lệ.").optional() });

export const uploadBody = z.object({ courseId: z.uuid("Hãy chọn môn học để tải tài liệu lên.") });

export const updateDocumentBody = z
  .object({
    name: z.string().trim().min(1, "Tên tài liệu không được để trống.").max(200, "Tên tài liệu tối đa 200 ký tự."),
    courseId: z.uuid("courseId không hợp lệ."),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Không có trường nào để cập nhật.");
