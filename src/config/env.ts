import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  /** Địa chỉ web, dùng dựng liên kết trong email (đặt lại mật khẩu) */
  WEB_URL: z.string().default("http://localhost:5173"),
  /** OAuth client ID (công khai, không phải bí mật) cho đăng nhập Google; để trống = tắt tính năng */
  GOOGLE_CLIENT_ID: z.string().optional(),
  RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  RESET_RATE_MAX: z.coerce.number().int().positive().default(5),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  /** Số lớp proxy tin cậy phía trước (0 = không); cần đúng để rate limit lấy được IP thật */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  JWT_ACCESS_SECRET: z.string().min(32, "tối thiểu 32 ký tự"),
  ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  /** Số lần gọi /auth/login tối đa mỗi phút mỗi IP (NFR-09) */
  LOGIN_RATE_MAX: z.coerce.number().int().positive().default(5),
  /** Phiên bản điều khoản/chính sách người dùng đang đồng ý */
  TERMS_VERSION: z.string().default("2026-11"),

  /** Thư mục kho tệp PDF (kho cục bộ) */
  STORAGE_DIR: z.string().default("./data/files"),
  /** Dung lượng tối đa mỗi tệp tải lên: 50 MB (FR-DOC-01) */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  /** `mock` = trợ lý giả trả lời từ đoạn đầu của ngữ cảnh, để phát triển web mà không cần khóa API */
  LLM_PROVIDER: z.enum(["anthropic", "mock"]).default("anthropic"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Chờ giữa các lần thử lại: base, 3×base (tối đa 2 lần thử lại, NFR-14) */
  LLM_RETRY_BASE_MS: z.coerce.number().int().min(0).default(500),
  /** Số lượt hỏi tối đa mỗi giờ mỗi người dùng (NFR-09) */
  ASK_RATE_MAX: z.coerce.number().int().positive().default(30),
  /** Số lần tạo quiz tối đa mỗi giờ mỗi người dùng (mỗi lần tốn nhiều token hơn một câu hỏi) */
  QUIZ_RATE_MAX: z.coerce.number().int().positive().default(10),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Dừng sớm, chỉ in tên biến sai, không in giá trị (có thể là bí mật).
  const bad = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  throw new Error(`Cấu hình môi trường không hợp lệ: ${bad}`);
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  llmEnabled: parsed.data.LLM_PROVIDER === "mock" || Boolean(parsed.data.ANTHROPIC_API_KEY),
};
