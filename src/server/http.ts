import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}

/**
 * Reads a JSON body. Requiring the JSON content type also blocks cross-site
 * form posts (they can't set it without a CORS preflight we never grant).
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  const raw = await new Promise<string>((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, "too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

export interface Sse<E> {
  send(event: E): void;
  close(): void;
  readonly closed: boolean;
}

/** Opens a server-sent-events response with a keep-alive ping. */
export function openSse<E>(req: IncomingMessage, res: ServerResponse): Sse<E> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  let closed = false;
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  const done = () => {
    closed = true;
    clearInterval(ping);
  };
  req.on("close", done);
  return {
    send(event) {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      done();
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t || null;
}
