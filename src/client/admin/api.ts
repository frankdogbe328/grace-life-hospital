import type { AdminEvent, Conversation, ConversationSummary, Message } from "../../shared/protocol.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", cache: "no-store" };
  if (method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  const r = await fetch(`/api/admin${path}`, init);
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(r.status, data.error ?? "error");
  return data as T;
}

export const api = {
  login: (name: string, password: string) => call<{ name: string }>("POST", "/login", { name, password }),
  logout: () => call<{ ok: true }>("POST", "/logout"),
  me: () => call<{ name: string; staffOnline: number }>("GET", "/me"),
  list: () => call<ConversationSummary[]>("GET", "/conversations"),
  get: (id: string) => call<Conversation>("GET", `/conversations/${id}`),
  reply: (id: string, text: string) => call<Message>("POST", `/conversations/${id}/reply`, { text }),
  takeover: (id: string) => call<{ ok: true }>("POST", `/conversations/${id}/takeover`),
  release: (id: string) => call<{ ok: true }>("POST", `/conversations/${id}/release`),
  read: (id: string) => call<{ ok: true }>("POST", `/conversations/${id}/read`),
  typing: (id: string) => call<{ ok: true }>("POST", `/conversations/${id}/typing`),
  live(onEvent: (e: AdminEvent) => void, onDown: () => void): EventSource {
    const es = new EventSource("/api/admin/live");
    es.onmessage = (m: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(m.data) as AdminEvent);
      } catch {
        /* ignore */
      }
    };
    es.onerror = onDown;
    return es;
  },
};
