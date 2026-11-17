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
  /** `brevo` = gửi thư thật qua Brevo; `log` = chỉ ghi ra console (phát triển/test) */
  MAIL_PROVIDER: z.enum(["log", "brevo"]).default("log"),
  BREVO_API_KEY: z.string().optional(),
  /** Địa chỉ người gửi, phải là địa chỉ đã xác minh trong Brevo */
  MAIL_FROM_EMAIL: z.string().optional(),
  MAIL_FROM_NAME: z.string().default("Slide QA"),
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

  /** Supabase Storage (bucket riêng tư) cho PDF; đặt cả URL và khóa service_role thì dùng, không thì dùng thư mục cục bộ. Khóa là bí mật, chỉ ở biến môi trường của máy chủ */
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().default("documents"),
  /** Thư mục kho tệp PDF (kho cục bộ) */
  STORAGE_DIR: z.string().default("./data/files"),
  /** Dung lượng tối đa mỗi tệp tải lên: 50 MB (FR-DOC-01) */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  /** Khóa Google AI Studio (gói miễn phí dùng được); chỉ đặt trong biến môi trường của máy chủ */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_BASE_URL: z.string().default("https://generativelanguage.googleapis.com"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  /** `mock` = trợ lý giả trả lời từ đoạn đầu của ngữ cảnh, để phát triển web mà không cần khóa API */
  LLM_PROVIDER: z.enum(["anthropic", "gemini", "mock"]).default("anthropic"),
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
  llmEnabled:
    parsed.data.LLM_PROVIDER === "mock" || Boolean(parsed.data.LLM_PROVIDER === "gemini" ? parsed.data.GEMINI_API_KEY : parsed.data.ANTHROPIC_API_KEY),
};
