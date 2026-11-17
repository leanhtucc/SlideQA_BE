-- Câu hỏi nối tiếp đã được viết lại thành câu độc lập (E3). Cột mới cho phép NULL nên không ảnh hưởng dữ liệu cũ.
ALTER TABLE "messages" ADD COLUMN "search_query" TEXT;
