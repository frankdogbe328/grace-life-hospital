// Visitor-facing chat API. A visitor proves ownership of a conversation with
// the random token handed out when it was created.

import type { IncomingMessage, ServerResponse } from "node:http";
import { HOSPITAL } from "../shared/hospital.js";
import { LIMITS, type ReplyEvent, type VisitorEvent } from "../shared/protocol.js";
import { offlineAnswer, topicOf } from "../shared/topics.js";
import { assessUrgency } from "../shared/triage.js";
import { askAi, toAiHistory } from "./assistant.js";
import { HttpError, clientIp, json, openSse, readJson, str } from "./http.js";
import { addVisitor, staffOnline } from "./live.js";
import { RateLimiter } from "./rate-limit.js";
import { publicConversation, type ConversationStore } from "./store.js";

const messageLimiter = new RateLimiter({ windowMs: 60_000, max: 15 });
const createLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

export function visitorRoutes(store: ConversationStore) {
  function authorized(req: IncomingMessage, id: string, tokenFromQuery?: string | null) {
    const token = tokenFromQuery ?? req.headers["x-conversation-token"];
    const c = typeof token === "string" ? store.authorize(id, token) : null;
    if (!c) throw new HttpError(404, "not_found");
    return c;
  }

  return {
    /** POST /api/conversations */
    create(req: IncomingMessage, res: ServerResponse) {
      if (!createLimiter.take(clientIp(req))) throw new HttpError(429, "rate_limited");
      const c = store.create();
      json(res, 201, { id: c.id, token: c.token });
    },

    /** GET /api/conversations/:id - transcript, so a refreshed tab can catch up. */
    get(req: IncomingMessage, res: ServerResponse, id: string) {
      json(res, 200, publicConversation(authorized(req, id)));
    },

    /** POST /api/conversations/:id/messages - the visitor says something. */
    async message(req: IncomingMessage, res: ServerResponse, id: string) {
      const c = authorized(req, id);
      const body = (await readJson(req)) as { text?: unknown };
      const text = str(body.text, LIMITS.maxChars);
      if (!text) throw new HttpError(400, "bad_request");

      const sse = openSse<ReplyEvent>(req, res);
      if (!messageLimiter.take(clientIp(req))) {
        sse.send({ type: "error", code: "rate_limited" });
        return sse.close();
      }

      const urgency = assessUrgency(text);
      const asksForHuman = topicOf(text) === "human";
      store.append(c, "visitor", text);
      if (urgency && !c.urgent) store.update(c, { urgent: true });
      if (asksForHuman && !c.wantsHuman && c.mode === "bot") store.update(c, { wantsHuman: true });

      // Staff are handling this chat: deliver to them, no bot reply.
      if (c.mode === "human") {
        sse.send({ type: "queued" });
        return sse.close();
      }

      const reply = (text: string, source: "ai" | "offline") => {
        store.append(c, "bot", text);
        sse.send({ type: "done", source });
        sse.close();
      };

      if (asksForHuman) {
        const msg =
          staffOnline() > 0
            ? "I've let our team know - a staff member will join this chat shortly. Please keep this window open."
            : `Our team isn't online in the chat right now, but they've been notified and can read this conversation. For a faster answer call ${HOSPITAL.phoneDisplay} or email ${HOSPITAL.email}.`;
        sse.send({ type: "delta", text: msg });
        return reply(msg, "offline");
      }

      const abort = new AbortController();
      res.on("close", () => abort.abort());
      let streamed = "";
      const ok = await askAi(
        toAiHistory(c.messages),
        (delta) => {
          streamed += delta;
          sse.send({ type: "delta", text: delta });
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;

      if (ok) return reply(streamed, "ai");
      if (streamed) return reply(`${streamed.trimEnd()}...`, "ai");

      const local = offlineAnswer(text, urgency).text;
      sse.send({ type: "delta", text: local });
      reply(local, "offline");
    },

    /** GET /api/conversations/:id/live?token=... - staff replies pushed to the visitor. */
    live(req: IncomingMessage, res: ServerResponse, id: string, token: string | null) {
      const c = authorized(req, id, token ?? "");
      const ch = openSse<VisitorEvent>(req, res);
      ch.send({ type: "mode", mode: c.mode, staffName: c.staffName });
      const off = addVisitor(id, ch);
      req.on("close", off);
    },
  };
}
