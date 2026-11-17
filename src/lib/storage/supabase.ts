import { readFile } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { Storage } from "./index.js";

/**
 * Kho tệp trên Supabase Storage (bucket riêng tư), gọi REST bằng khóa service_role từ server: khóa này không bao giờ ra trình duyệt.
 * Tệp vẫn chỉ được phục vụ qua API của ta (có kiểm userId), nên không dùng liên kết công khai.
 * shortcut: `put` đọc cả tệp vào bộ nhớ (tối đa 50 MB mỗi tệp); cần hơn thì chuyển sang tải lên dạng phân đoạn (TUS).
 */
export class SupabaseStorage implements Storage {
  private url: string;

  constructor(
    url: string,
    private key: string,
    private bucket: string,
  ) {
    // Chỉ lấy phần gốc (https://<mã>.supabase.co): trang Data API của Supabase hiển thị địa chỉ có đuôi /rest/v1, dán nguyên vào sẽ đi nhầm tới PostgREST (lỗi PGRST125).
    this.url = new URL(url).origin;
  }

  private endpoint(kind: "authenticated" | "object", key: string) {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return kind === "authenticated" ? `${this.url}/storage/v1/object/authenticated/${this.bucket}/${path}` : `${this.url}/storage/v1/object/${this.bucket}/${path}`;
  }

  private headers(extra: Record<string, string> = {}) {
    // Khóa kiểu mới (sb_secret_…) không phải JWT: chỉ đi trong `apikey`, cổng của Supabase tự cấp quyền. Khóa legacy service_role là JWT nên gửi cả hai.
    return { ...(this.key.startsWith("sb_") ? {} : { authorization: `Bearer ${this.key}` }), apikey: this.key, ...extra };
  }

  async put(key: string, fromPath: string) {
    const res = await fetch(this.endpoint("object", key), {
      method: "POST",
      headers: this.headers({ "content-type": "application/pdf", "x-upsert": "false" }),
      body: await readFile(fromPath),
    });
    // Kèm lý do Supabase báo (vd "Bucket not found"): đó là thông báo lỗi của họ, không chứa nội dung tệp hay câu hỏi (NFR-08); chỉ vào log, người dùng vẫn chỉ thấy "Lỗi máy chủ".
    if (!res.ok) throw new Error(`Supabase Storage put: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  }

  async size(key: string) {
    const res = await fetch(this.endpoint("authenticated", key), { method: "HEAD", headers: this.headers() });
    const n = Number(res.headers.get("content-length"));
    if (!res.ok || !Number.isFinite(n)) throw new Error(`Supabase Storage size: ${res.status}`);
    return n;
  }

  read(key: string, range?: { start: number; end: number }) {
    // Giao diện cần trả ngay một luồng, còn fetch là bất đồng bộ: mở luồng rỗng rồi nối vào khi có phản hồi.
    const out = new PassThrough();
    fetch(this.endpoint("authenticated", key), { headers: this.headers(range ? { range: `bytes=${range.start}-${range.end}` } : {}) })
      .then((res) => {
        if (!res.ok || !res.body) return void out.destroy(new Error(`Supabase Storage read: ${res.status}`));
        Readable.fromWeb(res.body as unknown as WebStream).on("error", (e) => out.destroy(e)).pipe(out);
      })
      .catch((e) => out.destroy(e));
    return out;
  }

  async remove(key: string) {
    const res = await fetch(this.endpoint("object", key), { method: "DELETE", headers: this.headers() });
    if (!res.ok && res.status !== 404 && res.status !== 400) throw new Error(`Supabase Storage remove: ${res.status}`);
  }
}
