import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// ใช้โครงสร้างการส่งค่า config อ้อม ผ่านการระบุชื่อคุณสมบัติภายในออบเจกต์
export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;