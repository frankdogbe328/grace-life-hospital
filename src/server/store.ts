// Conversation operations on top of a storage backend (see db.ts). Every call
// reads and writes the backend, so it works across serverless instances.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Conversation, ConversationSummary, Message, Mode, Sender } from "../shared/protocol.js";
import type { Backend, Stored } from "./db.js";

export type { Stored } from "./db.js";

const MAX_MESSAGES = 300;

export class ConversationStore {
  constructor(readonly db: Backend) {}

  async create(): Promise<Stored> {
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
    await this.db.putConv(c);
    return c;
  }

  /** Looks up a conversation for a visitor, checking their token in constant time. */
  async authorize(id: string, token: string): Promise<Stored | null> {
    const c = await this.db.getConv(id);
    if (!c) return null;
    const a = Buffer.from(c.token);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b) ? c : null;
  }

  get(id: string): Promise<Stored | null> {
    return this.db.getConv(id);
  }

  async list(since = 0): Promise<ConversationSummary[]> {
    const all = await this.db.listConvs(since, 200);
    return all.filter((c) => c.messageCount > 0).map(summarize);
  }

  /** Adds a message and saves. Mutates `c` so callers see the new state. */
  async append(c: Stored, from: Sender, text: string, staffName?: string): Promise<Message> {
    const message = addMessage(c, from, text, staffName);
    await this.db.putConv(c);
    return message;
  }

  async update(c: Stored, patch: Partial<Pick<Stored, "mode" | "staffName" | "wantsHuman" | "urgent" | "unread">>): Promise<void> {
    Object.assign(c, patch);
    c.updatedAt = Math.max(Date.now(), c.updatedAt + 1);
    await this.db.putConv(c);
  }

  setMode(c: Stored, mode: Mode, staffName: string | null): Promise<void> {
    return this.update(c, { mode, staffName, wantsHuman: mode === "human" ? false : c.wantsHuman });
  }
}

/** In-memory part of append, for batching several changes into one save. */
export function addMessage(c: Stored, from: Sender, text: string, staffName?: string): Message {
  // Strictly increasing timestamps so "messages since X" polling never misses one.
  const at = Math.max(Date.now(), (c.last?.at ?? 0) + 1);
  const message: Message = { id: randomUUID(), from, text, at };
  if (staffName !== undefined) message.staffName = staffName;
  c.messages.push(message);
  if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
  c.last = message;
  c.messageCount++;
  c.updatedAt = Math.max(at, c.updatedAt + 1);
  if (from === "visitor") c.unread++;
  return message;
}

export function summarize(c: Conversation): ConversationSummary {
  const { messages: _messages, ...rest } = c;
  const { token: _token, ...summary } = rest as Conversation & { token?: string };
  return summary;
}

export function publicConversation(c: Stored): Conversation {
  return { ...summarize(c), messages: c.messages };
}
