// Visitor-facing chat API. A visitor proves ownership of a conversation with
// the random token handed out when it was created.

import type { IncomingMessage, ServerResponse } from "node:http";
import { HOSPITAL } from "../shared/hospital.js";
import { LIMITS, type ReplyEvent, type VisitorUpdates } from "../shared/protocol.js";
import { offlineAnswer, topicOf } from "../shared/topics.js";
import { assessUrgency } from "../shared/triage.js";
import { askAi, toAiHistory } from "./assistant.js";
import { HttpError, clientIp, json, openSse, readJson, str } from "./http.js";
import { RateLimiter } from "./rate-limit.js";
import { addMessage, publicConversation, type ConversationStore } from "./store.js";

// Per instance only; on a serverless host this is a speed bump, not a wall.
const messageLimiter = new RateLimiter({ windowMs: 60_000, max: 15 });
const createLimiter = new RateLimiter({ windowMs: 60_000, max: 10 });

export function visitorRoutes(store: ConversationStore) {
  async function authorized(req: IncomingMessage, id: string, tokenFromQuery?: string | null) {
    const token = tokenFromQuery ?? req.headers["x-conversation-token"];
    const c = typeof token === "string" ? await store.authorize(id, token) : null;
    if (!c) throw new HttpError(404, "not_found");
    return c;
  }

  return {
    /** POST /api/conversations */
    async create(req: IncomingMessage, res: ServerResponse) {
      if (!createLimiter.take(clientIp(req))) throw new HttpError(429, "rate_limited");
      const c = await store.create();
      json(res, 201, { id: c.id, token: c.token });
    },

    /** GET /api/conversations/:id - transcript, so a refreshed tab can catch up. */
    async get(req: IncomingMessage, res: ServerResponse, id: string) {
      json(res, 200, publicConversation(await authorized(req, id)));
    },

    /** GET /api/conversations/:id/updates?since= - polled for staff replies. */
    async updates(req: IncomingMessage, res: ServerResponse, id: string, since: number) {
      const c = await authorized(req, id);
      const body: VisitorUpdates = {
        mode: c.mode,
        staffName: c.staffName,
        typing: await store.db.getTyping(id),
        messages: c.messages.filter((m) => m.at > since),
      };
      json(res, 200, body);
    },

    /** POST /api/conversations/:id/messages - the visitor says something. */
    async message(req: IncomingMessage, res: ServerResponse, id: string) {
      const body = (await readJson(req)) as { text?: unknown };
      const text = str(body.text, LIMITS.maxChars);
      if (!text) throw new HttpError(400, "bad_request");
      const c = await authorized(req, id);

      const sse = openSse<ReplyEvent>(req, res);
      if (!messageLimiter.take(clientIp(req))) {
        sse.send({ type: "error", code: "rate_limited" });
        return sse.close();
      }

      const urgency = assessUrgency(text);
      const asksForHuman = topicOf(text) === "human";
      addMessage(c, "visitor", text);
      if (urgency) c.urgent = true;
      if (asksForHuman && c.mode === "bot") c.wantsHuman = true;
      await store.db.putConv(c);

      // Staff are handling this chat: deliver to them, no bot reply.
      if (c.mode === "human") {
        sse.send({ type: "queued" });
        return sse.close();
      }

      const reply = async (text: string, source: "ai" | "offline") => {
        // Re-read: staff may have joined while the bot was answering.
        const fresh = (await store.get(c.id)) ?? c;
        await store.append(fresh, "bot", text);
        sse.send({ type: "done", source });
        sse.close();
      };

      if (asksForHuman) {
        const msg =
          (await store.db.staffOnline()) > 0
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
      return reply(local, "offline");
    },
  };
}
