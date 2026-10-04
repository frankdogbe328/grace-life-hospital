// The API router, shared by the local server (server.ts) and the Vercel
// function (api/[...path].js). The Anthropic API key and the staff password
// live only on the server; the browser never sees either.

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiConfigured } from "./assistant.js";
import { staffLoginEnabled } from "./auth.js";
import { createBackend } from "./db.js";
import { HttpError, json } from "./http.js";
import { adminRoutes } from "./routes-admin.js";
import { visitorRoutes } from "./routes-visitor.js";
import { ConversationStore } from "./store.js";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const store = new ConversationStore(createBackend(join(ROOT, "data", "conversations.json")));
const visitor = visitorRoutes(store);
const admin = adminRoutes(store);

const since = (u: URL) => Number(u.searchParams.get("since")) || 0;

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => unknown;
const ROUTES: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/api\/health$/, (_q, s) =>
    json(s, 200, { ok: true, ai: aiConfigured(), staff: staffLoginEnabled(), storage: store.db.name })],

  ["POST", /^\/api\/conversations$/, (q, s) => visitor.create(q, s)],
  ["GET", /^\/api\/conversations\/([\w-]+)$/, (q, s, [id]) => visitor.get(q, s, id!)],
  ["GET", /^\/api\/conversations\/([\w-]+)\/updates$/, (q, s, [id], u) => visitor.updates(q, s, id!, since(u))],
  ["POST", /^\/api\/conversations\/([\w-]+)\/messages$/, (q, s, [id]) => visitor.message(q, s, id!)],

  ["POST", /^\/api\/admin\/login$/, (q, s) => admin.login(q, s)],
  ["POST", /^\/api\/admin\/logout$/, (q, s) => admin.logout(q, s)],
  ["GET", /^\/api\/admin\/me$/, (q, s) => admin.me(q, s)],
  ["GET", /^\/api\/admin\/updates$/, (q, s, _p, u) => admin.updates(q, s, since(u))],
  ["GET", /^\/api\/admin\/conversations$/, (q, s) => admin.list(q, s)],
  ["GET", /^\/api\/admin\/conversations\/([\w-]+)$/, (q, s, [id]) => admin.get(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/reply$/, (q, s, [id]) => admin.reply(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/takeover$/, (q, s, [id]) => admin.takeover(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/release$/, (q, s, [id]) => admin.release(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/read$/, (q, s, [id]) => admin.read(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/typing$/, (q, s, [id]) => admin.typing(q, s, id!)],
];

/** Handles one /api/* request. Never throws. */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let pathMatched = false;
    for (const [m, pattern, handler] of ROUTES) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (m === method) return void (await handler(req, res, match.slice(1), url));
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "method_not_allowed" : "not_found");
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) json(res, err.status, { error: err.code });
      else res.end();
      return;
    }
    console.error("[api] unhandled", err);
    if (!res.headersSent) json(res, 500, { error: "internal" });
    else res.end();
  }
}
