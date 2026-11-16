import "../db/guard.js";
import { randomUUID } from "node:crypto";
import request from "supertest";

// Phải đặt env trước khi import app (env.ts đọc process.env lúc import).
process.env["JWT_ACCESS_SECRET"] ??= "test-secret-test-secret-test-secret-123";
process.env["BCRYPT_ROUNDS"] = "4";
process.env["LOGIN_RATE_MAX"] = "1000";
export const { app } = await import("../app.js");
export const { prisma } = await import("../prisma.js");

const emails: string[] = [];
export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: { authorization: string };
}

export async function signup(): Promise<TestUser> {
  const email = `t-${randomUUID()}@example.test`;
  emails.push(email);
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ email, password: "mat-khau-thu-123", displayName: "Tester", acceptTerms: true });
  if (res.status !== 201) throw new Error(`signup lỗi: ${res.status}`);
  return { id: res.body.user.id, email, token: res.body.accessToken, auth: { authorization: `Bearer ${res.body.accessToken}` } };
}

/** Gọi trong after() của mỗi file test. */
export async function cleanup() {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
}
