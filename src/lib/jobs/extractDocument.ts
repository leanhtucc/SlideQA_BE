import { prisma } from "../../prisma.js";
import { extractPages, PdfError } from "../pdf/extract.js";
import { chunkPages } from "../search/bm25.js";
import { storage } from "../storage/index.js";

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
}

/** Trích chữ từng trang → Chunk; đặt trạng thái ready/failed. Ném lại lỗi để job được đánh dấu failed. */
export async function extractDocument(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({ where: { id: documentId } });
  if (!doc) return; // đã bị xóa trong lúc chờ xử lý
  try {
    const pages = await extractPages(new Uint8Array(await readAll(storage.read(doc.storageKey))));
    const chunks = chunkPages(doc.id, pages);
    await prisma.$transaction([
      prisma.chunk.deleteMany({ where: { documentId } }),
      prisma.chunk.createMany({ data: chunks.map((c) => ({ documentId, page: c.page, part: c.part, text: c.text })) }),
      prisma.document.update({
        where: { id: documentId },
        data: { status: "ready", error: null, pages: pages.length, emptyPages: pages.filter((p) => !p.text.trim()).length },
      }),
    ]);
  } catch (e) {
    const message = e instanceof PdfError ? e.message : "Xử lý tệp thất bại, hãy thử lại.";
    if (!(e instanceof PdfError)) console.error("extractDocument", documentId, e instanceof Error ? e.message : e);
    // Tài liệu có thể đã bị xóa giữa chừng: khi đó không còn gì để cập nhật.
    await prisma.document.updateMany({ where: { id: documentId }, data: { status: "failed", error: message } });
    throw e;
  }
}
