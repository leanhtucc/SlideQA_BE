import { env } from "../../config/env.js";
import { LlmError, type LlmClient } from "./types.js";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Gọi Anthropic Messages API từ server. Lỗi không bao giờ chứa nội dung request/response (NFR-08). */
export const anthropic: LlmClient = {
  async complete({ system, user, maxTokens, onDelta }) {
    let res: Response;
    try {
      res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], ...(onDelta ? { stream: true } : {}) }),
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      });
    } catch {
      throw new LlmError("network or timeout", true);
    }
    if (!res.ok) throw new LlmError(`status ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
    if (onDelta) return readStream(res, onDelta);
    const json = (await res.json().catch(() => null)) as MessagesResponse | null;
    const text = (json?.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
    if (!text) throw new LlmError("empty response", false);
    return { text, tokensIn: json?.usage?.input_tokens ?? 0, tokensOut: json?.usage?.output_tokens ?? 0 };
  },
};

/** Đọc luồng SSE của Anthropic: nối các content_block_delta, lấy số token từ message_start/message_delta. */
async function readStream(res: Response, onDelta: (t: string) => void) {
  if (!res.body) throw new LlmError("empty response", false);
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  const line = (l: string) => {
    if (!l.startsWith("data:")) return;
    try {
      const j = JSON.parse(l.slice(5)) as { type?: string; delta?: { text?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number } };
      if (j.type === "content_block_delta" && j.delta?.text) {
        text += j.delta.text;
        onDelta(j.delta.text);
      } else if (j.type === "message_start") tokensIn = j.message?.usage?.input_tokens ?? 0;
      else if (j.type === "message_delta") tokensOut = j.usage?.output_tokens ?? 0;
    } catch {
      /* dòng không phải JSON: bỏ qua */
    }
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lines.forEach(line);
    }
    line(buf);
  } catch {
    throw new LlmError("stream interrupted", true);
  }
  if (!text.trim()) throw new LlmError("empty response", false);
  return { text: text.trim(), tokensIn, tokensOut };
}
