import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
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

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
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
  llmEnabled: Boolean(parsed.data.ANTHROPIC_API_KEY),
};
