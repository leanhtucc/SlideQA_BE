import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";

/** Lỗi nghiệp vụ có mã HTTP; body luôn là { error: { code, message } } (SRS mục 10). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Lỗi theo từng trường cho form (giống lỗi validation) */
    public fields?: Record<string, string> | undefined,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, "not_found", "Không tìm thấy."));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } });
    return;
  }
  if (err instanceof ZodError) {
    // `fields` giúp form hiện lỗi từng trường (WEB-S01); chỉ chứa thông báo, không có giá trị người dùng nhập.
    const fields: Record<string, string> = {};
    for (const i of err.issues) fields[i.path.join(".") || "_"] ??= i.message;
    res.status(422).json({ error: { code: "validation_error", message: "Dữ liệu gửi lên chưa hợp lệ.", fields } });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({
      error: { code: tooBig ? "file_too_large" : "bad_upload", message: tooBig ? "Tệp lớn hơn giới hạn cho phép (50 MB)." : "Tải lên không hợp lệ." },
    });
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
