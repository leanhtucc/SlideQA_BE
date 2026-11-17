import type { Flashcard } from "@prisma/client";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";

const notFound = (what = "thẻ") => new AppError(404, "not_found", `Không tìm thấy ${what}.`);

/** Lịch ôn lặp ngắt quãng đơn giản (FR-FC-02): nhớ thì sang mốc kế tiếp, quên thì về 1 ngày. */
export const INTERVALS = [1, 3, 7, 14] as const;
const DAY_MS = 86_400_000;

export function nextReview(current: number, result: "remember" | "forgot", now = new Date()) {
  const next = result === "forgot" ? INTERVALS[0] : (INTERVALS.find((d) => d > current) ?? INTERVALS[INTERVALS.length - 1]!);
  return { intervalDays: next, dueAt: new Date(now.getTime() + next * DAY_MS) };
}

const cardView = (c: Flashcard) => ({
  id: c.id,
  documentId: c.documentId,
  front: c.front,
  back: c.back,
  page: c.page,
  intervalDays: c.intervalDays,
  dueAt: c.dueAt,
  createdAt: c.createdAt,
});

async function assertOwnDocument(userId: string, documentId: string | undefined) {
  if (documentId && !(await prisma.document.findFirst({ where: { id: documentId, userId }, select: { id: true } }))) throw notFound("tài liệu");
}

export async function createCard(userId: string, b: { front: string; back: string; page?: number | undefined; documentId?: string | undefined }) {
  await assertOwnDocument(userId, b.documentId);
  const c = await prisma.flashcard.create({ data: { userId, front: b.front, back: b.back, page: b.page ?? null, documentId: b.documentId ?? null } });
  return cardView(c);
}

export async function listCards(userId: string, dueOnly: boolean, limit: number) {
  const rows = await prisma.flashcard.findMany({
    where: { userId, ...(dueOnly ? { dueAt: { lte: new Date() } } : {}) },
    orderBy: { dueAt: "asc" },
    take: limit,
  });
  return rows.map(cardView);
}

export async function reviewCard(userId: string, id: string, result: "remember" | "forgot") {
  const c = await prisma.flashcard.findFirst({ where: { id, userId } });
  if (!c) throw notFound();
  return cardView(await prisma.flashcard.update({ where: { id }, data: nextReview(c.intervalDays, result) }));
}

export async function deleteCard(userId: string, id: string) {
  const { count } = await prisma.flashcard.deleteMany({ where: { id, userId } });
  if (count === 0) throw notFound();
}

/** Tạo thẻ từ các câu sai hoặc bỏ trống của một lượt đã nộp (FR-FC-01); câu đã có thẻ thì bỏ qua. */
export async function fromAttempt(userId: string, attemptId: string) {
  const a = await prisma.quizAttempt.findFirst({
    where: { id: attemptId, userId },
    include: { answers: true, quiz: { select: { items: { where: { flagged: false }, orderBy: { position: "asc" } } } } },
  });
  if (!a) throw notFound("lượt làm bài");
  if (!a.finishedAt) throw new AppError(409, "attempt_not_finished", "Hãy hoàn thành lượt làm bài trước khi tạo thẻ.");
  const correct = new Set(a.answers.filter((x) => x.isCorrect).map((x) => x.itemId));
  const wrong = a.quiz.items.filter((it) => !correct.has(it.id));
  const existing = await prisma.flashcard.findMany({ where: { userId, front: { in: wrong.map((w) => w.question) } }, select: { front: true, documentId: true } });
  const has = new Set(existing.map((e) => `${e.documentId}|${e.front}`));
  const fresh = wrong.filter((w) => !has.has(`${w.documentId}|${w.question}`));
  if (fresh.length > 0) {
    await prisma.flashcard.createMany({
      data: fresh.map((w) => ({
        userId,
        documentId: w.documentId,
        front: w.question,
        back: `${w.options[w.correctIndex] ?? ""}\n${w.explanation} (trang ${w.page})`,
        page: w.page,
      })),
    });
  }
  return { created: fresh.length, skipped: wrong.length - fresh.length };
}
