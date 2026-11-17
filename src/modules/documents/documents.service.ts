import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { Document } from "@prisma/client";
import { enqueueExtract } from "../../lib/jobs/worker.js";
import { invalidateUserIndex } from "../../lib/search/index.js";
import { storage } from "../../lib/storage/index.js";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";

const notFound = () => new AppError(404, "not_found", "Không tìm thấy tài liệu.");

export const view = (d: Document) => ({
  id: d.id,
  courseId: d.courseId,
  name: d.name,
  sizeBytes: d.sizeBytes,
  status: d.status,
  error: d.error,
  pages: d.pages,
  emptyPages: d.emptyPages,
  createdAt: d.createdAt,
  /** FR-DOC-04: nói rõ phần trang không có chữ chưa tìm được */
  warning:
    d.status === "ready" && d.emptyPages > 0
      ? `${d.emptyPages}/${d.pages} trang không có chữ (có thể là ảnh scan). Phần đó chưa tìm kiếm được.`
      : null,
});

// Mọi truy vấn đều có userId của token; không khớp thì 404 (NFR-07).

export async function listDocuments(userId: string, courseId?: string) {
  const rows = await prisma.document.findMany({
    where: { userId, ...(courseId ? { courseId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(view);
}

export async function getDocumentRow(userId: string, id: string) {
  const row = await prisma.document.findFirst({ where: { id, userId } });
  if (!row) throw notFound();
  return row;
}

export const getDocument = async (userId: string, id: string) => view(await getDocumentRow(userId, id));

/** Tên tệp do người dùng gửi chỉ dùng để hiển thị: bỏ thư mục, ký tự điều khiển, giới hạn độ dài. */
export function cleanName(original: string): string {
  // multer đọc tên tệp dạng latin1; đổi lại UTF-8 để giữ tiếng Việt.
  const utf8 = Buffer.from(original, "latin1").toString("utf8");
  const name = (utf8.includes("�") ? original : utf8).split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

/** Đúng PDF khi 1 KB đầu có "%PDF-" (chuẩn cho phép tiêu đề nằm trong 1024 byte đầu). */
async function looksLikePdf(path: string): Promise<boolean> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead).includes("%PDF-");
  } finally {
    await fh.close();
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

export async function createDocument(userId: string, courseId: string, file: { path: string; originalname: string; size: number }) {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true } });
  if (!course) throw new AppError(404, "not_found", "Không tìm thấy môn học.");

  const name = cleanName(file.originalname);
  if (!name.toLowerCase().endsWith(".pdf") || !(await looksLikePdf(file.path))) {
    throw new AppError(422, "not_pdf", "Tệp này không phải PDF. Hãy chọn tệp .pdf.");
  }

  const key = `${userId}/${randomUUID()}.pdf`; // khóa luôn do server sinh (NFR-10)
  await storage.put(key, file.path);
  try {
    const contentHash = await sha256File(file.path);
    // E7: cùng nội dung đã có (của chính người dùng): vẫn nhận tệp, chỉ báo để giao diện hỏi người dùng giữ hay bỏ.
    const same = await prisma.document.findFirst({ where: { userId, contentHash }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
    const doc = await prisma.document.create({ data: { userId, courseId, name, sizeBytes: file.size, contentHash, storageKey: key } });
    await enqueueExtract(doc.id);
    return { ...view(doc), duplicateOf: same };
  } catch (e) {
    await storage.remove(key);
    throw e;
  }
}

export async function updateDocument(userId: string, id: string, b: { name?: string | undefined; courseId?: string | undefined }) {
  if (b.courseId) {
    const course = await prisma.course.findFirst({ where: { id: b.courseId, userId }, select: { id: true } });
    if (!course) throw new AppError(404, "not_found", "Không tìm thấy môn học.");
  }
  const { count } = await prisma.document.updateMany({
    where: { id, userId },
    data: { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.courseId !== undefined ? { courseId: b.courseId } : {}) },
  });
  if (count === 0) throw notFound();
  invalidateUserIndex(userId); // tên và môn nằm trong chỉ mục
  return getDocument(userId, id);
}

/** Xóa dòng DB (kéo theo Chunk) trước, rồi xóa tệp gốc (FR-DOC-05). */
export async function deleteDocument(userId: string, id: string) {
  const doc = await getDocumentRow(userId, id);
  const { count } = await prisma.document.deleteMany({ where: { id, userId } });
  if (count === 0) throw notFound();
  invalidateUserIndex(userId);
  await storage.remove(doc.storageKey);
}

export async function retryDocument(userId: string, id: string) {
  const doc = await getDocumentRow(userId, id);
  if (doc.status !== "failed") throw new AppError(409, "not_failed", "Chỉ thử lại được tài liệu đang ở trạng thái lỗi.");
  const { count } = await prisma.document.updateMany({ where: { id, userId, status: "failed" }, data: { status: "processing", error: null } });
  if (count === 0) throw new AppError(409, "not_failed", "Chỉ thử lại được tài liệu đang ở trạng thái lỗi.");
  await enqueueExtract(id);
  return getDocument(userId, id);
}
