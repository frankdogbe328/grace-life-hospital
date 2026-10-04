import type {
  ChatErrorCode, Conversation, Mode, NewConversation, ReplyEvent, VisitorEvent, VisitorUpdates,
} from "../../shared/protocol.js";

export type SendOutcome =
  | { kind: "reply"; source: "ai" | "offline" }
  | { kind: "queued" }
  | { kind: "error"; code: ChatErrorCode | "network" };

export async function createConversation(): Promise<NewConversation | null> {
  try {
    const r = await fetch("/api/conversations", { method: "POST" });
    return r.ok ? ((await r.json()) as NewConversation) : null;
  } catch {
    return null;
  }
}

/** The server's transcript; "gone" if the server no longer knows this chat. */
export async function fetchConversation(s: NewConversation): Promise<Conversation | "gone" | null> {
  try {
    const r = await fetch(`/api/conversations/${s.id}`, {
      headers: { "X-Conversation-Token": s.token },
      cache: "no-store",
    });
    if (r.status === 404) return "gone";
    return r.ok ? ((await r.json()) as Conversation) : null;
  } catch {
    return null;
  }
}

/** Sends a visitor message; streamed reply text is fed to onDelta. */
export async function sendMessage(
  s: NewConversation,
  text: string,
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<SendOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/conversations/${s.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Conversation-Token": s.token },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch {
    return { kind: "error", code: "network" };
  }
  if (res.status === 404) return { kind: "error", code: "not_found" };
  if (!res.ok || !res.body) return { kind: "error", code: "network" };

  for await (const event of readSse<ReplyEvent>(res.body)) {
    switch (event.type) {
      case "delta": onDelta(event.text); break;
      case "done": return { kind: "reply", source: event.source };
      case "queued": return { kind: "queued" };
      case "error": return { kind: "error", code: event.code };
    }
  }
  return { kind: "error", code: "network" };
}

export interface Live {
  close(): void;
}

/**
 * Polls for staff replies, mode changes and typing. Polling (not a held-open
 * connection) so it works on serverless hosts. Faster while staff are in the chat.
 */
export function openLive(s: NewConversation, onEvent: (e: VisitorEvent) => void, since = 0): Live {
  let cursor = since;
  let mode: Mode | null = null;
  let staffName: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    let delay = 4000;
    try {
      const r = await fetch(`/api/conversations/${s.id}/updates?since=${cursor}`, {
        headers: { "X-Conversation-Token": s.token },
        cache: "no-store",
      });
      if (r.ok) {
        const u = (await r.json()) as VisitorUpdates;
        if (u.mode !== mode || u.staffName !== staffName) {
          mode = u.mode;
          staffName = u.staffName;
          onEvent({ type: "mode", mode: u.mode, staffName: u.staffName });
        }
        for (const m of u.messages) {
          cursor = Math.max(cursor, m.at);
          onEvent({ type: "message", message: m });
        }
        if (u.typing) onEvent({ type: "typing", staffName: u.typing });
        if (u.mode === "human") delay = 1500;
      }
    } catch {
      /* offline for a moment; try again */
    }
    if (document.hidden) delay = Math.max(delay, 10_000);
    if (!stopped) timer = setTimeout(tick, delay);
  };
  void tick();
  return {
    close() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function* readSse<E>(body: ReadableStream<BufferSource>): AsyncGenerator<E> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const data = buffer
          .slice(0, sep)
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        buffer = buffer.slice(sep + 2);
        if (!data) continue;
        try {
          yield JSON.parse(data) as E;
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    // Connection dropped mid-stream.
  }
}
