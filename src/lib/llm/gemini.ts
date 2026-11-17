import { env } from "../../config/env.js";
import { LlmError, type LlmClient } from "./types.js";

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const textOf = (j: GeminiChunk | null) => (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");

/**
 * Gọi Gemini (Google AI Studio) từ server; khóa đi trong header, không nằm trong URL. Lỗi không bao giờ chứa nội dung request/response (NFR-08).
 * Gói miễn phí của Google có thể dùng nội dung gửi lên để cải thiện sản phẩm: chính sách bảo vệ dữ liệu của ta đã nói rõ điều này.
 */
export const gemini: LlmClient = {
  async complete({ system, user, maxTokens, onDelta }) {
    const model = encodeURIComponent(env.GEMINI_MODEL);
    const url = `${env.GEMINI_BASE_URL}/v1beta/models/${model}:${onDelta ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY ?? "" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          // 2.5 Flash mặc định "suy nghĩ" và tính vào maxOutputTokens, dễ làm câu trả lời bị cụt: tắt cho tác vụ hỏi đáp ngắn.
          generationConfig: { maxOutputTokens: maxTokens, ...(/2\.5-flash/.test(env.GEMINI_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
        }),
        signal: AbortSignal.timeout(env.LLM_TIMEOUT_MS),
      });
    } catch {
      throw new LlmError("network or timeout", true);
    }
    if (!res.ok) throw new LlmError(`status ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);

    if (!onDelta) {
      const j = (await res.json().catch(() => null)) as GeminiChunk | null;
      const text = textOf(j).trim();
      if (!text) throw new LlmError("empty response", false); // kể cả bị bộ lọc an toàn chặn
      return { text, tokensIn: j?.usageMetadata?.promptTokenCount ?? 0, tokensOut: j?.usageMetadata?.candidatesTokenCount ?? 0 };
    }

    if (!res.body) throw new LlmError("empty response", false);
    const dec = new TextDecoder();
    let buf = "";
    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    const line = (l: string) => {
      if (!l.startsWith("data:")) return;
      try {
        const j = JSON.parse(l.slice(5)) as GeminiChunk;
        const t = textOf(j);
        if (t) {
          text += t;
          onDelta(t);
        }
        tokensIn = j.usageMetadata?.promptTokenCount ?? tokensIn;
        tokensOut = j.usageMetadata?.candidatesTokenCount ?? tokensOut;
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
  },
};
