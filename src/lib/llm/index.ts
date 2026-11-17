import { env } from "../../config/env.js";
import { anthropic } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { mockLlm } from "./mock.js";
import type { LlmClient, LlmRequest, LlmResult } from "./types.js";
import { LlmError } from "./types.js";

export { LlmError };
export type { LlmClient, LlmRequest, LlmResult };

// undefined = theo cấu hình; null = ép tắt AI; còn lại = client giả (chỉ dùng trong test).
let override: LlmClient | null | undefined;
export const setLlmClient = (c: LlmClient | null | undefined) => {
  override = c;
};

export function getLlm(): LlmClient | null {
  if (override !== undefined) return override;
  if (env.LLM_PROVIDER === "mock") return mockLlm;
  if (env.LLM_PROVIDER === "gemini") return env.GEMINI_API_KEY ? gemini : null;
  return env.ANTHROPIC_API_KEY ? anthropic : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thử tối đa 3 lần (1 + 2 lần thử lại), chờ tăng dần; lỗi không tạm thời thì dừng ngay (NFR-14). */
export async function completeWithRetry(client: LlmClient, req: LlmRequest): Promise<LlmResult> {
  let started = false; // đã gửi chữ ra ngoài thì không thử lại, kẻo người dùng thấy câu bị lặp
  const onDelta = req.onDelta && ((t: string) => ((started = true), req.onDelta?.(t)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.complete({ ...req, ...(onDelta ? { onDelta } : {}) });
    } catch (e) {
      const retryable = e instanceof LlmError ? e.retryable : true;
      if (!retryable || started || attempt >= 2) throw e;
      await sleep(env.LLM_RETRY_BASE_MS * (attempt === 0 ? 1 : 3));
    }
  }
}
