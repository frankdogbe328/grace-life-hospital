// DOM rendering for the chat window. Everything user- or model-generated goes
// in through textContent; links are built as elements, never via innerHTML.

import { HOSPITAL } from "../../shared/hospital.js";
import type { Urgency } from "../../shared/triage.js";
import type { Message } from "../../shared/protocol.js";
import type { Suggestion } from "../../shared/topics.js";

export function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from page`);
  return el as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Phone numbers, emails and the 911/988 lines become tappable.
const LINK_RE = new RegExp(
  [
    escapeRe(HOSPITAL.phoneDisplay),
    "[\\w.+-]+@[\\w-]+\\.[\\w.]+[a-z]",
    "\\b911\\b",
    "\\b988\\b",
  ].join("|"),
  "gi",
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hrefFor(match: string): string {
  if (match === HOSPITAL.phoneDisplay) return `tel:${HOSPITAL.phoneTel}`;
  if (match.includes("@")) return `mailto:${match}`;
  return `tel:${match}`;
}

/** Fills `target` with text, turning contact details into links. */
export function writeRich(target: HTMLElement, text: string): void {
  target.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const i = m.index;
    if (i > last) target.append(text.slice(last, i));
    target.append(el("a", { href: hrefFor(m[0]), textContent: m[0] }));
    last = i + m[0].length;
  }
  if (last < text.length) target.append(text.slice(last));
}

export class ChatView {
  readonly box = $<HTMLDivElement>("msgs");
  readonly chips = $<HTMLDivElement>("qrs");
  readonly input = $<HTMLInputElement>("chat-input");
  readonly sendBtn = $<HTMLButtonElement>("send-btn");
  readonly toggleBtn = $<HTMLButtonElement>("chat-btn");
  readonly win = $<HTMLDivElement>("chat-win");
  readonly mode = $<HTMLDivElement>("chat-mode");
  readonly clinic = $<HTMLDivElement>("chat-clinic");
  readonly resetBtn = $<HTMLButtonElement>("chat-reset");

  bubble(role: "user" | "assistant", text = ""): HTMLDivElement {
    const d = el("div", { className: `msg ${role === "user" ? "usr" : "bot"}` });
    if (role === "user") d.textContent = text;
    else writeRich(d, text);
    this.append(d);
    return d;
  }

  /** Renders any stored message. */
  message(m: Message): void {
    switch (m.from) {
      case "visitor": this.bubble("user", m.text); break;
      case "bot": this.bubble("assistant", m.text); break;
      case "system": this.notice(m.text); break;
      case "staff": {
        const body = el("div");
        writeRich(body, m.text);
        this.append(el("div", { className: "msg staff" }, [
          el("span", { className: "staff-tag", textContent: `${m.staffName ?? "Staff"} - Grace Life team` }),
          body,
        ]));
        break;
      }
    }
  }

  /** "Name is typing..." for staff; auto-hides unless refreshed. */
  staffTyping(name: string): void {
    this.staffTypingEl?.remove();
    const d = this.typing();
    d.classList.add("staff-typing");
    d.prepend(el("em", { textContent: `${name} is typing` }));
    this.staffTypingEl = d;
    clearTimeout(this.staffTypingTimer);
    this.staffTypingTimer = setTimeout(() => this.clearStaffTyping(), 4000);
  }

  clearStaffTyping(): void {
    this.staffTypingEl?.remove();
    this.staffTypingEl = null;
  }

  private staffTypingEl: HTMLDivElement | null = null;
  private staffTypingTimer: ReturnType<typeof setTimeout> | undefined;

  private append(node: HTMLElement): void {
    // Keep a staff typing indicator pinned to the bottom.
    if (this.staffTypingEl?.isConnected) this.box.insertBefore(node, this.staffTypingEl);
    else this.box.append(node);
    this.scroll();
  }

  notice(text: string): void {
    this.append(el("div", { className: "chat-notice", textContent: text }));
  }

  typing(): HTMLDivElement {
    const d = el("div", { className: "typing-ind" }, [el("span"), el("span"), el("span")]);
    d.setAttribute("aria-label", "Assistant is typing");
    this.box.append(d);
    this.scroll();
    return d;
  }

  alert(urgency: Exclude<Urgency, null>): void {
    const call = (href: string, label: string, primary = false) =>
      el("a", { href, className: `alert-btn${primary ? " primary" : ""}`, textContent: label });

    const card =
      urgency === "crisis"
        ? el("div", { className: "alert-card crisis" }, [
            el("strong", { textContent: "You don't have to go through this alone." }),
            el("p", {
              textContent:
                "Please reach out now: call or text 988 (Suicide & Crisis Lifeline, free, 24/7). If you are in immediate danger, call 911.",
            }),
            el("div", { className: "alert-actions" }, [
              call("tel:988", "Call 988", true),
              call("sms:988", "Text 988"),
              call("tel:911", "Call 911"),
            ]),
          ])
        : el("div", { className: "alert-card" }, [
            el("strong", { textContent: "This may be a medical emergency." }),
            el("p", {
              textContent: "Don't wait for a chat reply. Call 911 now, or our 24/7 emergency line.",
            }),
            el("div", { className: "alert-actions" }, [
              call("tel:911", "Call 911", true),
              call(`tel:${HOSPITAL.phoneTel}`, `ER ${HOSPITAL.phoneDisplay}`),
            ]),
          ]);
    card.setAttribute("role", "alert");
    this.append(card);
  }

  setChips(items: Suggestion[], onPick: (s: Suggestion) => void): void {
    this.chips.replaceChildren(
      ...items.map((s) => {
        const b = el("button", { className: "qr", type: "button", textContent: s.label });
        b.addEventListener("click", () => onPick(s));
        return b;
      }),
    );
  }

  setBusy(busy: boolean): void {
    this.sendBtn.disabled = busy;
    this.chips.classList.toggle("is-busy", busy);
    this.box.setAttribute("aria-busy", String(busy));
  }

  setMode(mode: "ai" | "offline" | "staff", staffName?: string | null): void {
    this.mode.textContent =
      mode === "staff" ? `Chatting with ${staffName ?? "our team"}` : mode === "ai" ? "AI assistant - Online" : "Instant answers";
    this.mode.classList.toggle("offline", mode === "offline");
    this.mode.classList.toggle("staff", mode === "staff");
  }

  setOpen(open: boolean): void {
    this.toggleBtn.classList.toggle("open", open);
    this.toggleBtn.setAttribute("aria-expanded", String(open));
    this.toggleBtn.setAttribute("aria-label", open ? "Close chat" : "Chat with us");
    this.win.classList.toggle("open", open);
    this.win.setAttribute("aria-hidden", String(!open));
    this.win.inert = !open;
  }

  clear(): void {
    this.clearStaffTyping();
    this.box.replaceChildren();
  }

  scroll(): void {
    this.box.scrollTop = this.box.scrollHeight;
  }
}
