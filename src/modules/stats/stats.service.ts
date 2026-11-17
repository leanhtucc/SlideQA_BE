import { prisma } from "../../prisma.js";

const WEAK_TOP = 5;

/** Thống kê tổng quan của riêng người dùng (FR-ST-01) và các chỗ hay sai để ôn lại (FR-ST-02). Mọi truy vấn lọc theo userId. */
export async function getStats(userId: string) {
  const [documents, questions, quizzes, attempts, cardTotal, cardDue, courses, wrongAnswers] = await Promise.all([
    prisma.document.count({ where: { userId } }),
    prisma.message.count({ where: { role: "user", conversation: { userId } } }),
    prisma.quiz.count({ where: { userId } }),
    prisma.quizAttempt.findMany({
      where: { userId, finishedAt: { not: null }, score: { not: null }, total: { gt: 0 } },
      select: { score: true, total: true, quiz: { select: { courseId: true } } },
    }),
    prisma.flashcard.count({ where: { userId } }),
    prisma.flashcard.count({ where: { userId, dueAt: { lte: new Date() } } }),
    prisma.course.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, _count: { select: { documents: true, quizzes: true } } },
    }),
    prisma.attemptAnswer.findMany({
      where: { isCorrect: false, attempt: { userId, finishedAt: { not: null } }, item: { flagged: false } },
      select: { item: { select: { documentId: true, page: true, document: { select: { name: true } } } } },
    }),
  ]);

  // Điểm trung bình là trung bình phần trăm đúng của từng lượt đã nộp, để quiz nhiều hay ít câu đều có trọng số như nhau.
  const pct = (a: { score: number | null; total: number }) => ((a.score ?? 0) / a.total) * 100;
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

  // Chỗ hay sai: gộp theo (tài liệu, trang), nhiều lần sai nhất trước.
  const weak = new Map<string, { documentId: string | null; documentName: string | null; page: number; wrong: number }>();
  for (const { item } of wrongAnswers) {
    const key = `${item.documentId}|${item.page}`;
    const w = weak.get(key) ?? { documentId: item.documentId, documentName: item.document?.name ?? null, page: item.page, wrong: 0 };
    w.wrong += 1;
    weak.set(key, w);
  }

  return {
    documents,
    questions,
    quizzes,
    attempts: attempts.length,
    averageScorePct: avg(attempts.map(pct)),
    flashcards: { total: cardTotal, due: cardDue },
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      documents: c._count.documents,
      quizzes: c._count.quizzes,
      attempts: attempts.filter((a) => a.quiz.courseId === c.id).length,
      averageScorePct: avg(attempts.filter((a) => a.quiz.courseId === c.id).map(pct)),
    })),
    weakTopics: [...weak.values()].sort((a, b) => b.wrong - a.wrong || a.page - b.page).slice(0, WEAK_TOP),
  };
}
