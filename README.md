# Slide QA API

Backend dùng chung cho web và mobile (Node.js 20+, Express 5, TypeScript ESM, Prisma, PostgreSQL).

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

## Lệnh

| Lệnh | Việc |
| --- | --- |
| `npm run dev` | Chạy có tự reload (tsx) |
| `npm test` | Test đơn vị và API (không cần DB) |
| `npm run test:db` | Test toàn vẹn dữ liệu, cần PostgreSQL đang chạy |
| `npm run typecheck` | Kiểm tra kiểu |
| `npm run build` / `npm start` | Biên dịch và chạy bản production |

## Cấu trúc

- `src/config/env.ts`: đọc và kiểm tra biến môi trường (thiếu là dừng ngay).
- `src/middleware/error.ts`: mọi lỗi trả `{ "error": { "code", "message" } }`.
- `src/lib/search/`: BM25 và bỏ dấu tiếng Việt (chuyển từ MVP).
- `src/modules/*`: từng nhóm API (sẽ làm theo plan.md, lát B2 trở đi).
