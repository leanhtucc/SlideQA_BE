import { env } from "../../config/env.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Gửi thư. `MAIL_PROVIDER=brevo` gửi thật qua Brevo (HTTP API); mặc định `log` chỉ ghi ra console (phát triển và test:
 * khi đó log chứa liên kết đặt lại mật khẩu nên phải coi là bí mật).
 * Lỗi gửi chỉ ghi mã trạng thái, không ghi địa chỉ hay nội dung (NFR-08) và không ném ra ngoài: nếu ném, "quên mật khẩu" sẽ
 * trả 500 cho email có thật và 204 cho email không có, làm lộ email nào đã đăng ký.
 */
export async function sendMail(mail: Mail): Promise<void> {
  if (env.MAIL_PROVIDER !== "brevo") {
    console.log(`[mail] tới ${mail.to} | ${mail.subject}\n${mail.text}`);
    return;
  }
  if (!env.BREVO_API_KEY || !env.MAIL_FROM_EMAIL) return void console.error("[mail] thiếu BREVO_API_KEY hoặc MAIL_FROM_EMAIL, không gửi được");
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": env.BREVO_API_KEY ?? "" },
      body: JSON.stringify({
        sender: { name: env.MAIL_FROM_NAME, email: env.MAIL_FROM_EMAIL },
        to: [{ email: mail.to }],
        subject: mail.subject,
        textContent: mail.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[mail] gửi thất bại: ${res.status}`);
  } catch {
    console.error("[mail] gửi thất bại: mạng hoặc hết giờ");
  }
}
