import type { AttemptAnswer, Quiz, QuizAttempt, QuizItem } from "@prisma/client";
import { completeWithRetry, getLlm } from "../../lib/llm/index.js";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";
import { buildQuizPrompt, parseQuizJson, QUIZ_SYSTEM, takePassages, validateItems } from "./generate.js";

const notFound = (what = "bài quiz") => new AppError(404, "not_found", `Không tìm thấy ${what}.`);

// ---------- hiển thị ----------

const quizView = (q: Quiz) => ({
  id: q.id,
  documentId: q.documentId,
  courseId: q.courseId,
  fromPage: q.fromPage,
  toPage: q.toPage,
  count: q.count,
  createdAt: q.createdAt,
});

/** Khi làm bài chưa lộ đáp án và giải thích; server chấm từng câu (FR-QZ-03). */
const itemPublic = (i: QuizItem) => ({ id: i.id, position: i.position, question: i.question, options: i.options, page: i.page, documentId: i.documentId });

const attemptSummary = (a: QuizAttempt) => ({
  id: a.id,
  quizId: a.quizId,
  score: a.score,
  total: a.total,
  durationS: a.durationS,
  startedAt: a.startedAt,
  finishedAt: a.finishedAt,
});

// ---------- tạo quiz ----------

export async function createQuiz(userId: string, b: { documentId: string; fromPage?: number | undefined; toPage?: number | undefined; count: number }) {
  const doc = await prisma.document.findFirst({ where: { id: b.documentId, userId } });
  if (!doc) throw notFound("tài liệu");
  if (doc.status !== "ready") throw new AppError(409, "document_not_ready", "Tài liệu chưa xử lý xong, hãy thử lại sau.");

  const fromPage = b.fromPage ?? 1;
  const toPage = b.toPage ?? doc.pages;
  if (fromPage > doc.pages || toPage > doc.pages) {
    throw new AppError(422, "validation_error", `Tài liệu chỉ có ${doc.pages} trang.`, { toPage: `Tài liệu chỉ có ${doc.pages} trang.` });
  }

  // Quiz cần mô hình nên không có chế độ thay thế: nói rõ lý do (UC-04 luồng 2a).
  const llm = getLlm();
  if (!llm) throw new AppError(503, "llm_unavailable", "Chức năng quiz cần trợ lý AI, hiện chưa được bật.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { llmConsentAt: true } });
  if (!user.llmConsentAt) throw new AppError(403, "consent_required", "Bạn cần đồng ý gửi đoạn tài liệu cho nhà cung cấp AI trước khi tạo quiz.");

  const chunks = await prisma.chunk.findMany({
    where: { documentId: doc.id, page: { gte: fromPage, lte: toPage } },
    orderBy: [{ page: "asc" }, { part: "asc" }],
    select: { page: true, text: true },
  });
  const passages = takePassages(chunks.filter((c) => c.text.trim().length > 0));
  if (passages.length === 0) throw new AppError(422, "no_content", "Không có nội dung chữ ở khoảng trang này. Hãy thử khoảng trang khác.");

  let raw;
  try {
    raw = await completeWithRetry(llm, { system: QUIZ_SYSTEM, user: buildQuizPrompt(passages, b.count), maxTokens: 2500 });
  } catch (e) {
    console.warn("quiz llm failed:", e instanceof Error ? e.message : "unknown"); // không ghi nội dung (NFR-08)
    throw new AppError(502, "llm_failed", "Không tạo được quiz lúc này. Hãy thử lại sau.");
  }
  const parsed = parseQuizJson(raw.text);
  if (!parsed) throw new AppError(502, "llm_bad_output", "Trợ lý AI trả về kết quả không đọc được. Hãy thử lại.");
  const items = validateItems(parsed, new Set(passages.map((p) => p.page)), b.count);
  if (items.length === 0) throw new AppError(422, "no_valid_questions", "Không tạo được câu hỏi hợp lệ, hãy thử khoảng trang khác.");

  const quiz = await prisma.$transaction(async (tx) => {
    const q = await tx.quiz.create({
      data: {
        userId,
        documentId: doc.id,
        courseId: doc.courseId,
        fromPage,
        toPage,
        count: items.length,
        items: { create: items.map((it, position) => ({ position, documentId: doc.id, question: it.question, options: it.options, correctIndex: it.correctIndex, explanation: it.explanation, page: it.page })) },
      },
      include: { items: { orderBy: { position: "asc" } } },
    });
    await tx.usageLog.create({ data: { userId, kind: "quiz", tokensIn: raw.tokensIn, tokensOut: raw.tokensOut } });
    return q;
  });
  return { ...quizView(quiz), items: quiz.items.map(itemPublic) };
}

// ---------- xem quiz ----------

export async function listQuizzes(userId: string) {
  const rows = await prisma.quiz.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { document: { select: { name: true } }, attempts: { select: { score: true, finishedAt: true } } },
  });
  return rows.map((q) => {
    const done = q.attempts.filter((a) => a.finishedAt && a.score !== null);
    return {
      ...quizView(q),
      documentName: q.document?.name ?? null,
      attemptCount: done.length,
      bestScore: done.length ? Math.max(...done.map((a) => a.score ?? 0)) : null,
    };
  });
}

export async function getQuiz(userId: string, id: string) {
  const q = await prisma.quiz.findFirst({
    where: { id, userId },
    include: { document: { select: { name: true } }, items: { where: { flagged: false }, orderBy: { position: "asc" } }, attempts: { orderBy: { startedAt: "desc" } } },
  });
  if (!q) throw notFound();
  return { ...quizView(q), documentName: q.document?.name ?? null, items: q.items.map(itemPublic), attempts: q.attempts.map(attemptSummary) };
}

// ---------- lượt làm bài ----------

/** Bắt đầu lượt mới, hoặc trả lại lượt đang làm dở để tiếp tục (APP-07). */
export async function startAttempt(userId: string, quizId: string) {
  const quiz = await prisma.quiz.findFirst({ where: { id: quizId, userId }, select: { id: true } });
  if (!quiz) throw notFound();
  const open = await prisma.quizAttempt.findFirst({ where: { quizId, userId, finishedAt: null }, orderBy: { startedAt: "desc" } });
  if (open) return { created: false, attempt: await getAttempt(userId, open.id) };
  const total = await prisma.quizItem.count({ where: { quizId, flagged: false } });
  if (total === 0) throw new AppError(409, "quiz_empty", "Bài quiz này không còn câu hỏi nào.");
  const a = await prisma.quizAttempt.create({ data: { quizId, userId, total } });
  return { created: true, attempt: await getAttempt(userId, a.id) };
}

type AttemptFull = QuizAttempt & { answers: AttemptAnswer[]; quiz: { items: QuizItem[] } };

async function loadAttempt(userId: string, id: string): Promise<AttemptFull> {
  const a = await prisma.quizAttempt.findFirst({
    where: { id, userId },
    include: { answers: true, quiz: { select: { items: { where: { flagged: false }, orderBy: { position: "asc" } } } } },
  });
  if (!a) throw notFound("lượt làm bài");
  return a;
}

/** Đáp án và giải thích chỉ lộ cho câu đã trả lời, hoặc cho mọi câu khi lượt đã kết thúc. */
function attemptView(a: AttemptFull) {
  const reveal = a.finishedAt !== null;
  const byItem = new Map(a.answers.map((x) => [x.itemId, x]));
  return {
    ...attemptSummary(a),
    items: a.quiz.items.map((it) => {
      const ans = byItem.get(it.id);
      return {
        ...itemPublic(it),
        chosenIndex: ans?.chosenIndex ?? null,
        isCorrect: ans?.isCorrect ?? null,
        ...(reveal || ans ? { correctIndex: it.correctIndex, explanation: it.explanation } : {}),
      };
    }),
  };
}

export async function getAttempt(userId: string, id: string) {
  return attemptView(await loadAttempt(userId, id));
}

export async function answer(userId: string, attemptId: string, itemId: string, chosenIndex: number) {
  const a = await prisma.quizAttempt.findFirst({ where: { id: attemptId, userId } });
  if (!a) throw notFound("lượt làm bài");
  if (a.finishedAt) throw new AppError(409, "attempt_finished", "Lượt làm bài này đã kết thúc.");
  const item = await prisma.quizItem.findFirst({ where: { id: itemId, quizId: a.quizId, flagged: false } });
  if (!item) throw notFound("câu hỏi");

  const result = (isCorrect: boolean) => ({ isCorrect, correctIndex: item.correctIndex, explanation: item.explanation, page: item.page, documentId: item.documentId });
  const prev = await prisma.attemptAnswer.findUnique({ where: { attemptId_itemId: { attemptId, itemId } } });
  if (prev) {
    // Gửi lại đúng đáp án cũ (mạng chập chờn) thì trả lại kết quả; đổi đáp án sau khi đã chấm thì không cho.
    if (prev.chosenIndex === chosenIndex) return result(prev.isCorrect);
    throw new AppError(409, "already_answered", "Câu này đã được chấm, không đổi đáp án được.");
  }
  const isCorrect = chosenIndex === item.correctIndex;
  try {
    await prisma.attemptAnswer.create({ data: { attemptId, itemId, chosenIndex, isCorrect } });
  } catch (e) {
    // Hai request đồng thời cho cùng câu: request đến sau thấy bản ghi đã có.
    if ((e as { code?: string }).code === "P2002") throw new AppError(409, "already_answered", "Câu này đã được chấm, không đổi đáp án được.");
    throw e;
  }
  return result(isCorrect);
}

/** Kết thúc: tính điểm (câu chưa trả lời tính là sai), lưu thời gian làm bài. Gọi lại thì trả kết quả cũ. */
export async function finishAttempt(userId: string, attemptId: string) {
  const a = await prisma.quizAttempt.findFirst({ where: { id: attemptId, userId } });
  if (!a) throw notFound("lượt làm bài");
  if (!a.finishedAt) {
    const score = await prisma.attemptAnswer.count({ where: { attemptId, isCorrect: true } });
    const now = new Date();
    // Điều kiện finishedAt = null để hai lần kết thúc đồng thời không ghi đè nhau.
    await prisma.quizAttempt.updateMany({
      where: { id: attemptId, userId, finishedAt: null },
      data: { score, finishedAt: now, durationS: Math.max(0, Math.round((now.getTime() - a.startedAt.getTime()) / 1000)) },
    });
  }
  return getAttempt(userId, attemptId);
}
