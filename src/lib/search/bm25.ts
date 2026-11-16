/**
 * BM25 đơn giản, chạy hoàn toàn local, không cần embedding API.
 * Tiếng Việt: tách theo âm tiết + bigram, và so khớp cả dạng bỏ dấu
 * để người dùng gõ không dấu vẫn tìm được.
 */

export function foldDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

const STOP = new Set([
  "la", "va", "cua", "cac", "mot", "nhung", "co", "duoc", "trong", "cho", "voi", "de", "khi",
  "nay", "do", "the", "nao", "gi", "thi", "ma", "tu", "den", "o", "the", "nhu", "hay", "bi",
  "the", "and", "of", "to", "in", "is", "a", "the",
]);

const MIN_COVERAGE = 0.3;

export function tokenize(text: string): string[] {
  const words = foldDiacritics(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP.has(w));
  const out = [...words];
  for (let i = 0; i < words.length - 1; i++) out.push(words[i] + "_" + words[i + 1]);
  return out;
}

export interface Chunk {
  id: string;
  docId: string;
  page: number;
  /** Thứ tự đoạn khi một trang bị cắt */
  part: number;
  text: string;
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

export class BM25Index {
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private df = new Map<string, number>();
  private avg = 0;
  constructor(public chunks: Chunk[], private k1 = 1.5, private b = 0.75) {
    for (const c of chunks) {
      const toks = tokenize(c.text);
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }

  search(query: string, k = 5, filter?: (c: Chunk) => boolean): Hit[] {
    const q = tokenize(query);
    const uni = q.filter((t) => !t.includes("_"));
    const N = this.chunks.length;
    const hits: Hit[] = [];
    for (let i = 0; i < N; i++) {
      const c = this.chunks[i];
      const tf = this.tf[i];
      const len = this.len[i];
      if (!c || !tf || len === undefined) continue;
      if (filter && !filter(c)) continue;
      // Độ phủ từ khóa: loại các đoạn chỉ khớp ngẫu nhiên 1 từ (vd "thức"/"thúc"
      // trùng nhau khi bỏ dấu), để câu hỏi ngoài tài liệu trả về rỗng.
      const matched = uni.filter((t) => tf.has(t)).length;
      if (uni.length > 0 && matched / uni.length < MIN_COVERAGE) continue;
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const norm = f * (this.k1 + 1) / (f + this.k1 * (1 - this.b + (this.b * len) / (this.avg || 1)));
        // bigram khớp là tín hiệu mạnh hơn
        score += idf * norm * (t.includes("_") ? 1.5 : 1);
      }
      if (score > 0) hits.push({ chunk: c, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

/** Mỗi trang là một chunk; trang quá dài thì cắt theo đoạn, vẫn giữ số trang. */
export function chunkPages(docId: string, pages: { page: number; text: string }[], maxChars = 1800): Chunk[] {
  const out: Chunk[] = [];
  for (const p of pages) {
    if (!p.text.trim()) continue;
    if (p.text.length <= maxChars) {
      out.push({ id: `${docId}:${p.page}:0`, docId, page: p.page, part: 0, text: p.text });
      continue;
    }
    let buf = "";
    let part = 0;
    for (const para of p.text.split(/\n+/)) {
      if (buf && buf.length + para.length > maxChars) {
        out.push({ id: `${docId}:${p.page}:${part}`, docId, page: p.page, part, text: buf });
        part++;
        buf = "";
      }
      buf += (buf ? "\n" : "") + para;
    }
    if (buf) out.push({ id: `${docId}:${p.page}:${part}`, docId, page: p.page, part, text: buf });
  }
  return out;
}
