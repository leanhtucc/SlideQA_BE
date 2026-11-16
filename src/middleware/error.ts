import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

/** Lỗi nghiệp vụ có mã HTTP; body luôn là { error: { code, message } } (SRS mục 10). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "not_found", "Không tìm thấy."));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({ error: { code: "validation_error", message: "Dữ liệu gửi lên chưa hợp lệ." } });
    return;
  }
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "bad_json", message: "JSON không hợp lệ." } });
    return;
  }
  // Không log nội dung request (NFR-08), chỉ log lỗi.
  console.error(err instanceof Error ? err.stack : err);
  res.status(500).json({ error: { code: "internal", message: "Lỗi máy chủ." } });
};
