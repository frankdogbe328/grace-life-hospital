// Offline brain: answers the common front-desk questions from HOSPITAL facts
// with no network. Used when the AI is unavailable, and to pick follow-up
// suggestion chips after every reply (online or off).

import { HOSPITAL, HOURS_TEXT, outpatientStatus } from "./hospital.js";
import type { Urgency } from "./triage.js";

export interface Suggestion {
  label: string;
  /** Text sent as the user's message when the chip is tapped. */
  prompt: string;
}

export type TopicId =
  | "human" | "greeting" | "thanks" | "appointment" | "services" | "location" | "hours"
  | "contact" | "doctors" | "emergency" | "unknown_info" | "fallback";

interface Topic {
  id: TopicId;
  patterns: RegExp[];
  answer: (text: string) => string;
}

export const CHIPS = {
  book: { label: "Book appointment", prompt: "How do I book an appointment?" },
  services: { label: "Services", prompt: "What services do you offer?" },
  location: { label: "Location", prompt: "Where are you located?" },
  hours: { label: "Hours", prompt: "What are your opening hours?" },
  doctors: { label: "Our doctors", prompt: "Who are your doctors?" },
  contact: { label: "Contact", prompt: "How can I contact you?" },
  emergency: { label: "Emergency care", prompt: "Do you have emergency care?" },
  human: { label: "Talk to a person", prompt: "I'd like to talk to a person." },
} satisfies Record<string, Suggestion>;

export const STARTER_CHIPS: Suggestion[] = [CHIPS.book, CHIPS.services, CHIPS.hours, CHIPS.human];

const FOLLOW_UPS: Record<TopicId, Suggestion[]> = {
  human: [],
  greeting: STARTER_CHIPS,
  thanks: [CHIPS.book, CHIPS.services],
  appointment: [CHIPS.doctors, CHIPS.hours, CHIPS.location],
  services: [CHIPS.doctors, CHIPS.book, CHIPS.emergency],
  location: [CHIPS.hours, CHIPS.book, CHIPS.contact],
  hours: [CHIPS.book, CHIPS.location, CHIPS.emergency],
  contact: [CHIPS.human, CHIPS.book],
  doctors: [CHIPS.book, CHIPS.services],
  emergency: [CHIPS.location, CHIPS.contact],
  unknown_info: [CHIPS.human, CHIPS.contact],
  fallback: STARTER_CHIPS,
};

const service = (name: string) => HOSPITAL.services.find((s) => s.name === name)!;
const SERVICE_ALIASES: Array<[RegExp, (typeof HOSPITAL.services)[number]]> = [
  [/\b(oncolog|cancer|chemo|tumou?r)/, service("Oncology")],
  [/\b(gastro|colonoscop|endoscop|digest|stomach|bowel)/, service("Gastroenterology")],
  [/\b(surg|operation|laparoscop)/, service("General Surgery")],
  [/\b(lab\b|laborator|blood (test|work)|patholog|biops)/, service("Laboratory and Pathology")],
  [/\b(imaging|scan|mri\b|ct\b|x-?ray|ultrasound|pet\b)/, service("Diagnostic Imaging")],
];

const listServices = () => HOSPITAL.services.map((s) => s.name).join(", ");
const phone = HOSPITAL.phoneDisplay;

const TOPICS: Topic[] = [
  {
    // The server intercepts this topic to alert staff; the text here is only
    // used when the site is running without the server.
    id: "human",
    patterns: [/\b(human|real person|live (agent|person|chat)|talk to (a |an |some)?(person|one|body|staff|nurse|agent)|speak (to|with) (a |an |some)?(person|one|body|staff|nurse|agent)|representative|operator)\b/],
    answer: () => `Our team can help directly - call ${phone} or email ${HOSPITAL.email}.`,
  },
  {
    id: "emergency",
    patterns: [/\bemergenc/, /\b(er|a&e|icu|trauma|urgent)\b/, /\bambulance/],
    answer: () =>
      `Yes - our emergency department is open 24/7 with a dedicated trauma and critical care team. For anything life-threatening call 911, or reach our emergency line at ${phone}.`,
  },
  {
    id: "appointment",
    patterns: [/\b(appointment|appt|book|booking|schedule|consult|see a doctor)\b/, /\bre-?schedul/, /\bcancel/],
    answer: (t) => {
      const doc = HOSPITAL.doctors.find((d) => t.includes(d.name.split(" ").at(-1)!.toLowerCase()));
      if (doc) {
        return `Happy to help you see ${doc.name} (${doc.specialty}). Call ${phone} or email ${HOSPITAL.email} and the front desk will find you the next available slot.`;
      }
      return `You can book, change or cancel an appointment by calling ${phone} or emailing ${HOSPITAL.email}. Our front desk answers during clinic hours: ${HOURS_TEXT.split(" (")[0]} CT.`;
    },
  },
  {
    id: "doctors",
    patterns: [/\b(doctor|doctors|physician|specialist|surgeon|team|staff|dr\.?)\b/, /\b(cole|marsh|reid|brooks)\b/],
    answer: (t) => {
      const named = HOSPITAL.doctors.find((d) => t.includes(d.name.split(" ").at(-1)!.toLowerCase()));
      if (named) {
        return `${named.name} is our ${named.specialty} specialist. To book with them, call ${phone} or email ${HOSPITAL.email}.`;
      }
      return `Our specialists include ${HOSPITAL.doctors.map((d) => `${d.name} (${d.specialty})`).join(", ")}. We have 50+ board-certified physicians in total.`;
    },
  },
  {
    id: "services",
    patterns: [
      /\b(service|services|offer|treat|treatment|department|specialt)/,
      // Word stems: no trailing \b, so "colonoscop" matches "colonoscopy".
      /\b(oncolog|cancer|chemo|tumou?r|gastro|colonoscop|endoscop|digest|surg|operation|laparoscop|lab\b|laborator|blood (test|work)|patholog|biops|imaging|scan|mri\b|ct\b|x-?ray|ultrasound|pet\b)/,
    ],
    answer: (t) => {
      const hit = SERVICE_ALIASES.find(([re]) => re.test(t))?.[1];
      if (hit) return `Yes, we offer ${hit.name}: ${hit.blurb}. Call ${phone} to arrange a consultation.`;
      return `We offer ${listServices()}. Tap one below or ask me about any of them.`;
    },
  },
  {
    id: "hours",
    patterns: [/\b(hour|hours|open|opening|close|closing|closed|time|times|weekend|saturday|sunday|today)\b/],
    answer: () => `${outpatientStatus().label}. Our hours are ${HOURS_TEXT}`,
  },
  {
    id: "location",
    patterns: [/\b(where|location|located|address|direction|directions|map|find you|parking|get there)\b/],
    answer: (t) =>
      /\bparking\b/.test(t)
        ? `I don't have parking details yet - please call ${phone} and the front desk will help. We're at ${HOSPITAL.address}.`
        : `We're at ${HOSPITAL.address}. The "Get Directions" button in the Find Us section opens Google Maps.`,
  },
  {
    id: "contact",
    patterns: [/\b(contact|phone|call|number|email|e-mail|reach|talk to|speak to|human|person)\b/],
    answer: () => `You can call us any time at ${phone} or email ${HOSPITAL.email}.`,
  },
  {
    id: "unknown_info",
    patterns: [/\b(insurance|medicare|medicaid|cost|price|pricing|pay|bill|billing|fee|visiting|visitor|records|results)\b/],
    answer: () =>
      `I don't have that information here, and I'd rather not guess. Our front desk can help - call ${phone} or email ${HOSPITAL.email}.`,
  },
  {
    id: "thanks",
    patterns: [/\b(thank|thanks|thx|cheers|appreciate)\b/],
    answer: () => "You're welcome! Is there anything else I can help with?",
  },
  {
    id: "greeting",
    patterns: [/^(hi|hello|hey|good (morning|afternoon|evening)|yo)\b/],
    answer: () => "Hello! I can help with appointments, our services and doctors, hours and directions. What do you need?",
  },
];

/** Which topic a message is about, or null if none matched. */
export function topicOf(text: string): TopicId | null {
  return classify(text)?.id ?? null;
}

function classify(text: string): Topic | null {
  const t = normalize(text);
  return TOPICS.find((topic) => topic.patterns.some((p) => p.test(t))) ?? null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/’/g, "'").trim();
}

export function offlineAnswer(
  text: string,
  urgency: Urgency = null,
): { text: string; suggestions: Suggestion[] } {
  if (urgency === "crisis") {
    return {
      text: "I'm really glad you reached out. Please call or text 988 now to talk with someone who can help, any time of day. If you might act on these thoughts, call 911.",
      suggestions: [],
    };
  }
  if (urgency === "emergency") {
    return {
      text: `Please call 911 right away, or our emergency line at ${phone}. Our emergency department is open 24/7 at ${HOSPITAL.address}.`,
      suggestions: [CHIPS.location],
    };
  }
  const topic = classify(text);
  if (!topic) {
    return {
      text: `I can answer questions about appointments, services, doctors, hours and directions. For anything else, our team is at ${phone}.`,
      suggestions: FOLLOW_UPS.fallback,
    };
  }
  return { text: topic.answer(normalize(text)), suggestions: FOLLOW_UPS[topic.id] };
}

/** Follow-up chips for a user message, regardless of who answered it. */
export function followUps(text: string): Suggestion[] {
  return FOLLOW_UPS[classify(text)?.id ?? "fallback"];
}
