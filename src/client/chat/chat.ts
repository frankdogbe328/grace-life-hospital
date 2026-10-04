// Visitor chat flow:
//   message -> safety triage (instant alert card if urgent)
//           -> server: staff handling it? deliver to staff : stream a bot reply
//           -> server unreachable? answer from the offline topic engine
//   Staff replies arrive on a live channel and appear as they're sent.

import { outpatientStatus } from "../../shared/hospital.js";
import { LIMITS, type Message, type Mode, type NewConversation, type VisitorEvent } from "../../shared/protocol.js";
import { followUps, offlineAnswer, STARTER_CHIPS, type Suggestion } from "../../shared/topics.js";
import { assessUrgency } from "../../shared/triage.js";
import { ASK_EVENT } from "../page.js";
import * as store from "./store.js";
import { createConversation, fetchConversation, openLive, sendMessage } from "./transport.js";
import { ChatView, writeRich } from "./view.js";

function greeting(): string {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}! Welcome to Grace Life Hospital. I can help with appointments, services, doctors, hours and directions - or connect you with our team. How can I help?`;
}

export class Chat {
  private readonly view = new ChatView();
  private session: NewConversation | null;
  private messages: Message[];
  private mode: Mode = "bot";
  private staffName: string | null = null;
  private replySource: "ai" | "offline" = "ai";
  private live: EventSource | null = null;
  private busy = false;
  private isOpen = false;
  private inflight: AbortController | null = null;
  /** Bumped on reset so a reply still in flight can't write into a new chat. */
  private generation = 0;

  constructor() {
    const saved = store.load();
    this.session = saved.session;
    this.messages = saved.messages;
  }

  async mount(): Promise<void> {
    this.bindEvents();
    this.view.setOpen(false);
    this.refreshHeader();
    this.refreshClinicStatus();
    setInterval(() => this.refreshClinicStatus(), 60_000);
    this.renderAll();

    // Catch up on anything staff said while this tab was closed or refreshing.
    if (this.session) {
      const remote = await fetchConversation(this.session);
      if (remote === "gone") {
        this.session = null;
        this.persist();
      } else if (remote) {
        this.messages = remote.messages;
        this.mode = remote.mode;
        this.staffName = remote.staffName;
        this.persist();
        this.renderAll();
        this.refreshHeader();
        this.connectLive();
      }
    }
  }

  private bindEvents(): void {
    const v = this.view;
    v.toggleBtn.addEventListener("click", () => this.toggle());
    v.sendBtn.addEventListener("click", () => this.submitInput());
    v.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this.submitInput();
      }
    });
    v.input.maxLength = LIMITS.maxChars;
    v.resetBtn.addEventListener("click", () => this.reset());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.toggle(false);
    });
    // Buttons around the page ("Book with Dr. Cole", service cards) ask through the chat.
    document.addEventListener(ASK_EVENT, (e) => {
      const text = (e as CustomEvent<string>).detail;
      if (!this.isOpen) this.toggle(true);
      if (!this.busy) void this.send(text);
      else this.view.input.value = text;
    });
  }

  toggle(force?: boolean): void {
    this.isOpen = force ?? !this.isOpen;
    this.view.setOpen(this.isOpen);
    if (this.isOpen) {
      this.view.toggleBtn.classList.remove("has-unread");
      this.view.input.focus();
      this.view.scroll();
    } else {
      this.view.toggleBtn.focus();
    }
  }

  private submitInput(): void {
    const text = this.view.input.value.trim();
    if (!text || this.busy) return;
    this.view.input.value = "";
    void this.send(text);
  }

  private readonly pick = (s: Suggestion): void => {
    if (!this.busy) void this.send(s.prompt);
  };

  private async send(text: string): Promise<void> {
    const gen = this.generation;
    this.setBusy(true);
    this.addLocal(store.localMessage("visitor", text));

    const urgency = assessUrgency(text);
    if (urgency) this.view.alert(urgency);

    const handled = await this.sendToServer(text);
    if (gen !== this.generation) return; // chat was reset while we waited
    if (!handled) {
      // Server unreachable: answer locally so the visitor isn't left hanging.
      this.replySource = "offline";
      this.addLocal(store.localMessage("bot", offlineAnswer(text, urgency).text));
    }

    this.refreshHeader();
    this.refreshChips(text);
    this.setBusy(false);
    if (this.isOpen) this.view.input.focus();
  }

  /** Returns false if the server couldn't be used and the caller should answer offline. */
  private async sendToServer(text: string): Promise<boolean> {
    this.session ??= await createConversation();
    if (!this.session) return false;
    this.persist();
    this.connectLive();

    const typing = this.mode === "bot" ? this.view.typing() : null;
    let bubble: HTMLDivElement | null = null;
    let streamed = "";
    this.inflight = new AbortController();
    const outcome = await sendMessage(
      this.session,
      text,
      (delta) => {
        if (!bubble) {
          typing?.remove();
          bubble = this.view.bubble("assistant");
        }
        streamed += delta;
        bubble.textContent = streamed;
        this.view.scroll();
      },
      this.inflight.signal,
    );
    const aborted = this.inflight.signal.aborted;
    this.inflight = null;
    typing?.remove();
    if (aborted) return true;

    // Assigned inside the callback above, which TypeScript can't see.
    const streamedBubble = bubble as HTMLDivElement | null;
    switch (outcome.kind) {
      case "reply": {
        this.replySource = outcome.source;
        const target = streamedBubble ?? this.view.bubble("assistant");
        writeRich(target, streamed); // re-render so phone numbers become links
        this.messages.push(store.localMessage("bot", streamed));
        this.persist();
        return true;
      }
      case "queued":
        // Staff are handling the chat; they'll answer on the live channel.
        return true;
      case "error":
        if (outcome.code === "not_found") {
          // Server restarted or forgot this chat: start a fresh one next time.
          this.session = null;
          this.live?.close();
          this.live = null;
          this.persist();
        }
        if (outcome.code === "rate_limited") {
          this.view.notice("You're sending messages quickly - here's an instant answer instead.");
        }
        streamedBubble?.remove();
        return false;
    }
  }

  private connectLive(): void {
    if (this.live || !this.session) return;
    this.live = openLive(this.session, (e) => this.onLive(e));
  }

  private onLive(e: VisitorEvent): void {
    switch (e.type) {
      case "message":
        if (this.messages.some((m) => m.id === e.message.id)) return;
        this.view.clearStaffTyping();
        this.addLocal(e.message);
        if (!this.isOpen && e.message.from === "staff") this.view.toggleBtn.classList.add("has-unread");
        break;
      case "mode":
        this.mode = e.mode;
        this.staffName = e.staffName;
        this.refreshHeader();
        this.refreshChips(null);
        break;
      case "typing":
        this.view.staffTyping(e.staffName);
        break;
    }
  }

  private addLocal(m: Message): void {
    this.messages.push(m);
    this.persist();
    this.view.message(m);
  }

  private renderAll(): void {
    this.view.clear();
    this.view.bubble("assistant", greeting());
    for (const m of this.messages) {
      this.view.message(m);
      if (m.from === "visitor") {
        const u = assessUrgency(m.text);
        if (u) this.view.alert(u);
      }
    }
    const lastVisitor = [...this.messages].reverse().find((m) => m.from === "visitor");
    this.refreshChips(lastVisitor?.text ?? null);
  }

  private refreshChips(lastText: string | null): void {
    // With a person on the other end, canned suggestions just get in the way.
    let chips: Suggestion[] = [];
    if (this.mode !== "human") chips = lastText ? followUps(lastText) : STARTER_CHIPS;
    this.view.setChips(chips, this.pick);
  }

  private refreshHeader(): void {
    if (this.mode === "human") this.view.setMode("staff", this.staffName);
    else this.view.setMode(this.replySource);
  }

  private reset(): void {
    this.inflight?.abort();
    this.live?.close();
    this.live = null;
    this.generation++;
    this.session = null;
    this.messages = [];
    this.mode = "bot";
    this.staffName = null;
    store.clear();
    this.renderAll();
    this.refreshHeader();
    this.setBusy(false);
    this.view.input.focus();
  }

  private persist(): void {
    store.save({ session: this.session, messages: this.messages });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.view.setBusy(busy);
  }

  private refreshClinicStatus(): void {
    const s = outpatientStatus();
    this.view.clinic.textContent = s.label;
    this.view.clinic.classList.toggle("closed", !s.open);
  }
}
