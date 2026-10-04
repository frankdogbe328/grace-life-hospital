// Single source of truth for hospital facts. The server builds the AI system
// prompt from this, and the browser's offline assistant answers from it, so the
// two can never disagree about a phone number or opening hour.

export const HOSPITAL = {
  name: "Grace Life Hospital",
  address: "Jones St, Jonesboro, AR 72401, United States",
  mapsUrl: "https://maps.google.com/?q=Jones+St,+Jonesboro,+AR+72401",
  phoneDisplay: "+1 (940) 347-7005",
  phoneTel: "+19403477005",
  email: "gracelifehospital21@gmail.com",
  timeZone: "America/Chicago",
  services: [
    { name: "Oncology", blurb: "diagnosis, surgical resection, chemotherapy and targeted therapy for colorectal, breast, lung and other cancers" },
    { name: "Gastroenterology", blurb: "colonoscopy, endoscopy, biopsy and complete digestive care" },
    { name: "General Surgery", blurb: "laparoscopic and open procedures in fully equipped theatres" },
    { name: "Laboratory and Pathology", blurb: "blood panels, tumor markers, coagulation profiles and biopsy analysis with rapid on-site reporting" },
    { name: "Diagnostic Imaging", blurb: "CT, MRI, PET-CT, X-ray and ultrasound with fast turnaround" },
    { name: "Emergency Care", blurb: "24/7 trauma and critical care team" },
  ],
  doctors: [
    { name: "Dr. Michael Cole", specialty: "Gastroenterology and Oncology" },
    { name: "Dr. Evelyn Marsh", specialty: "Senior Histopathologist" },
    { name: "Dr. James Reid", specialty: "Surgical Oncology" },
    { name: "Dr. Angela Brooks", specialty: "Anaesthesiology" },
  ],
} as const;

/** Weekly outpatient hours in Central Time. Day 0 = Sunday. null = closed. */
const HOURS: ReadonlyArray<readonly [open: number, close: number] | null> = [
  null,
  [7, 20], [7, 20], [7, 20], [7, 20], [7, 20],
  [8, 17],
];

export const HOURS_TEXT = "Mon-Fri 7:00 AM-8:00 PM, Sat 8:00 AM-5:00 PM (Central Time). Closed Sunday for outpatient visits. Emergency care is open 24/7.";

export interface OpenStatus {
  open: boolean;
  /** Short human label, e.g. "Open now - closes 8 PM". */
  label: string;
}

/** Outpatient open/closed status right now, evaluated in the hospital's time zone. */
export function outpatientStatus(now: Date = new Date()): OpenStatus {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOSPITAL.timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) + Number(get("minute")) / 60;

  const today = HOURS[day];
  if (today && hour >= today[0] && hour < today[1]) {
    return { open: true, label: `Clinics open now - close ${fmtHour(today[1])}` };
  }
  return { open: false, label: "Clinics closed now - Emergency open 24/7" };
}

function fmtHour(h: number): string {
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1} ${suffix}`;
}
