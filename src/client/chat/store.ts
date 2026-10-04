// Per-tab memory: which server conversation this tab owns, plus a local copy
// of the transcript so the chat renders instantly (and works with no server).
// sessionStorage, not localStorage, so a shared/kiosk computer doesn't keep
// someone's health questions after the tab closes.

import type { Message, NewConversation, Sender } from "../../shared/protocol.js";

const KEY = "glh-chat-v2";
const MAX_MESSAGES = 100;

interface Saved {
  session: NewConversation | null;
  messages: Message[];
}

export function load(): Saved {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Saved>;
      return { session: s.session ?? null, messages: Array.isArray(s.messages) ? s.messages : [] };
    }
  } catch {
    /* storage blocked or corrupt */
  }
  return { session: null, messages: [] };
}

export function save(state: Saved): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...state, messages: state.messages.slice(-MAX_MESSAGES) }));
  } catch {
    /* the chat still works, it just won't survive a refresh */
  }
}

export function clear(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function localMessage(from: Sender, text: string): Message {
  const id = globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, from, text, at: Date.now() };
}
