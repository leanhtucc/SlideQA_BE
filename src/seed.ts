import bcrypt from "bcrypt";
import { prisma } from "./prisma.js";

// Chỉ để phát triển và test thủ công hai tài khoản truy cập chéo (NFR-07).
// Mật khẩu dev dưới đây là giá trị thử, không dùng cho môi trường thật.
const DEV_PASSWORD = "Password123!";

if (process.env.NODE_ENV === "production") {
  throw new Error("Không chạy seed ở production.");
}

const hash = await bcrypt.hash(DEV_PASSWORD, 10);

for (const [email, displayName, course] of [
  ["alice@example.test", "Alice", "Phân tích quy trình nghiệp vụ"],
  ["bob@example.test", "Bob", "Cơ sở dữ liệu"],
] as const) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName, passwordHash: hash },
  });
  const exists = await prisma.course.findFirst({ where: { userId: user.id, name: course } });
  if (!exists) await prisma.course.create({ data: { userId: user.id, name: course } });
  console.log(`seed: ${email}`);
}

await prisma.$disconnect();
