// Staff login. The "secret button" on the site only hides the door; this is
// the lock: a server-checked password and an httpOnly session cookie that page
// scripts can't read.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { cookies } from "./http.js";

export const SESSION_COOKIE = "glh_staff";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  name: string;
  expires: number;
}

const sessions = new Map<string, Session>();
const password = process.env.ADMIN_PASSWORD ?? "";

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

export function createSession(name: string): string {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { name, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroySession(req: IncomingMessage): void {
  const token = cookies(req)[SESSION_COOKIE];
  if (token) sessions.delete(token);
}

/** The logged-in staff member for this request, or null. */
export function staffFor(req: IncomingMessage): Session | null {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
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
