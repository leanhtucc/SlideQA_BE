import type { Course, Prisma } from "@prisma/client";
import { storage } from "../../lib/storage/index.js";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";

const notFound = () => new AppError(404, "not_found", "Không tìm thấy môn học.");

type CourseWithCounts = Course & { _count: { documents: number; quizzes: number } };

/** documentCount/quizCount để hộp xác nhận xóa nêu rõ số mục bị xóa theo (FR-CRS-03). */
const view = (c: CourseWithCounts) => ({
  id: c.id,
  name: c.name,
  code: c.code,
  term: c.term,
  examDate: c.examDate ? c.examDate.toISOString().slice(0, 10) : null,
  createdAt: c.createdAt,
  documentCount: c._count.documents,
  quizCount: c._count.quizzes,
});

const withCounts = { _count: { select: { documents: true, quizzes: true } } } as const;

// Mọi truy vấn đều có userId của token; không khớp thì coi như không tồn tại (404).

export async function listCourses(userId: string) {
  const rows = await prisma.course.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: withCounts });
  return rows.map(view);
}

export async function getCourse(userId: string, id: string) {
  const row = await prisma.course.findFirst({ where: { id, userId }, include: withCounts });
  if (!row) throw notFound();
  return view(row);
}

export async function createCourse(
  userId: string,
  b: { name: string; code: string | null; term: string | null; examDate: string | null },
) {
  const row = await prisma.course.create({
    data: { userId, name: b.name, code: b.code, term: b.term, examDate: b.examDate ? new Date(b.examDate) : null },
    include: withCounts,
  });
  return view(row);
}

export async function updateCourse(
  userId: string,
  id: string,
  b: { name?: string | undefined; code?: string | null | undefined; term?: string | null | undefined; examDate?: string | null | undefined },
) {
  const data: Prisma.CourseUpdateManyMutationInput = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.code !== undefined) data.code = b.code;
  if (b.term !== undefined) data.term = b.term;
  if (b.examDate !== undefined) data.examDate = b.examDate ? new Date(b.examDate) : null;
  const { count } = await prisma.course.updateMany({ where: { id, userId }, data });
  if (count === 0) throw notFound();
  return getCourse(userId, id);
}

/** Xóa môn xóa luôn tài liệu (cascade trong DB) và các tệp PDF gốc trong kho. */
export async function deleteCourse(userId: string, id: string) {
  const docs = await prisma.document.findMany({ where: { courseId: id, userId }, select: { storageKey: true } });
  const { count } = await prisma.course.deleteMany({ where: { id, userId } });
  if (count === 0) throw notFound();
  await Promise.all(docs.map((d) => storage.remove(d.storageKey)));
}
