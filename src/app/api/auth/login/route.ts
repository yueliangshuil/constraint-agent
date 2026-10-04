import { NextResponse } from "next/server";
import { z } from "zod";
import { login } from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().email("邮箱格式不正确"),
  password: z.string().min(6, "密码至少 6 位"),
});

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不合法" },
      { status: 400 }
    );
  }
  const result = await login(parsed.data.email, parsed.data.password);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }
  return NextResponse.json(result);
}
