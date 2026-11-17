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

export const forgotBody = z.object({ email });

export const resetBody = z.object({ token: z.string().min(1, "Liên kết không hợp lệ."), password });

export const changePasswordBody = z.object({ currentPassword: z.string().min(1, "Hãy nhập mật khẩu hiện tại."), newPassword: password });

export const profileBody = z.object({ displayName: z.string().trim().min(1, "Hãy nhập tên hiển thị.").max(80, "Tên hiển thị tối đa 80 ký tự.") });

/** Tài khoản có mật khẩu xác nhận bằng mật khẩu; tài khoản chỉ dùng Google (chưa có mật khẩu) xác nhận bằng cách gõ lại email. */
export const deleteAccountBody = z
  .object({ password: z.string().optional(), email: z.string().trim().toLowerCase().optional() })
  .refine((b) => b.password || b.email, { message: "Hãy nhập mật khẩu hoặc email để xác nhận.", path: ["password"] });

export const googleBody = z.object({
  credential: z.string().min(1, "Thiếu thông tin đăng nhập Google."),
  /** Bắt buộc là true khi tạo tài khoản mới bằng Google (cần đồng ý Điều khoản và Chính sách) */
  acceptTerms: z.boolean().optional(),
});

export const tokenBody = z.object({ refreshToken: z.string().min(1) });
