# Slide QA API

Backend dùng chung cho web và mobile (Node.js 22.13+ vì `pdfjs-dist` 6, Express 5, TypeScript ESM, Prisma, PostgreSQL).

## Chạy cục bộ

```bash
docker compose up -d          # PostgreSQL
cp .env.example .env          # rồi chỉnh nếu cần
npm install
npm run prisma:deploy         # áp migration lên DB trống
npm run seed                  # 2 tài khoản thử: alice@example.test, bob@example.test (mật khẩu trong src/seed.ts)
npm run dev                   # http://localhost:3000/api/v1/health
```

Tạo migration mới sau khi sửa `prisma/schema.prisma`: `npm run prisma:migrate -- --name <ten>`. Database phải là UTF-8 (mặc định của image postgres).

Không đặt `ANTHROPIC_API_KEY` thì hỏi đáp chạy chế độ `extractive` (trả đoạn liên quan kèm trang), quiz tắt.

## Dùng Supabase thay cho Docker

1. Tạo project trên supabase.com (vùng Singapore), nhớ mật khẩu database.
2. Vào **Connect** của project, lấy hai chuỗi và đặt vào `.env` (không commit):
   - `DATABASE_URL`: Transaction pooler (cổng 6543), thêm `?pgbouncer=true&connection_limit=1`.
   - `DIRECT_URL`: Direct connection (cổng 5432). Nếu mạng không hỗ trợ IPv6 thì dùng Session pooler.
3. `npm run prisma:deploy` rồi `npm run seed` (seed chỉ để dev).
4. Migration `enable_rls` bật RLS cho mọi bảng, nên API REST công khai của Supabase (khóa anon) không đọc được dữ liệu. Backend dùng role `postgres` nên không bị ảnh hưởng.

## Lệnh

| Lệnh | Việc |
| --- | --- |
| `npm run dev` | Chạy có tự reload (tsx) |
| `npm test` | Test đơn vị và API (không cần DB) |
| `npm run test:db` | Test toàn vẹn dữ liệu, cần PostgreSQL đang chạy |
| `npm run typecheck` | Kiểm tra kiểu |
| `npm run build` / `npm start` | Biên dịch và chạy bản production |

## Xác thực (SRS mục 10)

`POST /api/v1/auth/register | login | refresh | logout` và `GET /api/v1/me`. Access token JWT sống 15 phút; refresh token ngẫu nhiên sống 30 ngày, DB chỉ lưu băm, mỗi token dùng một lần (dùng lại = thu hồi cả họ). Đăng nhập giới hạn 5 lần/phút/IP. Cần `JWT_ACCESS_SECRET` (≥ 32 ký tự) trong `.env`.

`npm run test:db` từ chối chạy khi `DATABASE_URL` trỏ tới Supabase; hãy export `DATABASE_URL` cục bộ trước khi chạy.

## Tài liệu PDF (SRS mục 10)

`POST /api/v1/documents` (multipart: `file`, `courseId`; tối đa 50 MB) trả 202 và xử lý nền; client hỏi lại `GET /documents/:id` (trạng thái `processing` → `ready` | `failed`). Còn có `GET /documents?courseId=`, `PATCH`, `DELETE`, `POST /:id/retry`, `GET /:id/file` (hỗ trợ `Range`). Tệp lưu ở `STORAGE_DIR` (mặc định `./data/files`) với khóa do server sinh. Worker nền chạy cùng tiến trình API (`src/lib/jobs`), lấy job từ bảng `jobs`. Chưa hỗ trợ PDF scan (không có OCR): trang không có chữ được đếm và cảnh báo.

## Hỏi đáp (SRS mục 7.2, 10)

`POST /conversations` (phạm vi: `courseId` hoặc `documentIds`), `GET /conversations?q=`, `GET|PATCH|DELETE /conversations/:id`, `POST /conversations/:id/messages {question}` → `{ mode, content, sources[] }` với `mode` là `llm`, `extractive` hoặc `no-match`.

- `no-match`: không đoạn nào đủ độ phủ → không gọi AI. `extractive`: trả các đoạn gốc kèm trang khi chưa bật AI, người dùng chưa đồng ý, hoặc AI lỗi sau 2 lần thử lại.
- Server **không bao giờ** gửi đoạn tài liệu cho AI nếu người dùng chưa đồng ý: `PUT /me/llm-consent {granted}`.
- Giới hạn 30 lượt hỏi/giờ/người dùng (`ASK_RATE_MAX`).
- Phát triển web không cần khóa API: đặt `LLM_PROVIDER=mock` (trợ lý giả trả lời bằng câu đầu của đoạn [1]). Dùng thật: đặt `ANTHROPIC_API_KEY`.

## Cấu trúc

- `src/config/env.ts`: đọc và kiểm tra biến môi trường (thiếu là dừng ngay).
- `src/middleware/error.ts`: mọi lỗi trả `{ "error": { "code", "message" } }`.
- `src/lib/search/`: BM25 và bỏ dấu tiếng Việt (chuyển từ MVP).
- `src/modules/*`: từng nhóm API (sẽ làm theo plan.md, lát B2 trở đi).
