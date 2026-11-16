// Kịch bản cổng nghiệm thu P1: chạy toàn bộ luồng qua HTTP vào một server đang chạy rồi DỌN dữ liệu thử.
// Dùng:  GATE_BASE_URL=http://localhost:3931/api/v1 npx tsx scripts/gate-p1.ts
// Server nên chạy với LLM_PROVIDER=mock. Chỉ xóa tài khoản do chính kịch bản này tạo (gate-*@example.test).
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/prisma.js";
import { makePdf } from "../src/test/pdf.js";

const BASE = process.env["GATE_BASE_URL"] ?? "http://localhost:3931/api/v1";
const PASSWORD = "mat-khau-thu-123";
const run = randomUUID().slice(0, 8);
const emails: string[] = [];
const results: { name: string; ok: boolean; note?: string }[] = [];
const timings: Record<string, number> = {};

type Json = Record<string, any>;
async function api(method: string, path: string, o: { token?: string; json?: unknown; form?: FormData; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers["authorization"] = `Bearer ${o.token}`;
  let body: BodyInit | undefined;
  if (o.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(o.json);
  } else if (o.form) body = o.form;
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* không phải JSON (ví dụ PDF) */
  }
  return { status: res.status, data, headers: res.headers, raw: text };
}
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, ...(note ? { note } : {}) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  (${note})` : ""}`);
}
const time = async <T>(label: string, f: () => Promise<T>) => {
  const t = performance.now();
  const r = await f();
  timings[label] = Math.round(performance.now() - t);
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(tag: string) {
  const email = `gate-${run}-${tag}@example.test`;
  emails.push(email);
  const r = await api("POST", "/auth/register", { json: { email, password: PASSWORD, displayName: `Gate ${tag}`, acceptTerms: true } });
  return { email, ...r };
}
async function upload(token: string, courseId: string, pdf: Buffer, name: string) {
  const form = new FormData();
  form.set("courseId", courseId);
  form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), name);
  return api("POST", "/documents", { token, form });
}
async function waitReady(token: string, id: string, timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await api("GET", `/documents/${id}`, { token });
    if (d.data["status"] !== "processing") return { doc: d.data, ms: Date.now() - t0 };
    await sleep(500);
  }
  return { doc: { status: "timeout" } as Json, ms: timeoutMs };
}

try {
  console.log(`Cổng P1 → ${BASE}\n`);

  const health = await api("GET", "/health");
  check("health trả ok", health.status === 200 && health.data["ok"] === true, `llmEnabled=${health.data["llmEnabled"]}`);

  // --- Tài khoản ---
  const a = await time("register", () => register("a"));
  check("đăng ký A (201, có token)", a.status === 201 && !!a.data["accessToken"]);
  const b = await register("b");
  check("đăng ký B (201)", b.status === 201);
  const dup = await api("POST", "/auth/register", { json: { email: a.email.toUpperCase(), password: PASSWORD, displayName: "x", acceptTerms: true } });
  check("email trùng trả 409", dup.status === 409);
  const login = await time("login", () => api("POST", "/auth/login", { json: { email: a.email, password: PASSWORD } }));
  check("đăng nhập A", login.status === 200);
  const wrongPw = await api("POST", "/auth/login", { json: { email: a.email, password: "sai-mat-khau-1" } });
  check("sai mật khẩu trả 401", wrongPw.status === 401);
  const tokA: string = login.data["accessToken"];
  const rt1: string = login.data["refreshToken"];
  const ref = await api("POST", "/auth/refresh", { json: { refreshToken: rt1 } });
  check("refresh xoay vòng", ref.status === 200 && ref.data["refreshToken"] !== rt1);
  const reuse = await api("POST", "/auth/refresh", { json: { refreshToken: rt1 } });
  check("dùng lại refresh token cũ bị từ chối", reuse.status === 401);
  const me = await api("GET", "/me", { token: tokA });
  check("GET /me đúng người", me.status === 200 && me.data["email"] === a.email);
  check("/me không token trả 401", (await api("GET", "/me")).status === 401);
  const tokB: string = b.data["accessToken"];

  // --- Môn học + tài liệu ---
  const course = await api("POST", "/courses", { token: tokA, json: { name: "Gate môn học" } });
  check("tạo môn học", course.status === 201);
  const courseId: string = course.data["id"];

  const small = await upload(tokA, courseId, makePdf(["Gateway XOR chon dung mot luong di", "Pool va lane phan chia trach nhiem", "Su kien bat dau va ket thuc"]), "gate-nho.pdf");
  check("tải PDF nhỏ trả 202 processing", small.status === 202 && small.data["status"] === "processing");
  const r1 = await waitReady(tokA, small.data["id"]);
  check("PDF nhỏ xử lý nền → ready, 3 trang", r1.doc["status"] === "ready" && r1.doc["pages"] === 3, `${r1.ms} ms`);
  timings["pdf_3_pages_ready"] = r1.ms;

  check("từ chối tệp không phải PDF (422)", (await upload(tokA, courseId, Buffer.from("khong phai pdf"), "x.pdf")).status === 422);

  const range = await fetch(`${BASE}/documents/${small.data["id"]}/file`, { headers: { authorization: `Bearer ${tokA}`, range: "bytes=0-9" } });
  check("stream PDF Range trả 206", range.status === 206 && range.headers.get("content-range")?.startsWith("bytes 0-9/") === true);

  // --- NFR-03: PDF 100 trang ---
  const pages100 = Array.from({ length: 100 }, (_, i) => `Trang so ${i + 1} noi dung rieng gatezebra${i + 1} va mot it chu chung`);
  const big = await upload(tokA, courseId, makePdf(pages100), "gate-100-trang.pdf");
  const r100 = await waitReady(tokA, big.data["id"]);
  timings["pdf_100_pages_ready"] = r100.ms;
  check("PDF 100 trang → ready dưới 60 giây (NFR-03)", r100.doc["status"] === "ready" && r100.doc["pages"] === 100 && r100.ms < 60_000, `${r100.ms} ms (tệp dựng sẵn, chữ ASCII)`);

  // --- Tìm đúng trang qua hỏi đáp (extractive trước, rồi llm sau khi đồng ý) ---
  const conv = await api("POST", "/conversations", { token: tokA, json: { documentIds: [big.data["id"]] } });
  const noConsent = await api("POST", `/conversations/${conv.data["id"]}/messages`, { token: tokA, json: { question: "gatezebra73" } });
  check("chưa đồng ý: chế độ extractive, nguồn đúng trang 73", noConsent.data["mode"] === "extractive" && noConsent.data["sources"]?.[0]?.page === 73);
  const consent = await api("PUT", "/me/llm-consent", { token: tokA, json: { granted: true } });
  check("ghi đồng ý gửi dữ liệu cho AI", consent.status === 200 && !!consent.data["llmConsentAt"]);
  const ask = await time("ask_llm_mock", () => api("POST", `/conversations/${conv.data["id"]}/messages`, { token: tokA, json: { question: "gatezebra37 nói về gì" } }));
  check("hỏi đáp mode llm (mock), nguồn đúng trang 37", ask.data["mode"] === "llm" && ask.data["sources"]?.[0]?.page === 37, `${timings["ask_llm_mock"]} ms`);
  const nomatch = await api("POST", `/conversations/${conv.data["id"]}/messages`, { token: tokA, json: { question: "công thức nấu phở bò" } });
  check("ngoài tài liệu → no-match, không có nguồn", nomatch.data["mode"] === "no-match" && nomatch.data["sources"]?.length === 0);
  const detail = await api("GET", `/conversations/${conv.data["id"]}`, { token: tokA });
  check("lịch sử hội thoại lưu đủ 6 tin nhắn", detail.data["messages"]?.length === 6);

  // --- Quiz ---
  const quiz = await api("POST", "/quizzes", { token: tokA, json: { documentId: small.data["id"], count: 3 } });
  check("tạo quiz (mock) 3 câu, không lộ đáp án", quiz.status === 201 && quiz.data["items"]?.length === 3 && !("correctIndex" in quiz.data["items"][0]));
  const att = await api("POST", `/quizzes/${quiz.data["id"]}/attempts`, { token: tokA });
  const first = quiz.data["items"][0];
  const ans = await api("PUT", `/attempts/${att.data["id"]}/answers/${first.id}`, { token: tokA, json: { chosenIndex: 0 } });
  check("chấm từng câu, trả đáp án + giải thích", ans.status === 200 && typeof ans.data["correctIndex"] === "number" && !!ans.data["explanation"]);
  const fin = await api("POST", `/attempts/${att.data["id"]}/finish`, { token: tokA });
  check("kết thúc: có điểm và tổng 3", fin.status === 200 && fin.data["total"] === 3 && typeof fin.data["score"] === "number", `điểm ${fin.data["score"]}/3`);

  // --- Cách ly người dùng (NFR-07) ---
  const crossStatuses = await Promise.all([
    api("GET", `/courses/${courseId}`, { token: tokB }),
    api("GET", `/documents/${small.data["id"]}`, { token: tokB }),
    api("GET", `/documents/${small.data["id"]}/file`, { token: tokB }),
    api("GET", `/conversations/${conv.data["id"]}`, { token: tokB }),
    api("GET", `/quizzes/${quiz.data["id"]}`, { token: tokB }),
    api("GET", `/attempts/${att.data["id"]}`, { token: tokB }),
    api("DELETE", `/documents/${small.data["id"]}`, { token: tokB }),
  ]);
  check("B không truy cập chéo dữ liệu của A (7 truy vấn đều 404)", crossStatuses.every((r) => r.status === 404), crossStatuses.map((r) => r.status).join(","));
  const bLists = await Promise.all([api("GET", "/courses", { token: tokB }), api("GET", "/documents", { token: tokB }), api("GET", "/conversations", { token: tokB }), api("GET", "/quizzes", { token: tokB })]);
  check("danh sách của B đều rỗng", bLists.every((r) => Array.isArray(r.data) && r.data.length === 0));
  const bConv = await api("POST", "/conversations", { token: tokB, json: {} });
  const bAsk = await api("POST", `/conversations/${bConv.data["id"]}/messages`, { token: tokB, json: { question: "gatezebra73 gateway XOR" } });
  check("B hỏi về nội dung của A → no-match (không tìm thấy tài liệu người khác)", bAsk.data["mode"] === "no-match");

  // --- Database ---
  const rls = await prisma.$queryRaw<{ relname: string }[]>`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity AND c.relname NOT LIKE '\_prisma%'`;
  check("mọi bảng ứng dụng bật RLS", rls.length === 0, rls.map((r) => r.relname).join(","));
  const enc = await prisma.$queryRaw<{ server_encoding: string }[]>`SHOW server_encoding`;
  check("database UTF-8", enc[0]?.server_encoding === "UTF8");
} finally {
  // --- Dọn dữ liệu thử: chỉ tài khoản gate-<run>-*; cascade xóa mọi dữ liệu liên quan ---
  const del = await prisma.user.deleteMany({ where: { email: { in: emails } } });
  const left = await prisma.user.count({ where: { email: { startsWith: `gate-${run}-` } } });
  const orphanJobs = await prisma.job.count({ where: { status: { in: ["queued", "running"] } } });
  check(`dọn dữ liệu thử (xóa ${del.count} tài khoản, còn lại ${left})`, left === 0);
  console.log(`  (job còn chờ trong hệ thống: ${orphanJobs})`);
  await prisma.$disconnect();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nThời gian đo (ms):`, timings);
console.log(`\n${results.length - failed.length}/${results.length} đạt${failed.length ? ` — ${failed.length} lỗi: ${failed.map((f) => f.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
