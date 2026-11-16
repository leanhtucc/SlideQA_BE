import { app } from "./app.js";
import { env } from "./config/env.js";
import { startWorker } from "./lib/jobs/worker.js";

const stopWorker = startWorker();
const server = app.listen(env.PORT, () => {
  console.log(`Slide QA API chạy tại http://localhost:${env.PORT}  (AI: ${env.llmEnabled ? "bật" : "tắt, chỉ trả về đoạn liên quan"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopWorker();
    server.close(() => process.exit(0));
  });
}
