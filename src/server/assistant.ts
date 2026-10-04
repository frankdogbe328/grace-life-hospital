import Anthropic from "@anthropic-ai/sdk";
import { HOSPITAL, HOURS_TEXT } from "../shared/hospital.js";
import { LIMITS, type Message } from "../shared/protocol.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are the virtual front-desk assistant on the ${HOSPITAL.name} website, chatting with patients and families.

Hospital facts (the only facts you may state about the hospital):
- Address: ${HOSPITAL.address}
- Phone (24/7, also the emergency line): ${HOSPITAL.phoneDisplay}
- Email: ${HOSPITAL.email}
- Hours: ${HOURS_TEXT}
- Services: ${HOSPITAL.services.map((s) => `${s.name} (${s.blurb})`).join("; ")}
- Doctors: ${HOSPITAL.doctors.map((d) => `${d.name}, ${d.specialty}`).join("; ")}

How to reply:
- Keep replies to 2-3 short sentences in plain text; the chat window is small and does not render markdown.
- Be warm and direct. Answer the question first.
- Appointments are booked by phone or email; you cannot book, cancel or look up appointments, records, bills or test results yourself, so point people to the phone line or email for those.
- You are not a clinician. Do not diagnose, interpret results, or recommend medication or doses. For symptoms, suggest seeing a doctor and offer the relevant service.
- If anything sounds urgent or life-threatening, tell them to call 911 or the hospital at ${HOSPITAL.phoneDisplay} right away, before anything else.
- If someone mentions thoughts of suicide or self-harm, respond with care and give the 988 Suicide & Crisis Lifeline (call or text 988) alongside 911.
- Sometimes a hospital staff member has joined the chat; their messages appear marked [Staff member ...]. Don't contradict them, and never pretend to be them.
- If someone asks for a person, tell them you've let the team know.
- If you don't know something (prices, insurance accepted, parking, visiting rules), say so and give the phone number rather than guessing.`;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export function aiConfigured(): boolean {
  return client !== null;
}

/** Converts the stored transcript into alternating user/assistant turns for the API. */
export function toAiHistory(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages.slice(-LIMITS.aiHistory)) {
    if (m.from === "system") continue;
    const role = m.from === "visitor" ? "user" : "assistant";
    const content = m.from === "staff" ? `[Staff member ${m.staffName ?? ""} wrote:] ${m.text}` : m.text;
    const last = turns.at(-1);
    if (last?.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  while (turns[0]?.role === "assistant") turns.shift();
  return turns;
}

/**
 * Streams the assistant's reply through onDelta. Resolves true when a complete
 * reply was produced, false when the caller should fall back. Never throws.
 */
export async function askAi(
  history: ChatTurn[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (!client || history.at(-1)?.role !== "user") return false;

  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 4000,
        // Front-desk chat: speed matters more than deep reasoning.
        output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: history,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    let sentText = false;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sentText = true;
        onDelta(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    return sentText && final.stop_reason !== "refusal";
  } catch (err) {
    if (signal.aborted) return false;
    if (err instanceof Anthropic.APIError) {
      console.error(`[assistant] API error ${err.status}: ${err.message}`);
    } else {
      console.error("[assistant] unexpected error", err);
    }
    return false;
  }
}
