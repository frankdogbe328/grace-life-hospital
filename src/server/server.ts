// Static site + chat API + staff console API. The Anthropic API key and the
// staff password live only here; the browser never sees either.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { aiConfigured } from "./assistant.js";
import { staffLoginEnabled } from "./auth.js";
import { HttpError, json } from "./http.js";
import { adminRoutes } from "./routes-admin.js";
import { visitorRoutes } from "./routes-visitor.js";
import { ConversationStore } from "./store.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "../..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 8080);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const store = new ConversationStore(join(ROOT, "data", "conversations.json"));
await store.load();
const visitor = visitorRoutes(store);
const admin = adminRoutes(store);

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => unknown;
const ROUTES: Array<[method: string, pattern: RegExp, handler: Handler]> = [
  ["GET", /^\/api\/health$/, (_q, s) => json(s, 200, { ok: true, ai: aiConfigured() })],

  ["POST", /^\/api\/conversations$/, (q, s) => visitor.create(q, s)],
  ["GET", /^\/api\/conversations\/([\w-]+)$/, (q, s, [id]) => visitor.get(q, s, id!)],
  ["POST", /^\/api\/conversations\/([\w-]+)\/messages$/, (q, s, [id]) => visitor.message(q, s, id!)],
  ["GET", /^\/api\/conversations\/([\w-]+)\/live$/, (q, s, [id], u) => visitor.live(q, s, id!, u.searchParams.get("token"))],

  ["POST", /^\/api\/admin\/login$/, (q, s) => admin.login(q, s)],
  ["POST", /^\/api\/admin\/logout$/, (q, s) => admin.logout(q, s)],
  ["GET", /^\/api\/admin\/me$/, (q, s) => admin.me(q, s)],
  ["GET", /^\/api\/admin\/live$/, (q, s) => admin.live(q, s)],
  ["GET", /^\/api\/admin\/conversations$/, (q, s) => admin.list(q, s)],
  ["GET", /^\/api\/admin\/conversations\/([\w-]+)$/, (q, s, [id]) => admin.get(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/reply$/, (q, s, [id]) => admin.reply(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/takeover$/, (q, s, [id]) => admin.takeover(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/release$/, (q, s, [id]) => admin.release(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/read$/, (q, s, [id]) => admin.read(q, s, id!)],
  ["POST", /^\/api\/admin\/conversations\/([\w-]+)\/typing$/, (q, s, [id]) => admin.typing(q, s, id!)],
];

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) {
      if (!res.headersSent) json(res, err.status, { error: err.code });
      else res.end();
      return;
    }
    console.error("[server] unhandled", err);
    if (!res.headersSent) json(res, 500, { error: "internal" });
    else res.end();
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (url.pathname.startsWith("/api/")) {
    let pathMatched = false;
    for (const [m, pattern, handler] of ROUTES) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (m === method) return void (await handler(req, res, match.slice(1), url));
    }
    throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "method_not_allowed" : "not_found");
  }

  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed");
  return serveStatic(url.pathname, res);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(403, "forbidden");

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const shutdown = () => {
  void store.flush().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Grace Life Hospital running at http://localhost:${PORT}`);
  console.log(aiConfigured() ? "AI assistant: enabled" : "AI assistant: no ANTHROPIC_API_KEY - offline answers only");
  console.log(staffLoginEnabled() ? "Staff console: enabled" : "Staff console: set ADMIN_PASSWORD (8+ chars) to enable");
});
