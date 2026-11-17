import { z } from "zod";

export const idParam = z.uuid();

export const createCardBody = z.object({
  front: z.string().trim().min(1, "Hãy nhập mặt trước.").max(500, "Mặt trước tối đa 500 ký tự."),
  back: z.string().trim().min(1, "Hãy nhập mặt sau.").max(2000, "Mặt sau tối đa 2000 ký tự."),
  page: z.number().int("Trang phải là số nguyên.").min(1, "Trang bắt đầu từ 1.").optional(),
  documentId: z.uuid().optional(),
});

export const listQuery = z.object({
  due: z.enum(["true", "false"]).default("false"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const reviewBody = z.object({ result: z.enum(["remember", "forgot"]) });
