// Wire contract between the browser (visitor chat + staff console) and the server.

export type Sender = "visitor" | "bot" | "staff" | "system";

export interface Message {
  id: string;
  from: Sender;
  text: string;
  /** Epoch ms. */
  at: number;
  /** Display name of the staff member, for from === "staff". */
  staffName?: string;
}

/** "bot": the assistant answers. "human": staff have taken over; the bot stays quiet. */
export type Mode = "bot" | "human";

export interface ConversationSummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: Mode;
  staffName: string | null;
  wantsHuman: boolean;
  urgent: boolean;
  /** Visitor messages staff haven't opened yet. */
  unread: number;
  last: Message | null;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
}

export interface NewConversation {
  id: string;
  token: string;
}

/** Response stream for POST /api/conversations/:id/messages (SSE). */
export type ReplyEvent =
  | { type: "delta"; text: string }
  | { type: "done"; source: "ai" | "offline" }
  /** Staff are handling this chat; the message went to them, no bot reply. */
  | { type: "queued" }
  | { type: "error"; code: ChatErrorCode };

export type ChatErrorCode = "rate_limited" | "bad_request" | "not_found";

/**
 * Live updates are polled (serverless hosts can't hold connections open).
 * GET /api/conversations/:id/updates?since=<last message at>
 */
export interface VisitorUpdates {
  mode: Mode;
  staffName: string | null;
  /** Name of the staff member typing right now, if any. */
  typing: string | null;
  messages: Message[];
}

/** GET /api/admin/updates?since=<cursor> */
export interface AdminUpdates {
  staffOnline: number;
  /** Conversations changed since the cursor. */
  conversations: ConversationSummary[];
  /** Pass back as `since` on the next poll. */
  cursor: number;
}

/** What the visitor's poller turns updates into. */
export type VisitorEvent =
  | { type: "message"; message: Message }
  | { type: "mode"; mode: Mode; staffName: string | null }
  | { type: "typing"; staffName: string };

/** What the staff console's poller turns updates into. */
export type AdminEvent =
  | { type: "conversation"; summary: ConversationSummary }
  | { type: "message"; conversationId: string; message: Message }
  | { type: "presence"; staffOnline: number };

export const LIMITS = {
  maxChars: 1000,
  /** Most recent messages sent to the AI as context. */
  aiHistory: 30,
} as const;
