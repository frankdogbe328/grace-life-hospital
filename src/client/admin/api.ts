import type { AdminEvent, AdminUpdates, Conversation, ConversationSummary, Message } from "../../shared/protocol.js";

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
  /**
   * Polls for changed conversations and presence, turned into AdminEvents.
   * Polling (not a held-open connection) so it works on serverless hosts.
   * Calls onSignedOut if the session is no longer valid.
   */
  live(onEvent: (e: AdminEvent) => void, onSignedOut: () => void, known: ConversationSummary[]): { close(): void } {
    let cursor = known.reduce((m, c) => Math.max(m, c.updatedAt), 0);
    const lastAt = new Map(known.map((c) => [c.id, c.last?.at ?? 0]));
    let online = -1;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const u = await call<AdminUpdates>("GET", `/updates?since=${cursor}`);
        cursor = Math.max(cursor, u.cursor);
        if (u.staffOnline !== online) {
          online = u.staffOnline;
          onEvent({ type: "presence", staffOnline: online });
        }
        for (const summary of u.conversations) {
          onEvent({ type: "conversation", summary });
          const last = summary.last;
          if (last && last.at > (lastAt.get(summary.id) ?? 0)) {
            lastAt.set(summary.id, last.at);
            onEvent({ type: "message", conversationId: summary.id, message: last });
          }
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          stopped = true;
          onSignedOut();
          return;
        }
      }
      if (!stopped) timer = setTimeout(tick, document.hidden ? 5000 : 2000);
    };
    timer = setTimeout(tick, 1000);
    return {
      close() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  },
};
