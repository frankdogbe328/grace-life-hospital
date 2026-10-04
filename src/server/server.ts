// Local server: static files from public/ plus the API. On Vercel, the static
// files are served by the CDN and the API runs as a function instead.

import { createServer, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { aiConfigured } from "./assistant.js";
import { ROOT, handleApi, store } from "./app.js";
import { staffLoginEnabled } from "./auth.js";
import { flushBackend } from "./db.js";

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

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith("/api/")) return void handleApi(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return void res.writeHead(405, { "Content-Type": "text/plain" }).end("Method not allowed");
  }
  void serveStatic(pathname, res);
});

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    return void res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
  }
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
  void flushBackend(store.db).finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => {
  console.log(`Grace Life Hospital running at http://localhost:${PORT}`);
  console.log(aiConfigured() ? "AI assistant: enabled" : "AI assistant: no ANTHROPIC_API_KEY - offline answers only");
  console.log(staffLoginEnabled() ? "Staff console: enabled" : "Staff console: set ADMIN_PASSWORD (8+ chars) to enable");
  console.log(`Storage: ${store.db.name}`);
});
