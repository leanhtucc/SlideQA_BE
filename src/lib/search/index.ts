import { prisma } from "../../prisma.js";
import { BM25Index, type Chunk } from "./bm25.js";

export interface SearchScope {
  /** Chỉ tìm trong một môn */
  courseId?: string;
  /** Chỉ tìm trong một số tài liệu */
  documentIds?: string[];
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentName: string;
  courseId: string;
  page: number;
  text: string;
  score: number;
}

interface Entry {
  index: BM25Index;
  docs: Map<string, { name: string; courseId: string }>;
  builtAt: number;
}

const MAX_USERS = 50;
const TTL_MS = 5 * 60_000;
const MAX_QUERY_CHARS = 500;

// shortcut: chỉ mục BM25 nằm trong bộ nhớ của tiến trình API và được nạp theo từng người dùng.
// Khi chạy nhiều bản API, bản cache ở máy khác chỉ cập nhật khi hết TTL; chuyển sang PostgreSQL full-text nếu cần (đo ở Q3).
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const generation = new Map<string, number>();

/** Gọi khi tài liệu của người dùng thay đổi (sẵn sàng, đổi tên/môn, xóa, thử lại...). */
export function invalidateUserIndex(userId: string): void {
  generation.set(userId, (generation.get(userId) ?? 0) + 1);
  cache.delete(userId);
}

async function build(userId: string): Promise<Entry> {
  const gen = generation.get(userId) ?? 0;
  // Chỉ tài liệu của chính người dùng và đã xử lý xong mới vào chỉ mục (NFR-07).
  const docs = await prisma.document.findMany({ where: { userId, status: "ready" }, select: { id: true, name: true, courseId: true } });
  const rows = await prisma.chunk.findMany({
    where: { document: { userId, status: "ready" } },
    select: { id: true, documentId: true, page: true, part: true, text: true },
    orderBy: [{ documentId: "asc" }, { page: "asc" }, { part: "asc" }],
  });
  const chunks: Chunk[] = rows.map((r) => ({ id: r.id, docId: r.documentId, page: r.page, part: r.part, text: r.text }));
  const entry: Entry = {
    index: new BM25Index(chunks),
    docs: new Map(docs.map((d) => [d.id, { name: d.name, courseId: d.courseId }])),
    builtAt: Date.now(),
  };
  // Nếu trong lúc nạp có thay đổi thì không lưu bản cũ vào cache.
  if ((generation.get(userId) ?? 0) === gen) {
    cache.set(userId, entry);
    if (cache.size > MAX_USERS) cache.delete(cache.keys().next().value as string);
  }
  return entry;
}

async function getEntry(userId: string): Promise<Entry> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.builtAt < TTL_MS) return hit;
  let p = pending.get(userId);
  if (!p) {
    p = build(userId).finally(() => pending.delete(userId));
    pending.set(userId, p);
  }
  return p;
}

/** Tìm `k` đoạn liên quan nhất trong tài liệu của người dùng, đã lọc theo phạm vi. Rỗng = không đủ căn cứ. */
export async function searchChunks(userId: string, query: string, scope: SearchScope = {}, k = 5): Promise<SearchHit[]> {
  const e = await getEntry(userId);
  const only = scope.documentIds?.length ? new Set(scope.documentIds) : undefined;
  const hits = e.index.search(query.slice(0, MAX_QUERY_CHARS), k, (c) => {
    const d = e.docs.get(c.docId);
    if (!d) return false;
    if (scope.courseId && d.courseId !== scope.courseId) return false;
    return !only || only.has(c.docId);
  });
  return hits.map((h) => {
    const d = e.docs.get(h.chunk.docId)!;
    return {
      chunkId: h.chunk.id,
      documentId: h.chunk.docId,
      documentName: d.name,
      courseId: d.courseId,
      page: h.chunk.page,
      text: h.chunk.text,
      score: h.score,
    };
  });
}
