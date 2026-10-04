// Storage backends. Locally: memory, flushed to data/conversations.json.
// On Vercel (no shared memory between function instances, read-only disk):
// Upstash Redis over its REST API, picked automatically when its env vars exist.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Conversation } from "../shared/protocol.js";

export interface Stored extends Conversation {
  token: string;
}

export interface Backend {
  readonly name: string;
  getConv(id: string): Promise<Stored | null>;
  putConv(c: Stored): Promise<void>;
  /** Conversations updated after `since`, newest first. */
  listConvs(since: number, limit: number): Promise<Stored[]>;
  setTyping(conversationId: string, staffName: string): Promise<void>;
  getTyping(conversationId: string): Promise<string | null>;
  clearTyping(conversationId: string): Promise<void>;
  /** Marks a staff member as online for a short while. */
  touchStaff(name: string): Promise<void>;
  staffOnline(): Promise<number>;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TYPING_MS = 4000;
const STAFF_ONLINE_MS = 15_000;

export function createBackend(localFile: string): Backend {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisBackend(url, token);
  if (process.env.VERCEL) {
    console.warn("[db] No Redis configured on Vercel - chats will not be shared between requests. Add Upstash Redis.");
  }
  return new MemoryBackend(process.env.VERCEL ? null : localFile);
}

// ---------- memory (local dev, single process) ----------

class MemoryBackend implements Backend {
  readonly name = "memory";
  private readonly convos = new Map<string, Stored>();
  private readonly typing = new Map<string, { name: string; until: number }>();
  private readonly staff = new Map<string, number>();
  private loaded: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string | null) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.file) return;
      try {
        const list = JSON.parse(await readFile(this.file, "utf8")) as Stored[];
        const cutoff = Date.now() - MAX_AGE_MS;
        for (const c of list) if (c.updatedAt >= cutoff) this.convos.set(c.id, c);
      } catch {
        // First run or unreadable file: start empty.
      }
    })();
    return this.loaded;
  }

  async getConv(id: string) {
    await this.load();
    const c = this.convos.get(id);
    return c ? structuredClone(c) : null;
  }

  async putConv(c: Stored) {
    await this.load();
    this.convos.set(c.id, structuredClone(c));
    if (this.convos.size > 1000) {
      const oldest = [...this.convos.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]!;
      this.convos.delete(oldest.id);
    }
    this.scheduleFlush();
  }

  async listConvs(since: number, limit: number) {
    await this.load();
    return [...this.convos.values()]
      .filter((c) => c.updatedAt > since)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  async setTyping(id: string, name: string) {
    this.typing.set(id, { name, until: Date.now() + TYPING_MS });
  }

  async clearTyping(id: string) {
    this.typing.delete(id);
  }

  async getTyping(id: string) {
    const t = this.typing.get(id);
    return t && t.until > Date.now() ? t.name : null;
  }

  async touchStaff(name: string) {
    this.staff.set(name, Date.now());
  }

  async staffOnline() {
    const cutoff = Date.now() - STAFF_ONLINE_MS;
    return [...this.staff.values()].filter((t) => t > cutoff).length;
  }

  private scheduleFlush(): void {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 500);
  }

  async flush(): Promise<void> {
    if (!this.file) return;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.convos.values()]));
      await rename(tmp, this.file);
    } catch (err) {
      console.error("[db] could not save conversations", err);
    }
  }
}

// ---------- Upstash Redis (Vercel) ----------

type Cmd = Array<string | number>;

class RedisBackend implements Backend {
  readonly name = "redis";
  private readonly base: string;

  constructor(url: string, private readonly token: string) {
    this.base = url.replace(/\/+$/, "");
  }

  private async pipeline(cmds: Cmd[]): Promise<unknown[]> {
    const r = await fetch(`${this.base}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds.map((cmd) => cmd.map(String))),
    });
    if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
    const out = (await r.json()) as Array<{ result?: unknown; error?: string }>;
    return out.map((x) => {
      if (x.error) throw new Error(`redis: ${x.error}`);
      return x.result;
    });
  }

  private async one(cmd: Cmd): Promise<unknown> {
    return (await this.pipeline([cmd]))[0];
  }

  async getConv(id: string) {
    const raw = await this.one(["GET", `glh:conv:${id}`]);
    return typeof raw === "string" ? (JSON.parse(raw) as Stored) : null;
  }

  async putConv(c: Stored) {
    const ttl = Math.ceil(MAX_AGE_MS / 1000);
    await this.pipeline([
      ["SET", `glh:conv:${c.id}`, JSON.stringify(c), "EX", ttl],
      ["ZADD", "glh:convs", c.updatedAt, c.id],
      ["ZREMRANGEBYSCORE", "glh:convs", "-inf", Date.now() - MAX_AGE_MS],
    ]);
  }

  async listConvs(since: number, limit: number) {
    const ids = (await this.one(["ZREVRANGEBYSCORE", "glh:convs", "+inf", `(${since}`, "LIMIT", 0, limit])) as string[];
    if (!ids.length) return [];
    const raws = (await this.one(["MGET", ...ids.map((id) => `glh:conv:${id}`)])) as Array<string | null>;
    return raws.flatMap((r) => (r ? [JSON.parse(r) as Stored] : []));
  }

  async setTyping(id: string, name: string) {
    await this.one(["SET", `glh:typing:${id}`, name, "PX", TYPING_MS]);
  }

  async clearTyping(id: string) {
    await this.one(["DEL", `glh:typing:${id}`]);
  }

  async getTyping(id: string) {
    const v = await this.one(["GET", `glh:typing:${id}`]);
    return typeof v === "string" ? v : null;
  }

  async touchStaff(name: string) {
    const now = Date.now();
    await this.pipeline([
      ["ZADD", "glh:staff", now, name],
      ["ZREMRANGEBYSCORE", "glh:staff", "-inf", now - STAFF_ONLINE_MS],
    ]);
  }

  async staffOnline() {
    return Number(await this.one(["ZCOUNT", "glh:staff", Date.now() - STAFF_ONLINE_MS, "+inf"])) || 0;
  }
}

export async function flushBackend(b: Backend): Promise<void> {
  if (b instanceof MemoryBackend) await b.flush();
}
