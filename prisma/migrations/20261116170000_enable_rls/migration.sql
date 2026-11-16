-- Supabase tự mở REST API (PostgREST) cho schema public bằng khóa anon.
-- Bật RLS và không tạo policy nào = anon/authenticated không đọc được gì.
-- Backend kết nối bằng role postgres (BYPASSRLS) nên vẫn truy cập bình thường.
-- Trên PostgreSQL thường lệnh này vô hại.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quizzes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attempt_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "flashcards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
