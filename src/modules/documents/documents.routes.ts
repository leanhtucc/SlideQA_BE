import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { env } from "../../config/env.js";
import { storage } from "../../lib/storage/index.js";
import { authUserId, requireAuth } from "../../middleware/auth.js";
import { AppError } from "../../middleware/error.js";
import { idParam, listQuery, updateDocumentBody, uploadBody } from "./documents.schema.js";
import * as svc from "./documents.service.js";

const TMP = join(tmpdir(), "slideqa-uploads");
mkdirSync(TMP, { recursive: true });
const upload = multer({ dest: TMP, limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 } });

const router = Router();
router.use(requireAuth);

const idOf = (req: Request) => {
  const p = idParam.safeParse(req.params["id"]);
  if (!p.success) throw new AppError(404, "not_found", "Không tìm thấy tài liệu.");
  return p.data;
};

router.get("/", async (req, res) => {
  res.json(await svc.listDocuments(authUserId(req), listQuery.parse(req.query).courseId));
});

router.post("/", upload.single("file"), async (req, res) => {
  const f = req.file;
  try {
    if (!f) throw new AppError(400, "file_required", "Thiếu tệp PDF.");
    const { courseId } = uploadBody.parse(req.body);
    // Xử lý nền: trả 202 ngay, client hỏi lại trạng thái (UC-02).
    res.status(202).json(await svc.createDocument(authUserId(req), courseId, f));
  } finally {
    if (f) await rm(f.path, { force: true });
  }
});

router.get("/:id", async (req, res) => {
  res.json(await svc.getDocument(authUserId(req), idOf(req)));
});

router.patch("/:id", async (req, res) => {
  res.json(await svc.updateDocument(authUserId(req), idOf(req), updateDocumentBody.parse(req.body)));
});

router.delete("/:id", async (req, res) => {
  await svc.deleteDocument(authUserId(req), idOf(req));
  res.status(204).end();
});

router.post("/:id/retry", async (req, res) => {
  res.status(202).json(await svc.retryDocument(authUserId(req), idOf(req)));
});

/** Một khoảng `bytes=a-b` (hoặc `a-`, `-n`); null nếu không hợp lệ. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

/** PDF gốc, hỗ trợ Range để pdf.js và mobile tải dần (FR-DOC-06). */
router.get("/:id/file", async (req: Request, res: Response) => {
  const doc = await svc.getDocumentRow(authUserId(req), idOf(req));
  let size: number;
  try {
    size = await storage.size(doc.storageKey);
  } catch {
    throw new AppError(404, "not_found", "Không tìm thấy tệp PDF.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.setHeader("Cache-Control", "private, no-cache");
  // helmet mặc định đặt same-origin; web chạy ở origin khác nên cho phép riêng đường dẫn này (CORS vẫn kiểm Origin).
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  const rangeHeader = req.header("range");
  if (rangeHeader) {
    const r = parseRange(rangeHeader, size);
    if (!r) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${r.start}-${r.end}/${size}`);
    res.setHeader("Content-Length", String(r.end - r.start + 1));
    await pipeline(storage.read(doc.storageKey, r), res);
    return;
  }
  res.setHeader("Content-Length", String(size));
  await pipeline(storage.read(doc.storageKey), res);
});

export default router;
