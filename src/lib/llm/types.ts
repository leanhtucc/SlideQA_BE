export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Có thì trả lời dạng dòng chảy: gọi với từng đoạn chữ ngay khi có (E7) */
  onDelta?: (text: string) => void;
}
export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** `retryable`: lỗi tạm thời (mạng, hết giờ, 5xx, 429) nên thử lại; lỗi khác thì thôi. */
export class LlmError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}
