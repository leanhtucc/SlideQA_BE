import "../db/guard.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

// Phải đặt env trước khi import app (env.ts đọc process.env lúc import).
process.env["JWT_ACCESS_SECRET"] ??= "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["LOGIN_RATE_MAX"] = "1000";
process.env["LLM_RETRY_BASE_MS"] ??= "1"; // thử lại nhanh trong test
export const storageDir = mkdtempSync(join(tmpdir(), "slideqa-test-"));
process.env["STORAGE_DIR"] = storageDir;
export const { app } = await import("../app.js");
export const { prisma } = await import("../prisma.js");
// Import qua đây (không import trực tiếp ở file test) để env.ts luôn đọc STORAGE_DIR sau khi đã đặt ở trên.
export const { processNextJob } = await import("../lib/jobs/worker.js");

const { invalidateUserIndex } = await import("../lib/search/index.js");

export const SLIDES = [
  "BPMN là chuẩn mô hình hóa quy trình nghiệp vụ do OMG ban hành.",
  "Gateway độc quyền XOR chọn đúng một luồng đi dựa trên điều kiện.",
  "Pool và lane dùng để phân chia trách nhiệm giữa các bên tham gia.",
  "Sự kiện bắt đầu, sự kiện trung gian và sự kiện kết thúc là ba nhóm sự kiện.",
];

/** Tạo môn + tài liệu có sẵn các đoạn (mỗi trang một đoạn), chèn thẳng DB để dùng được tiếng Việt có dấu. */
export async function seedDocument(
  userId: string,
  opts: { courseId?: string; name?: string; pages?: string[]; status?: "ready" | "processing" | "failed" } = {},
) {
  const courseId = opts.courseId ?? (await prisma.course.create({ data: { userId, name: "Môn thử" } })).id;
  const pages = opts.pages ?? SLIDES;
  const doc = await prisma.document.create({
    data: {
      userId,
      courseId,
      name: opts.name ?? "Slide BPMN.pdf",
      sizeBytes: 1,
      pages: pages.length,
      contentHash: "h",
      storageKey: `seed/${randomUUID()}`,
      status: opts.status ?? "ready",
    },
  });
  await prisma.chunk.createMany({ data: pages.map((text, i) => ({ documentId: doc.id, page: i + 1, text })) });
  invalidateUserIndex(userId);
  return { courseId, documentId: doc.id };
}

/** Người dùng đồng ý gửi đoạn tài liệu cho nhà cung cấp AI. */
export const grantConsent = (u: { auth: { authorization: string } }) =>
  request(app).put("/api/v1/me/llm-consent").set(u.auth).send({ granted: true });

const emails: string[] = [];
export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: { authorization: string };
}

export async function signup(): Promise<TestUser> {
  const email = `t-${randomUUID()}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password: "mat-khau-thu-123", displayName: "Tester", acceptTerms: true });
  if (res.status !== 201) throw new Error(`signup lỗi: ${res.status}`);
  return { id: res.body.user.id, email, token: res.body.accessToken, auth: { authorization: `Bearer ${res.body.accessToken}` } };
}

/** Gọi trong after() của mỗi file test. */
export async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
  await rm(storageDir, { recursive: true, force: true });
}
