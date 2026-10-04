// Staff console API. Every route except login requires a staff session.

import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS, type AdminUpdates } from "../shared/protocol.js";
import {
  checkPassword, clearedCookie, createSession, sessionCookie, staffFor, staffLoginEnabled,
} from "./auth.js";
import { HttpError, clientIp, json, readJson, str } from "./http.js";
import { RateLimiter } from "./rate-limit.js";
import { addMessage, publicConversation, type ConversationStore, type Stored } from "./store.js";

const loginLimiter = new RateLimiter({ windowMs: 15 * 60_000, max: 8 });
const secureCookies = process.env.NODE_ENV === "production" || !!process.env.VERCEL;

export function adminRoutes(store: ConversationStore) {
  function requireStaff(req: IncomingMessage) {
    const s = staffFor(req);
    if (!s) throw new HttpError(401, "unauthorized");
    return s;
  }
  async function conversation(id: string) {
    const c = await store.get(id);
    if (!c) throw new HttpError(404, "not_found");
    return c;
  }
  /** Staff join: the bot goes quiet and the visitor sees who joined. */
  function join(c: Stored, name: string): void {
    c.mode = "human";
    c.staffName = name;
    c.wantsHuman = false;
    addMessage(c, "system", `${name} from Grace Life Hospital joined the chat.`);
  }

  return {
    async login(req: IncomingMessage, res: ServerResponse) {
      if (!staffLoginEnabled()) throw new HttpError(503, "staff_login_disabled");
      if (!loginLimiter.take(clientIp(req))) throw new HttpError(429, "rate_limited");
      const body = (await readJson(req)) as { name?: unknown; password?: unknown };
      const name = str(body.name, 40) ?? "Staff";
      const password = typeof body.password === "string" ? body.password : "";
      if (!checkPassword(password)) throw new HttpError(401, "invalid_credentials");
      await store.db.touchStaff(name);
      json(res, 200, { name }, { "Set-Cookie": sessionCookie(createSession(name), secureCookies) });
    },

    logout(_req: IncomingMessage, res: ServerResponse) {
      json(res, 200, { ok: true }, { "Set-Cookie": clearedCookie() });
    },

    async me(req: IncomingMessage, res: ServerResponse) {
      const staff = requireStaff(req);
      await store.db.touchStaff(staff.name);
      json(res, 200, { name: staff.name, staffOnline: await store.db.staffOnline() });
    },

    async list(req: IncomingMessage, res: ServerResponse) {
      requireStaff(req);
      json(res, 200, await store.list());
    },

    /** Polled by the console: changed conversations + who's online. */
    async updates(req: IncomingMessage, res: ServerResponse, since: number) {
      const staff = requireStaff(req);
      await store.db.touchStaff(staff.name);
      const conversations = await store.list(since);
      const body: AdminUpdates = {
        staffOnline: await store.db.staffOnline(),
        conversations,
        cursor: conversations.reduce((m, c) => Math.max(m, c.updatedAt), since),
      };
      json(res, 200, body);
    },

    async get(req: IncomingMessage, res: ServerResponse, id: string) {
      requireStaff(req);
      json(res, 200, publicConversation(await conversation(id)));
    },

    /** Staff reply. The first reply takes the chat over from the bot. */
    async reply(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const body = (await readJson(req)) as { text?: unknown };
      const text = str(body.text, LIMITS.maxChars);
      if (!text) throw new HttpError(400, "bad_request");
      const c = await conversation(id);
      if (c.mode !== "human" || c.staffName !== staff.name) join(c, staff.name);
      const message = addMessage(c, "staff", text, staff.name);
      c.unread = 0;
      await store.db.putConv(c);
      await store.db.clearTyping(id);
      json(res, 201, message);
    },

    /** Take over without saying anything yet. */
    async takeover(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const c = await conversation(id);
      if (c.mode !== "human" || c.staffName !== staff.name) {
        join(c, staff.name);
        await store.db.putConv(c);
      }
      json(res, 200, { ok: true });
    },

    /** Hand the chat back to the bot. */
    async release(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      const c = await conversation(id);
      if (c.mode === "human") {
        c.mode = "bot";
        c.staffName = null;
        addMessage(c, "system", `${staff.name} left the chat. The virtual assistant is back.`);
        await store.db.putConv(c);
      }
      json(res, 200, { ok: true });
    },

    async read(req: IncomingMessage, res: ServerResponse, id: string) {
      requireStaff(req);
      const c = await conversation(id);
      if (c.unread > 0) await store.update(c, { unread: 0 });
      json(res, 200, { ok: true });
    },

    async typing(req: IncomingMessage, res: ServerResponse, id: string) {
      const staff = requireStaff(req);
      await store.db.setTyping(id, staff.name);
      json(res, 200, { ok: true });
    },
  };
}
