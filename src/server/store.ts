// Conversations live in memory and are flushed to data/conversations.json so a
// restart doesn't lose them. Fine for one hospital site on one server; swap for
// a database if this ever runs on several instances.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Conversation, ConversationSummary, Message, Mode, Sender } from "../shared/protocol.js";

interface Stored extends Conversation {
  token: string;
}

export type StoreEvent =
  | { type: "message"; conversation: Stored; message: Message }
  | { type: "changed"; conversation: Stored };

const MAX_CONVERSATIONS = 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 300;

export class ConversationStore {
  private readonly convos = new Map<string, Stored>();
  private readonly listeners = new Set<(e: StoreEvent) => void>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await readFile(this.file, "utf8")) as Stored[];
      const cutoff = Date.now() - MAX_AGE_MS;
      for (const c of list) if (c.updatedAt >= cutoff) this.convos.set(c.id, c);
    } catch {
      // First run or unreadable file: start empty.
    }
  }

  subscribe(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  create(): Stored {
    const now = Date.now();
    const c: Stored = {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      createdAt: now,
      updatedAt: now,
      mode: "bot",
      staffName: null,
      wantsHuman: false,
      urgent: false,
      unread: 0,
      last: null,
      messageCount: 0,
      messages: [],
    };
    this.convos.set(c.id, c);
    this.evictOldest();
    this.changed(c);
    return c;
  }

  /** Looks up a conversation for a visitor, checking their token in constant time. */
  authorize(id: string, token: string): Stored | null {
    const c = this.convos.get(id);
    if (!c) return null;
    const a = Buffer.from(c.token);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b) ? c : null;
  }

  get(id: string): Stored | null {
    return this.convos.get(id) ?? null;
  }

  list(): ConversationSummary[] {
    return [...this.convos.values()]
      .filter((c) => c.messageCount > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(summarize);
  }

  append(c: Stored, from: Sender, text: string, staffName?: string): Message {
    const message: Message = { id: randomUUID(), from, text, at: Date.now() };
    if (staffName !== undefined) message.staffName = staffName;
    c.messages.push(message);
    if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
    c.last = message;
    c.messageCount++;
    c.updatedAt = message.at;
    if (from === "visitor") c.unread++;
    this.emit({ type: "message", conversation: c, message });
    this.changed(c);
    return message;
  }

  update(c: Stored, patch: Partial<Pick<Stored, "mode" | "staffName" | "wantsHuman" | "urgent" | "unread">>): void {
    Object.assign(c, patch);
    this.changed(c);
  }

  setMode(c: Stored, mode: Mode, staffName: string | null): void {
    this.update(c, { mode, staffName, wantsHuman: mode === "human" ? false : c.wantsHuman });
  }

  private changed(c: Stored): void {
    this.emit({ type: "changed", conversation: c });
    this.scheduleFlush();
  }

  private emit(e: StoreEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private evictOldest(): void {
    if (this.convos.size <= MAX_CONVERSATIONS) return;
    const oldest = [...this.convos.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const c of oldest.slice(0, this.convos.size - MAX_CONVERSATIONS)) this.convos.delete(c.id);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 500);
  }

  async flush(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.convos.values()]));
      await rename(tmp, this.file);
    } catch (err) {
      console.error("[store] could not save conversations", err);
    }
  }
}

export function summarize(c: Conversation): ConversationSummary {
  const { messages: _messages, ...rest } = c;
  const { token: _token, ...summary } = rest as Conversation & { token?: string };
  return summary;
}

export function publicConversation(c: Stored): Conversation {
  return { ...summarize(c), messages: c.messages };
}
