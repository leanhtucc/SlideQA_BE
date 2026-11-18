import type { Flashcard } from "@prisma/client";
import { completeWithRetry, getLlm } from "../../lib/llm/index.js";
import { AppError } from "../../middleware/error.js";
import { prisma } from "../../prisma.js";
import { buildCardPrompt, CARD_SYSTEM, parseCardsJson, planBatches, validateCards, type ValidCard } from "./generate.js";

/** Số lần gọi mô hình chạy cùng lúc khi tạo nhiều thẻ (giữ dưới giới hạn tốc độ của gói miễn phí). */
const BATCH_CONCURRENCY = 3;

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
        dueAt: new Date(), // đặt rõ ở đây để thẻ mới luôn đến hạn ngay, không phụ thuộc giá trị mặc định của DB
      })),
    });
  }
  return { created: fresh.length, skipped: wrong.length - fresh.length };
}

/** Tạo nhiều thẻ từ một tài liệu đã xử lý xong bằng AI; thẻ trùng câu hỏi với thẻ đã có thì bỏ qua. */
export async function fromDocument(userId: string, b: { documentId: string; fromPage?: number | undefined; toPage?: number | undefined; count: number }) {
  const doc = await prisma.document.findFirst({ where: { id: b.documentId, userId } });
  if (!doc) throw notFound("tài liệu");
  if (doc.status !== "ready") throw new AppError(409, "document_not_ready", "Tài liệu chưa xử lý xong, hãy thử lại sau.");
  const fromPage = b.fromPage ?? 1;
  const toPage = b.toPage ?? doc.pages;
  if (fromPage > doc.pages || toPage > doc.pages) {
    throw new AppError(422, "validation_error", `Tài liệu chỉ có ${doc.pages} trang.`, { toPage: `Tài liệu chỉ có ${doc.pages} trang.` });
  }
  const chunks = await prisma.chunk.findMany({
    where: { documentId: doc.id, page: { gte: fromPage, lte: toPage } },
    orderBy: [{ page: "asc" }, { part: "asc" }],
    select: { page: true, text: true },
  });
  const batches = planBatches(chunks.filter((c) => c.text.trim().length > 0), b.count);
  if (batches.length === 0) throw new AppError(422, "no_content", "Không có nội dung chữ ở khoảng trang này. Hãy thử khoảng trang khác.");

  const llm = getLlm();
  if (!llm) throw new AppError(503, "llm_unavailable", "Tạo thẻ tự động cần trợ lý AI, hiện chưa được bật.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { llmConsentAt: true } });
  if (!user.llmConsentAt) throw new AppError(403, "consent_required", "Bạn cần đồng ý gửi đoạn tài liệu cho nhà cung cấp AI trước khi tạo thẻ.");

  // Mỗi lô là một lần gọi mô hình trên một phần tài liệu; chạy song song vừa phải để 100 thẻ xong trong chục giây.
  // Một lô hỏng thì bỏ qua lô đó, chỉ báo lỗi khi mọi lô đều hỏng.
  let tokensIn = 0;
  let tokensOut = 0;
  let failures = 0;
  let badOutput = 0;
  const collected: ValidCard[] = [];
  const runBatch = async (batch: (typeof batches)[number]) => {
    try {
      const raw = await completeWithRetry(llm, { system: CARD_SYSTEM, user: buildCardPrompt(batch.passages, batch.count), maxTokens: 4000 });
      tokensIn += raw.tokensIn;
      tokensOut += raw.tokensOut;
      const parsed = parseCardsJson(raw.text);
      if (!parsed) return void badOutput++;
      collected.push(...validateCards(parsed, new Set(batch.passages.map((p) => p.page)), batch.count));
    } catch (e) {
      failures++;
      console.warn("flashcard llm failed:", e instanceof Error ? e.message : "unknown"); // không ghi nội dung (NFR-08)
    }
  };
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) await Promise.all(batches.slice(i, i + BATCH_CONCURRENCY).map(runBatch));

  const seen = new Set<string>();
  const cards = collected.filter((c) => !seen.has(c.front.toLowerCase()) && seen.add(c.front.toLowerCase())).slice(0, b.count);
  if (cards.length === 0) {
    if (failures + badOutput === batches.length) {
      throw badOutput > failures
        ? new AppError(502, "llm_bad_output", "Trợ lý AI trả về kết quả không đọc được. Hãy thử lại.")
        : new AppError(502, "llm_failed", "Không tạo được thẻ lúc này. Hãy thử lại sau.");
    }
    throw new AppError(422, "no_valid_questions", "Không tạo được thẻ hợp lệ, hãy thử khoảng trang khác.");
  }

  const existing = await prisma.flashcard.findMany({ where: { userId, documentId: doc.id, front: { in: cards.map((c) => c.front) } }, select: { front: true } });
  const has = new Set(existing.map((e) => e.front));
  const fresh = cards.filter((c) => !has.has(c.front));
  await prisma.$transaction(async (tx) => {
    if (fresh.length > 0) await tx.flashcard.createMany({ data: fresh.map((c) => ({ userId, documentId: doc.id, front: c.front, back: c.back, page: c.page, dueAt: new Date() })) });
    await tx.usageLog.create({ data: { userId, kind: "quiz", tokensIn, tokensOut } });
  });
  return { created: fresh.length, skipped: cards.length - fresh.length, requested: b.count };
}
