// Staff console: a full-screen overlay on the public site where signed-in staff
// see every visitor chat live, take one over, reply, and hand it back to the bot.

import type { AdminEvent, ConversationSummary, Message } from "../../shared/protocol.js";
import { writeRich } from "../chat/view.js";
import { api, ApiError } from "./api.js";
import { markStaffDevice } from "./secret.js";

type Filter = "all" | "attention";

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  children: Array<Node | string | null> = [],
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function needsAttention(c: ConversationSummary): boolean {
  return c.urgent || c.wantsHuman || c.unread > 0;
}

/** Two soft tones - enough to notice from across the front desk. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    [660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.14;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.3);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio unavailable */
  }
}

class StaffConsole {
  private readonly root = h("div", { id: "staff-root", className: "staff-overlay" });
  private me: string | null = null;
  private convos = new Map<string, ConversationSummary>();
  private selected: string | null = null;
  private thread: Message[] = [];
  private filter: Filter = "all";
  private live: EventSource | null = null;
  private staffOnline = 0;
  private lastTypingPing = 0;
  private readonly baseTitle = document.title;

  // Console elements, created once signed in.
  private listEl!: HTMLDivElement;
  private threadEl!: HTMLDivElement;
  private threadHead!: HTMLDivElement;
  private composer!: HTMLFormElement;
  private replyInput!: HTMLTextAreaElement;
  private presenceEl!: HTMLSpanElement;

  constructor() {
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Staff console");
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide();
    });
    document.body.append(this.root);
  }

  async show(): Promise<void> {
    this.root.classList.add("open");
    document.body.classList.add("staff-open");
    hidePill();
    if (await this.ensureSignedIn()) this.replyInput.focus();
    else this.renderLogin();
  }

  /** Resumes an existing session if the cookie is still valid. */
  async ensureSignedIn(): Promise<boolean> {
    if (this.me) return true;
    try {
      const who = await api.me();
      await this.start(who.name, who.staffOnline);
      return true;
    } catch {
      return false;
    }
  }

  hide(): void {
    this.root.classList.remove("open");
    document.body.classList.remove("staff-open");
    if (this.me) showPill();
  }

  // ---------- sign in ----------

  private renderLogin(error = ""): void {
    const name = h("input", { type: "text", placeholder: "Your name (shown to visitors)", autocomplete: "name", maxLength: 40, required: true });
    const pass = h("input", { type: "password", placeholder: "Staff password", autocomplete: "current-password", required: true });
    const err = h("p", { className: "staff-error", textContent: error });
    err.setAttribute("role", "alert");
    const submit = h("button", { type: "submit", className: "staff-btn primary", textContent: "Sign in" });
    const form = h("form", { className: "staff-login" }, [
      h("div", { className: "staff-login-badge", textContent: "+" }),
      h("h2", { textContent: "Staff sign-in" }),
      h("p", { className: "staff-sub", textContent: "Reply to patients chatting on the website." }),
      name, pass, err, submit,
      h("button", { type: "button", className: "staff-link", textContent: "Back to site", onclick: () => this.hide() }),
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = "";
      try {
        const r = await api.login(name.value.trim(), pass.value);
        // Ask while we still have a user gesture.
        if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
        markStaffDevice(true);
        await this.start(r.name, 0);
      } catch (ex) {
        const code = ex instanceof ApiError ? ex.code : "";
        err.textContent =
          code === "invalid_credentials" ? "That password isn't right."
          : code === "rate_limited" ? "Too many attempts. Wait a few minutes and try again."
          : code === "staff_login_disabled" ? "Staff sign-in isn't set up on this server (ADMIN_PASSWORD)."
          : "Couldn't sign in. Check your connection.";
        pass.value = "";
        pass.focus();
        submit.disabled = false;
      }
    });
    this.root.replaceChildren(h("div", { className: "staff-login-wrap" }, [form]));
    name.focus();
  }

  // ---------- console ----------

  private async start(name: string, staffOnline: number): Promise<void> {
    this.me = name;
    this.staffOnline = staffOnline;
    this.renderShell();
    const list = await api.list();
    this.convos = new Map(list.map((c) => [c.id, c]));
    this.renderList();
    this.connect();
  }

  private connect(): void {
    this.live?.close();
    this.live = api.live(
      (e) => this.onEvent(e),
      () => {
        // EventSource retries by itself; if the session expired, go back to sign-in.
        void api.me().catch(() => {
          this.live?.close();
          this.live = null;
          this.me = null;
          this.renderLogin("Your session ended. Please sign in again.");
        });
      },
    );
  }

  private renderShell(): void {
    this.presenceEl = h("span", { className: "staff-presence" });
    this.listEl = h("div", { className: "staff-list" });
    this.threadHead = h("div", { className: "staff-thread-head" });
    this.threadEl = h("div", { className: "staff-thread" });
    this.threadEl.setAttribute("aria-live", "polite");
    this.replyInput = h("textarea", { rows: 2, placeholder: "Type a reply... (Enter to send, Shift+Enter for a new line)", maxLength: 1000 });
    this.composer = h("form", { className: "staff-composer" }, [
      this.replyInput,
      h("button", { type: "submit", className: "staff-btn primary", textContent: "Send" }),
    ]);

    this.replyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.composer.requestSubmit();
      }
    });
    this.replyInput.addEventListener("input", () => this.pingTyping());
    this.composer.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.sendReply();
    });

    const filterBtn = (f: Filter, label: string) =>
      h("button", {
        type: "button",
        className: `staff-filter${this.filter === f ? " active" : ""}`,
        textContent: label,
        onclick: () => {
          this.filter = f;
          this.root.querySelectorAll(".staff-filter").forEach((b) => b.classList.toggle("active", b.textContent === label));
          this.renderList();
        },
      });

    this.root.replaceChildren(
      h("div", { className: "staff-shell" }, [
        h("header", { className: "staff-top" }, [
          h("div", { className: "staff-brand" }, [
            h("span", { className: "staff-cross", textContent: "+" }),
            h("div", {}, [h("strong", { textContent: "Staff console" }), this.presenceEl]),
          ]),
          h("div", { className: "staff-top-actions" }, [
            h("span", { className: "staff-me", textContent: `Signed in as ${this.me}` }),
            h("button", { type: "button", className: "staff-btn ghost", textContent: "Minimize", onclick: () => this.hide() }),
            h("button", { type: "button", className: "staff-btn ghost", textContent: "Sign out", onclick: () => void this.signOut() }),
          ]),
        ]),
        h("div", { className: "staff-body" }, [
          h("aside", { className: "staff-side" }, [
            h("div", { className: "staff-filters" }, [filterBtn("all", "All chats"), filterBtn("attention", "Needs reply")]),
            this.listEl,
          ]),
          h("section", { className: "staff-main" }, [this.threadHead, this.threadEl, this.composer]),
        ]),
      ]),
    );
    this.renderPresence();
    this.renderThread();
  }

  private renderPresence(): void {
    const n = this.staffOnline;
    this.presenceEl.textContent = `${n} staff online`;
  }

  private renderList(): void {
    const items = [...this.convos.values()]
      .filter((c) => c.messageCount > 0 && (this.filter === "all" || needsAttention(c)))
      .sort((a, b) => Number(b.urgent) - Number(a.urgent) || Number(b.wantsHuman) - Number(a.wantsHuman) || b.updatedAt - a.updatedAt);

    if (items.length === 0) {
      this.listEl.replaceChildren(
        h("p", { className: "staff-empty", textContent: this.filter === "all" ? "No chats yet. New conversations appear here live." : "Nothing needs a reply right now." }),
      );
    } else {
      this.listEl.replaceChildren(...items.map((c) => this.listItem(c)));
    }
    this.updateTitle();
  }

  private listItem(c: ConversationSummary): HTMLButtonElement {
    const tags: HTMLElement[] = [];
    if (c.urgent) tags.push(h("span", { className: "tag urgent", textContent: "Urgent" }));
    if (c.wantsHuman) tags.push(h("span", { className: "tag wants", textContent: "Wants a person" }));
    if (c.mode === "human") tags.push(h("span", { className: "tag live", textContent: `With ${c.staffName ?? "staff"}` }));
    else tags.push(h("span", { className: "tag bot", textContent: "Bot" }));

    const who = c.last?.from === "visitor" ? "" : c.last?.from === "staff" ? "You: " : c.last?.from === "bot" ? "Bot: " : "";
    const btn = h("button", { type: "button", className: `staff-item${c.id === this.selected ? " selected" : ""}` }, [
      h("div", { className: "staff-item-top" }, [
        h("strong", { textContent: `Visitor ${c.id.slice(0, 4).toUpperCase()}` }),
        h("span", { className: "staff-time", textContent: timeAgo(c.updatedAt) }),
      ]),
      h("div", { className: "staff-preview", textContent: `${who}${c.last?.text ?? ""}` }),
      h("div", { className: "staff-tags" }, [...tags, c.unread > 0 ? h("span", { className: "staff-unread", textContent: String(c.unread) }) : null]),
    ]);
    btn.addEventListener("click", () => void this.select(c.id));
    return btn;
  }

  private async select(id: string): Promise<void> {
    this.selected = id;
    this.renderList();
    this.root.querySelector(".staff-body")?.classList.add("thread-open");
    try {
      const full = await api.get(id);
      if (this.selected !== id) return;
      this.thread = full.messages;
      this.convos.set(id, { ...full, unread: 0 });
      this.renderThread();
      if (full.unread > 0) void api.read(id);
      this.replyInput.focus();
    } catch {
      this.threadEl.replaceChildren(h("p", { className: "staff-empty", textContent: "Couldn't load this chat." }));
    }
  }

  private renderThread(): void {
    const c = this.selected ? this.convos.get(this.selected) : undefined;
    this.composer.hidden = !c;
    if (!c) {
      this.threadHead.replaceChildren();
      this.threadEl.replaceChildren(
        h("div", { className: "staff-placeholder" }, [
          h("strong", { textContent: "Pick a chat on the left" }),
          h("p", { textContent: "Replying takes the chat over from the bot. The visitor sees your name and your replies appear instantly on their screen." }),
        ]),
      );
      return;
    }
    this.renderThreadHead(c);
    this.threadEl.replaceChildren(...this.thread.map((m) => this.threadMessage(m)));
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private renderThreadHead(c: ConversationSummary): void {
    const action =
      c.mode === "human"
        ? h("button", { type: "button", className: "staff-btn ghost dark", textContent: "Hand back to bot", onclick: () => void api.release(c.id) })
        : h("button", { type: "button", className: "staff-btn primary", textContent: "Take over", onclick: () => void api.takeover(c.id) });
    const status =
      c.mode === "human" ? `${c.staffName ?? "Staff"} is handling this chat` : "The virtual assistant is answering";
    this.threadHead.replaceChildren(
      h("button", {
        type: "button",
        className: "staff-back",
        textContent: "< Chats",
        onclick: () => this.root.querySelector(".staff-body")?.classList.remove("thread-open"),
      }),
      h("div", { className: "staff-thread-title" }, [
        h("strong", { textContent: `Visitor ${c.id.slice(0, 4).toUpperCase()}` }),
        h("span", { textContent: `${status} - started ${timeAgo(c.createdAt)}` }),
      ]),
      action,
    );
  }

  private threadMessage(m: Message): HTMLElement {
    if (m.from === "system") return h("div", { className: "staff-sys", textContent: m.text });
    const label = m.from === "visitor" ? "Visitor" : m.from === "bot" ? "Virtual assistant" : (m.staffName ?? "Staff");
    const body = h("div", { className: "staff-msg-body" });
    writeRich(body, m.text);
    return h("div", { className: `staff-msg from-${m.from}` }, [
      h("div", { className: "staff-msg-meta", textContent: `${label} - ${clock(m.at)}` }),
      body,
    ]);
  }

  private async sendReply(): Promise<void> {
    const id = this.selected;
    const text = this.replyInput.value.trim();
    if (!id || !text) return;
    this.replyInput.value = "";
    try {
      await api.reply(id, text);
    } catch {
      this.replyInput.value = text;
      this.threadEl.append(h("div", { className: "staff-sys error", textContent: "Message not sent - check your connection and try again." }));
    }
    this.replyInput.focus();
  }

  private pingTyping(): void {
    const now = Date.now();
    if (!this.selected || now - this.lastTypingPing < 2500) return;
    this.lastTypingPing = now;
    void api.typing(this.selected).catch(() => {});
  }

  private onEvent(e: AdminEvent): void {
    switch (e.type) {
      case "presence":
        this.staffOnline = e.staffOnline;
        this.renderPresence();
        break;
      case "conversation": {
        const isNew = !this.convos.has(e.summary.id);
        // The open chat is being read right now, so it has no unread messages.
        const viewing = e.summary.id === this.selected && this.isVisible();
        this.convos.set(e.summary.id, viewing ? { ...e.summary, unread: 0 } : e.summary);
        if (viewing && e.summary.unread > 0) void api.read(e.summary.id);
        this.renderList();
        if (e.summary.id === this.selected) this.renderThreadHead(this.convos.get(e.summary.id)!);
        if (isNew) pulsePill();
        break;
      }
      case "message":
        if (e.conversationId === this.selected && !this.thread.some((m) => m.id === e.message.id)) {
          this.thread.push(e.message);
          this.threadEl.append(this.threadMessage(e.message));
          this.threadEl.scrollTop = this.threadEl.scrollHeight;
        }
        if (e.message.from === "visitor") this.alertNewMessage(e.conversationId, e.message);
        break;
    }
  }

  private alertNewMessage(conversationId: string, m: Message): void {
    const watching = conversationId === this.selected && this.isVisible() && document.hasFocus();
    if (watching) return;
    chime();
    pulsePill();
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      const n = new Notification("New message on the website chat", { body: m.text.slice(0, 120), tag: conversationId });
      n.onclick = () => {
        window.focus();
        void this.show().then(() => this.select(conversationId));
      };
    }
  }

  private isVisible(): boolean {
    return this.root.classList.contains("open") && !document.hidden;
  }

  private updateTitle(): void {
    const unread = [...this.convos.values()].reduce((n, c) => n + c.unread, 0);
    document.title = unread > 0 ? `(${unread}) ${this.baseTitle}` : this.baseTitle;
    const pill = document.getElementById("staff-pill");
    if (pill) pill.dataset.count = unread > 0 ? String(unread) : "";
  }

  private async signOut(): Promise<void> {
    await api.logout().catch(() => {});
    markStaffDevice(false);
    this.live?.close();
    this.live = null;
    this.me = null;
    this.selected = null;
    this.thread = [];
    this.convos.clear();
    document.title = this.baseTitle;
    this.renderLogin();
    this.hide();
  }
}

// ---------- floating pill for signed-in staff ----------

function pill(): HTMLButtonElement {
  let el = document.getElementById("staff-pill") as HTMLButtonElement | null;
  if (!el) {
    el = h("button", { id: "staff-pill", type: "button", textContent: "Staff console" });
    el.addEventListener("click", () => openStaffConsole());
    document.body.append(el);
  }
  return el;
}
function showPill(): void {
  pill().hidden = false;
}
function hidePill(): void {
  const el = document.getElementById("staff-pill");
  if (el) el.hidden = true;
}
function pulsePill(): void {
  const el = document.getElementById("staff-pill");
  if (!el || el.hidden) return;
  el.classList.remove("pulse-once");
  void el.offsetWidth;
  el.classList.add("pulse-once");
}

let instance: StaffConsole | null = null;

export function openStaffConsole(): void {
  instance ??= new StaffConsole();
  void instance.show();
}

/** On a device that signed in before: show the pill and keep listening, without opening. */
export async function showPillIfSignedIn(): Promise<void> {
  instance ??= new StaffConsole();
  if (await instance.ensureSignedIn()) showPill();
}
