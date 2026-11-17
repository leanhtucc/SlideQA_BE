import type { LlmClient } from "./types.js";

const DISTRACTORS = ["Không có nội dung nào ở trên", "Tài liệu không đề cập đến điều này", "Một khái niệm hoàn toàn khác"];

/** Quiz giả: mỗi đoạn [trang N] thành một câu "Nội dung nào có trong trang N?" với đáp án đúng là câu đầu của đoạn. */
function mockQuiz(user: string): string {
  const count = Number(/Tạo (\d+) câu/.exec(user)?.[1] ?? 3);
  const items = [...user.matchAll(/\[trang (\d+)\]\n([^\n]+)/g)].slice(0, count).map((m, i) => {
    const correct = i % 4;
    const options = [...DISTRACTORS];
    options.splice(correct, 0, (m[2] ?? "").slice(0, 120));
    return {
      question: `Nội dung nào sau đây có trong trang ${m[1]}?`,
      options,
      correct,
      explanation: `Đoạn này nằm ở trang ${m[1]} của tài liệu.`,
      page: Number(m[1]),
    };
  });
  return JSON.stringify(items);
}

/** Trợ lý giả cho phát triển/demo, không gọi mạng. Hỏi đáp: câu đầu của đoạn [1] kèm [1]. Quiz: xem mockQuiz. */
export const mockLlm: LlmClient = {
  async complete({ system, user }) {
    let text: string;
    if (system.includes("viết lại câu hỏi nối tiếp")) {
      // Mock không hiểu ngữ cảnh: trả lại nguyên câu nối tiếp (đủ để chạy thử luồng, không làm hỏng tìm kiếm).
      text = (/CÂU HỎI NỐI TIẾP: (.*)$/.exec(user)?.[1] ?? "").trim();
    } else if (system.includes("trắc nghiệm")) {
      text = mockQuiz(user);
    } else {
      const first = (/\[1\][^\n]*\n([^\n]+)/.exec(user)?.[1] ?? "").slice(0, 160);
      text = first ? `Theo tài liệu: ${first} [1]` : "Tài liệu không có thông tin này.";
    }
    return { text, tokensIn: Math.ceil(user.length / 4), tokensOut: Math.ceil(text.length / 4) };
  },
};
