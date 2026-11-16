import { z } from "zod";

const name = z.string().trim().min(1, "Hãy nhập tên môn học.").max(120, "Tên môn học tối đa 120 ký tự.");
const code = z.string().trim().max(30, "Mã môn tối đa 30 ký tự.");
const term = z.string().trim().max(40, "Học kỳ tối đa 40 ký tự.");
const examDate = z.iso.date("Ngày thi phải có dạng YYYY-MM-DD.");

/** Chuỗi rỗng coi như không có giá trị. */
const blankToNull = (s: string | null | undefined) => (s && s.length > 0 ? s : null);

export const createCourseBody = z.object({
  name,
  code: code.nullish().transform(blankToNull),
  term: term.nullish().transform(blankToNull),
  examDate: examDate.nullish().transform((d) => d ?? null),
});

export const updateCourseBody = z
  .object({
    name,
    code: code.nullable().transform(blankToNull),
    term: term.nullable().transform(blankToNull),
    examDate: examDate.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Không có trường nào để cập nhật.");

/** id sai định dạng cũng trả 404, không tiết lộ gì (SRS mục 3). */
export const courseId = z.uuid();
