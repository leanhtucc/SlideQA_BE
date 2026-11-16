import "dotenv/config";

// Test tích hợp tạo và xóa dữ liệu thật: không bao giờ chạy trên database Supabase/đám mây.
const url = process.env["DATABASE_URL"] ?? "";
if (/supabase\.(co|com)/.test(url) || process.env["NODE_ENV"] === "production") {
  throw new Error("Từ chối chạy test DB trên database đám mây. Hãy đặt DATABASE_URL trỏ tới Postgres cục bộ.");
}
