// Staff login. The "secret button" on the site only hides the door; this is
// the lock: a server-checked password and an httpOnly session cookie that page
// scripts can't read.
//
// Sessions are signed tokens (name + expiry + HMAC), not server memory, so any
// serverless instance can verify them. Changing ADMIN_PASSWORD (or
// SESSION_SECRET) signs everyone out.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cookies } from "./http.js";

export const SESSION_COOKIE = "glh_staff";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  name: string;
  expires: number;
}

const password = process.env.ADMIN_PASSWORD ?? "";
const secret = process.env.SESSION_SECRET || createHash("sha256").update(`glh-session:${password}`).digest("hex");

export function staffLoginEnabled(): boolean {
  return password.length >= 8;
}

export function checkPassword(attempt: string): boolean {
  if (!staffLoginEnabled()) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(attempt).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSession(name: string): string {
  const payload = Buffer.from(JSON.stringify({ name, expires: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The logged-in staff member for this request, or null. */
export function staffFor(req: IncomingMessage): Session | null {
  if (!staffLoginEnabled()) return null;
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    return typeof s.name === "string" && typeof s.expires === "number" && Date.now() < s.expires ? s : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/api/admin",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
}
