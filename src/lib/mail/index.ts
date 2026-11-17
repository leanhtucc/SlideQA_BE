export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Gửi thư. shortcut: chỉ ghi ra console (quyết định Q8), chưa có nhà cung cấp email.
 * Nội dung thư chứa liên kết đặt lại mật khẩu nên log của máy chủ phải được coi là bí mật;
 * khi có nhà cung cấp thật (Resend/SES...) chỉ cần thay hàm này.
 */
export async function sendMail(mail: Mail): Promise<void> {
  console.log(`[mail] tới ${mail.to} | ${mail.subject}\n${mail.text}`);
}
