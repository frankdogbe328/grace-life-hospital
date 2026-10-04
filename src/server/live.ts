// Fan-out of live events: each visitor's open chat tab, and every staff console.

import type { AdminEvent, VisitorEvent } from "../shared/protocol.js";
import type { Sse } from "./http.js";

const visitors = new Map<string, Set<Sse<VisitorEvent>>>();
const staff = new Set<Sse<AdminEvent>>();

export function addVisitor(conversationId: string, ch: Sse<VisitorEvent>): () => void {
  let set = visitors.get(conversationId);
  if (!set) visitors.set(conversationId, (set = new Set()));
  set.add(ch);
  return () => {
    set.delete(ch);
    if (set.size === 0) visitors.delete(conversationId);
  };
}

export function toVisitor(conversationId: string, event: VisitorEvent): void {
  for (const ch of visitors.get(conversationId) ?? []) ch.send(event);
}

export function addStaff(ch: Sse<AdminEvent>): () => void {
  staff.add(ch);
  broadcastPresence();
  return () => {
    staff.delete(ch);
    broadcastPresence();
  };
}

export function toStaff(event: AdminEvent): void {
  for (const ch of staff) ch.send(event);
}

export function staffOnline(): number {
  return staff.size;
}

function broadcastPresence(): void {
  toStaff({ type: "presence", staffOnline: staff.size });
}
