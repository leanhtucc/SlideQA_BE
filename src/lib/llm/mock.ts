import type { LlmClient } from "./types.js";

/** Trợ lý giả cho phát triển/demo: trích câu đầu của đoạn [1] trong ngữ cảnh và gắn [1]. Không gọi mạng. */
export const mockLlm: LlmClient = {
  async complete({ user }) {
    const m = /\[1\][^\n]*\n([^\n]+)/.exec(user);
    const first = (m?.[1] ?? "").slice(0, 160);
    const text = first ? `Theo tài liệu: ${first} [1]` : "Tài liệu không có thông tin này.";
    return { text, tokensIn: Math.ceil(user.length / 4), tokensOut: Math.ceil(text.length / 4) };
  },
};
