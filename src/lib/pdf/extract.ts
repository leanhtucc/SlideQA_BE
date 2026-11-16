// Bản legacy chạy trên Node không cần canvas.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PageText {
  page: number; // bắt đầu từ 1
  text: string;
}

export const MAX_PAGES = 600;

/** Lỗi có thông điệp an toàn để hiện cho người dùng. */
export class PdfError extends Error {}

/** Trích văn bản từng trang, giữ nguyên số trang để trích dẫn. */
export async function extractPages(data: Uint8Array): Promise<PageText[]> {
  const task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    const name = (e as { name?: string }).name;
    if (name === "PasswordException") throw new PdfError("PDF có mật khẩu, hãy gỡ mật khẩu rồi tải lại.");
    throw new PdfError("Không đọc được PDF. Tệp có thể bị hỏng.");
  }
  try {
    if (doc.numPages > MAX_PAGES) throw new PdfError(`PDF quá dài (${doc.numPages} trang, tối đa ${MAX_PAGES}).`);
    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      let lastY: number | null = null;
      for (const item of content.items as { str?: unknown; transform?: number[] }[]) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += "\n";
        else if (text && !text.endsWith(" ") && !text.endsWith("\n")) text += " ";
        text += item.str;
        if (y !== undefined) lastY = y;
      }
      pages.push({ page: i, text: text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() });
      page.cleanup();
    }
    return pages;
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError("Không đọc được nội dung PDF. Tệp có thể bị hỏng.");
  } finally {
    await task.destroy();
  }
}
