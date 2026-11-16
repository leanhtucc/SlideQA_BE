import { z } from "zod";

const email = z.string().trim().toLowerCase().pipe(z.email("Email chưa đúng định dạng."));

// bcrypt chỉ dùng 72 byte đầu, nên chặn mật khẩu dài hơn thay vì cắt âm thầm.
const password = z
  .string()
  .min(8, "Mật khẩu cần ít nhất 8 ký tự.")
  .refine((p) => Buffer.byteLength(p) <= 72, "Mật khẩu quá dài (tối đa 72 byte).");

export const registerBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1, "Hãy nhập tên hiển thị.").max(80, "Tên hiển thị tối đa 80 ký tự."),
  acceptTerms: z.literal(true, { error: "Bạn cần đồng ý Điều khoản sử dụng và Chính sách bảo vệ dữ liệu cá nhân." }),
});

export const loginBody = z.object({ email, password: z.string().min(1, "Hãy nhập mật khẩu.") });

export const tokenBody = z.object({ refreshToken: z.string().min(1) });
