import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { env } from "../../config/env.js";
import { SupabaseStorage } from "./supabase.js";

/** Kho tệp. Khóa luôn do server sinh (`<userId>/<uuid>.pdf`), không bao giờ lấy từ tên tệp người dùng (NFR-10). */
export interface Storage {
  /** Lưu tệp từ một đường dẫn tạm trên đĩa. */
  put(key: string, fromPath: string): Promise<void>;
  size(key: string): Promise<number>;
  read(key: string, range?: { start: number; end: number }): Readable;
  /** Xóa tệp; không lỗi nếu tệp không còn. */
  remove(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("Khóa lưu trữ không hợp lệ.");
    return p;
  }

  async put(key: string, fromPath: string) {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(fromPath, dest);
  }

  async size(key: string) {
    return (await stat(this.path(key))).size;
  }

  read(key: string, range?: { start: number; end: number }) {
    return createReadStream(this.path(key), range);
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

// Cục bộ cho phát triển; Supabase Storage khi deploy (container mất đĩa mỗi lần triển khai lại).
export const storage: Storage =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
    ? new SupabaseStorage(env.SUPABASE_URL.replace(/\/+$/, ""), env.SUPABASE_SERVICE_KEY, env.SUPABASE_BUCKET)
    : new LocalStorage(env.STORAGE_DIR);
