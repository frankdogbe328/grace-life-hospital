// Hidden ways into the staff console. None of these grant access on their own;
// they only open the login screen. The console code is loaded on demand, so
// ordinary visitors never download it.
//
//   - click the footer copyright line 5 times quickly
//   - press Alt+Shift+A
//   - open the site with #staff on the URL

const STAFF_FLAG = "glh-staff";

async function open(): Promise<void> {
  const { openStaffConsole } = await import("./console.js");
  openStaffConsole();
}

export function markStaffDevice(on: boolean): void {
  try {
    if (on) localStorage.setItem(STAFF_FLAG, "1");
    else localStorage.removeItem(STAFF_FLAG);
  } catch {
    /* storage blocked: the pill just won't appear after reload */
  }
}

function isStaffDevice(): boolean {
  try {
    return localStorage.getItem(STAFF_FLAG) === "1";
  } catch {
    return false;
  }
}

export function installSecretEntrances(): void {
  const target = document.querySelector<HTMLElement>(".foot-copy");
  let clicks: number[] = [];
  target?.addEventListener("click", () => {
    const now = Date.now();
    clicks = [...clicks.filter((t) => now - t < 2500), now];
    if (clicks.length >= 5) {
      clicks = [];
      void open();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyA") {
      e.preventDefault();
      void open();
    }
  });

  const checkHash = () => {
    if (location.hash === "#staff") {
      history.replaceState(null, "", location.pathname + location.search);
      void open();
    }
  };
  window.addEventListener("hashchange", checkHash);
  checkHash();

  // A device that has signed in before gets a quiet shortcut back in, but
  // only if its session is still valid.
  if (isStaffDevice()) {
    void import("./console.js").then((m) => m.showPillIfSignedIn());
  }
}
