import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
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
