import "./guard.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma.js";

// Test tích hợp cần PostgreSQL thật: `npm run test:db`. Dữ liệu dùng email ngẫu nhiên và tự dọn.
const uniq = () => `t-${randomUUID()}@example.test`;
after(() => prisma.$disconnect());

async function makeGraph() {
  const user = await prisma.user.create({ data: { email: uniq(), displayName: "T", passwordHash: "x" } });
  const course = await prisma.course.create({ data: { userId: user.id, name: "C" } });
  const doc = await prisma.document.create({
    data: { userId: user.id, courseId: course.id, name: "d.pdf", sizeBytes: 1, pages: 2, contentHash: "h", storageKey: "k" },
  });
  const chunk = await prisma.chunk.create({ data: { documentId: doc.id, page: 2, text: "gateway xor" } });
  const conv = await prisma.conversation.create({ data: { userId: user.id, courseId: course.id, title: "t" } });
  const msg = await prisma.message.create({ data: { conversationId: conv.id, role: "assistant", content: "a", mode: "no_match" } });
  const src = await prisma.messageSource.create({
    data: { messageId: msg.id, n: 1, chunkId: chunk.id, documentId: doc.id, documentName: "d.pdf", page: 2, snippet: "gateway xor" },
  });
  const quiz = await prisma.quiz.create({ data: { userId: user.id, documentId: doc.id, courseId: course.id, count: 1 } });
  const item = await prisma.quizItem.create({
    data: { quizId: quiz.id, documentId: doc.id, position: 0, question: "q", options: ["a", "b", "c", "d"], correctIndex: 1, explanation: "e", page: 2 },
  });
  const attempt = await prisma.quizAttempt.create({ data: { quizId: quiz.id, userId: user.id, total: 1 } });
  await prisma.attemptAnswer.create({ data: { attemptId: attempt.id, itemId: item.id, chosenIndex: 1, isCorrect: true } });
  await prisma.flashcard.create({ data: { userId: user.id, documentId: doc.id, front: "f", back: "b", page: 2 } });
  await prisma.usageLog.create({ data: { userId: user.id, kind: "ask" } });
  await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 1e6) } });
  return { user, course, doc, src, item, quiz };
}

test("email người dùng là duy nhất", async () => {
  const email = uniq();
  const u = await prisma.user.create({ data: { email, displayName: "A" } });
  await assert.rejects(prisma.user.create({ data: { email, displayName: "B" } }), { code: "P2002" });
  await prisma.user.delete({ where: { id: u.id } });
});

test("xóa Document: xóa Chunk, giữ MessageSource và QuizItem (documentId = null)", async () => {
  const g = await makeGraph();
  await prisma.document.delete({ where: { id: g.doc.id } });
  assert.equal(await prisma.chunk.count({ where: { documentId: g.doc.id } }), 0);
  const src = await prisma.messageSource.findUniqueOrThrow({ where: { id: g.src.id } });
  assert.equal(src.documentId, null);
  assert.equal(src.documentName, "d.pdf");
  assert.equal(src.page, 2);
  const item = await prisma.quizItem.findUniqueOrThrow({ where: { id: g.item.id } });
  assert.equal(item.documentId, null);
  await prisma.user.delete({ where: { id: g.user.id } });
});

test("xóa Course: xóa tài liệu theo, giữ hội thoại và quiz", async () => {
  const g = await makeGraph();
  await prisma.course.delete({ where: { id: g.course.id } });
  assert.equal(await prisma.document.count({ where: { id: g.doc.id } }), 0);
  const quiz = await prisma.quiz.findUniqueOrThrow({ where: { id: g.quiz.id } });
  assert.equal(quiz.courseId, null);
  await prisma.user.delete({ where: { id: g.user.id } });
});

test("xóa User: xóa sạch mọi dữ liệu liên quan (NFR-12)", async () => {
  const g = await makeGraph();
  await prisma.user.delete({ where: { id: g.user.id } });
  const uid = g.user.id;
  const counts = await Promise.all([
    prisma.course.count({ where: { userId: uid } }),
    prisma.document.count({ where: { userId: uid } }),
    prisma.conversation.count({ where: { userId: uid } }),
    prisma.quiz.count({ where: { userId: uid } }),
    prisma.quizAttempt.count({ where: { userId: uid } }),
    prisma.flashcard.count({ where: { userId: uid } }),
    prisma.usageLog.count({ where: { userId: uid } }),
    prisma.refreshToken.count({ where: { userId: uid } }),
    prisma.messageSource.count({ where: { id: g.src.id } }),
    prisma.quizItem.count({ where: { id: g.item.id } }),
    prisma.attemptAnswer.count({ where: { itemId: g.item.id } }),
  ]);
  assert.deepEqual(counts, new Array(counts.length).fill(0));
});

test("mọi bảng ứng dụng đều bật RLS (chặn API REST công khai của Supabase)", async () => {
  const rows = await prisma.$queryRaw<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT LIKE '\_prisma%'`;
  assert.deepEqual(rows, []);
});

test("enum no-match được lưu và đọc lại", async () => {
  const u = await prisma.user.create({ data: { email: uniq(), displayName: "A" } });
  const c = await prisma.conversation.create({ data: { userId: u.id, title: "t" } });
  const m = await prisma.message.create({ data: { conversationId: c.id, role: "assistant", content: "x", mode: "no_match" } });
  const [row] = await prisma.$queryRaw<{ mode: string }[]>`SELECT mode::text FROM messages WHERE id = ${m.id}`;
  assert.equal(row?.mode, "no-match");
  await prisma.user.delete({ where: { id: u.id } });
});
