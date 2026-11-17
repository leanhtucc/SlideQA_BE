import { prisma } from "../../prisma.js";
import { extractDocument } from "./extractDocument.js";

export const enqueueExtract = (documentId: string) =>
  prisma.job.create({ data: { type: "extract_document", payload: { documentId } } });

interface Claimed {
  id: string;
  type: string;
  payload: { documentId?: string };
}

/** Nhận một job đang chờ; FOR UPDATE SKIP LOCKED nên nhiều worker không nhận trùng. */
async function claim(documentId?: string): Promise<Claimed | undefined> {
  const only = documentId ?? null;
  const rows = await prisma.$queryRaw<Claimed[]>`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_at <= now() AND (${only}::text IS NULL OR payload->>'documentId' = ${only})
      ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id, type::text AS type, payload`;
  return rows[0];
}

/** Xử lý một job; trả false khi không có job. `documentId` chỉ dùng trong test để không nhận job của test khác. */
export async function processNextJob(documentId?: string): Promise<boolean> {
  const job = await claim(documentId);
  if (!job) return false;
  try {
    if (job.type === "extract_document" && job.payload.documentId) await extractDocument(job.payload.documentId);
    await prisma.job.update({ where: { id: job.id }, data: { status: "done", error: null } });
  } catch (e) {
    await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// shortcut: một worker trong cùng tiến trình API, xử lý lần lượt từng job; tách thành tiến trình riêng khi tải tăng.
export function startWorker(): () => void {
  let stopped = false;
  void (async () => {
    // Job "running" quá lâu là do tiến trình cũ chết giữa chừng: đưa về hàng đợi.
    // DB chưa sẵn sàng lúc khởi động không được làm sập cả API: vòng lặp bên dưới sẽ tự thử lại.
    await prisma.$executeRaw`UPDATE jobs SET status = 'queued' WHERE status = 'running' AND updated_at < now() - interval '10 minutes'`.catch((e) =>
      console.error("worker recover", e instanceof Error ? e.message : e),
    );
    while (!stopped) {
      const did = await processNextJob().catch((e) => {
        console.error("worker", e instanceof Error ? e.message : e);
        return false;
      });
      if (!did) await sleep(1000);
    }
  })();
  return () => {
    stopped = true;
  };
}
