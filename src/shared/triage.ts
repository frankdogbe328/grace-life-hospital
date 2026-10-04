// Safety net that runs before any AI call: if a message looks like a medical
// emergency or a mental-health crisis, the person gets the phone number
// immediately instead of waiting on a model.

export type Urgency = "emergency" | "crisis" | null;

const CRISIS = [
  /\bsuicid/,
  /\bkill (my ?self|myself)\b/,
  /\bend (my|it all)\b.*\b(life|all)\b/,
  /\bwant to die\b/,
  /\bself[- ]?harm/,
  /\bhurt(ing)? myself\b/,
];

const EMERGENCY = [
  /\bchest pain/,
  /\bheart attack/,
  /\b(can'?t|cannot|can not|trouble|difficulty) breath/,
  /\bnot breathing\b/,
  /\bstroke\b/,
  /\b(face|arm) (is )?(droop|numb)/,
  /\bunconscious\b/,
  /\bpassed out\b/,
  /\bunresponsive\b/,
  /\bseizure/,
  /\b(heavy|severe|won'?t stop) bleed/,
  /\bbleeding (a lot|heavily|badly)/,
  /\boverdose/,
  /\bpoison/,
  /\banaphyla/,
  /\bthroat (is )?(closing|swelling)/,
  /\bchoking\b/,
  /\bsevere (burn|allergic)/,
  // "Do you have an emergency room?" is a question, not an emergency.
  /\b(this is an|it'?s an|having an|we have an|i have an) emergency\b/,
];

export function assessUrgency(text: string): Urgency {
  const t = text.toLowerCase().replace(/’/g, "'");
  if (CRISIS.some((r) => r.test(t))) return "crisis";
  if (EMERGENCY.some((r) => r.test(t))) return "emergency";
  return null;
}
