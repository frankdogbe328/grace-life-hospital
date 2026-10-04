// Staff console API. Every route except login requires a staff session.

import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS, type AdminEvent } from "../shared/protocol.js";
import {
  checkPassword, clearedCookie, createSession, destroySession, sessionCookie, staffFor, staffLoginEnabled,
} from "./auth.js";
import { HttpError, clientIp, json, openSse, readJson, str } from "./http.js";
import { addStaff, staffOnline, toVisitor } from "./live.js";
import { RateLimiter } from "./rate-limit.js";
import { publicConversation, type ConversationStore } from "./store.js";

const loginLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 8 });
const secureCookies = process.env.NODE_ENV === "production";

export function adminRoutes(store: ConversationStore) {
  function requireStaff(req: IncomingMessage) {
    const s = staffFor(req);
    if (!s) throw new HttpError(401, "unauthorized");
    return s;
  }
  function conversation(id: string) {
    const c = store.get(id);
    if (!c) throw new HttpError(404, "not_found");
    return c;
  }

  return {
    async login(req: IncomingMessage, res: ServerResponse) {
      if (!staffLoginEnabled()) throw new HttpError(503, "staff_login_disabled");
      if (!loginLimiter.take(clientIp(req))) throw new HttpError(429, "rate_limited");
      const body = (await readJson(req)) as { name?: unknown; password?: unknown };
      const name = str(body.name, 40) ?? "Staff";
      const password = typeof body.password === "string" ? body.password : "";
      if (!checkPassword(password)) throw new HttpError(401, "invalid_credentials");
      const token = createSession(name);
      json(res, 200, { name }, { "Set-Cookie": sessionCookie(token, secureCookies) });
    },

    logout(req: IncomingMessage, res: ServerResponse) {
      destroySession(req);
      json(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
    },

    me(req: IncomingMessage, res: ServerResponse) {
      json(res, 200, { name: requireStaff(req).name, staffOnline: staffOnline() });
    },

    list(req: IncomingMessage, res: ServerResponse) {
      requireStaff(req);
      json(res, 200, store.list());
    },

    get(req: IncomingMessage, res: ServerResponse, id: string) {
      requireStaff(req);
      json(res, 200, publicConversation(conversation(id)));
    },

    /** Staff reply. The first reply takes the chat over from the bot. */
    async reply(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const c = conversation(id);
      const body = (await readJson(req)) as { text?: unknown };
      const text = str(body.text, LIMITS.maxChars);
      if (!text) throw new HttpError(400, "bad_request");

      if (c.mode !== "human" || c.staffName !== staff.name) join(c, staff.name);
      const message = store.append(c, "staff", text, staff.name);
      store.update(c, { unread: 0 });
      toVisitor(c.id, { type: "message", message });
      json(res, 201, message);
    },

    /** Take over without saying anything yet. */
    takeover(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const c = conversation(id);
      if (c.mode !== "human" || c.staffName !== staff.name) join(c, staff.name);
      json(res, 200, { ok: true });
    },

    /** Hand the chat back to the bot. */
    release(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const c = conversation(id);
      if (c.mode === "human") {
        store.setMode(c, "bot", null);
        const note = store.append(c, "system", `${staff.name} left the chat. The virtual assistant is back.`);
        toVisitor(c.id, { type: "message", message: note });
        toVisitor(c.id, { type: "mode", mode: "bot", staffName: null });
      }
      json(res, 200, { ok: true });
    },

    read(req: IncomingMessage, res: ServerResponse, id: string) {
      requireStaff(req);
      store.update(conversation(id), { unread: 0 });
      json(res, 200, { ok: true });
    },

    typing(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      toVisitor(conversation(id).id, { type: "typing", staffName: staff.name });
      json(res, 200, { ok: true });
    },

    live(req: IncomingMessage, res: ServerResponse) {
      requireStaff(req);
      const ch = openSse<AdminEvent>(req, res);
      const unsubscribe = store.subscribe((e) => {
        if (e.type === "message") {
          ch.send({ type: "message", conversationId: e.conversation.id, message: e.message });
        } else {
          const { messages: _m, ...summary } = publicConversation(e.conversation);
          ch.send({ type: "conversation", summary });
        }
      });
      const leave = addStaff(ch);
      req.on("close", () => {
        unsubscribe();
        leave();
      });
    },
  };

  function join(c: ReturnType<typeof conversation>, name: string): void {
    store.setMode(c, "human", name);
    const note = store.append(c, "system", `${name} from Grace Life Hospital joined the chat.`);
    toVisitor(c.id, { type: "message", message: note });
    toVisitor(c.id, { type: "mode", mode: "human", staffName: name });
  }
}
