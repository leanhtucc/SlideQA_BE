import { app } from "./app.js";
import { env } from "./config/env.js";

app.listen(env.PORT, () => {
  console.log(`Slide QA API chạy tại http://localhost:${env.PORT}  (AI: ${env.llmEnabled ? "bật" : "tắt, chỉ trả về đoạn liên quan"})`);
});
