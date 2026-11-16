import { env } from "../../config/env.js";
import { LlmError, type LlmClient } from "./types.js";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Gọi Anthropic Messages API từ server. Lỗi không bao giờ chứa nội dung request/response (NFR-08). */
export const anthropic: LlmClient = {
  async complete({ system, user, maxTokens }) {
    let res: Response;
    try {
      res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      });
    } catch {
      throw new LlmError("network or timeout", true);
    }
    if (!res.ok) throw new LlmError(`status ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
    const json = (await res.json().catch(() => null)) as MessagesResponse | null;
    const text = (json?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!text) throw new LlmError("empty response", false);
    return { text, tokensIn: json?.usage?.input_tokens ?? 0, tokensOut: json?.usage?.output_tokens ?? 0 };
  },
};
