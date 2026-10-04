// Page behaviour outside the chat: navigation, live hours badge, animated
// numbers, and buttons that hand a question straight to the chat.

import { outpatientStatus } from "../shared/hospital.js";

export const ASK_EVENT = "glh:ask";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function mobileNav(): void {
  const nav = document.getElementById("top-nav");
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");
  if (!nav || !toggle || !links) return;

  const setOpen = (open: boolean) => {
    links.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  toggle.addEventListener("click", () => setOpen(!links.classList.contains("open")));
  links.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 30);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/** Highlights the nav link for the section in view. */
function scrollSpy(): void {
  const links = new Map<string, HTMLAnchorElement>();
  document.querySelectorAll<HTMLAnchorElement>('#nav-links a[href^="#"]').forEach((a) => {
    links.set(a.getAttribute("href")!.slice(1), a);
  });
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a, id) => a.classList.toggle("active", id === e.target.id));
      }
    },
    { rootMargin: "-45% 0px -50% 0px" },
  );
  links.forEach((_a, id) => {
    const section = document.getElementById(id);
    if (section) obs.observe(section);
  });
}

/** Live "open now" indicators, re-evaluated every minute in Central Time. */
function openStatus(): void {
  const heroText = document.getElementById("hero-open");
  const heroDot = document.getElementById("hero-open-dot");
  const pill = document.getElementById("contact-open");
  const update = () => {
    const s = outpatientStatus();
    if (heroText) heroText.textContent = s.open ? "Clinics open now - Jonesboro, AR" : "Emergency open 24/7 - Jonesboro, AR";
    heroDot?.classList.toggle("closed", !s.open);
    if (pill) {
      pill.textContent = s.open ? "Open now" : "Closed now";
      pill.classList.toggle("closed", !s.open);
    }
  };
  update();
  setInterval(update, 60_000);
}

/** Numbers count up the first time they scroll into view. */
function countUp(): void {
  const els = document.querySelectorAll<HTMLElement>("[data-count]");
  if (reducedMotion) return;
  const fmt = (el: HTMLElement, n: number) => {
    const v = el.dataset.sep ? Math.round(n).toLocaleString("en-US") : String(Math.round(n));
    el.textContent = v + (el.dataset.suffix ?? "");
  };
  const obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const el = e.target as HTMLElement;
        const target = Number(el.dataset.count);
        const start = performance.now();
        const tick = (t: number) => {
          const p = Math.min(1, (t - start) / 1400);
          fmt(el, target * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }
    },
    { threshold: 0.6 },
  );
  els.forEach((el) => {
    fmt(el, 0);
    obs.observe(el);
  });
}

/** Any element with data-ask opens the chat and asks that question. */
function askButtons(): void {
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ask]");
    if (!el?.dataset.ask) return;
    e.preventDefault();
    document.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: el.dataset.ask }));
  });
}

function revealOnScroll(): void {
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e, i) => {
        if (!e.isIntersecting) return;
        setTimeout(() => e.target.classList.add("visible"), i * 90);
        obs.unobserve(e.target);
      });
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll(".fade-in").forEach((el) => obs.observe(el));
}

export function initPage(): void {
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());
  mobileNav();
  scrollSpy();
  openStatus();
  countUp();
  askButtons();
  revealOnScroll();
}
