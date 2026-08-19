import { describe, it, expect } from "vitest";
import {
  buildStartupScript,
  startupScriptFileName,
  startupInstructions,
  buildDualStartupScript,
  dualStartupScriptFileName,
  dualStartupInstructions,
} from "./startup-script";

const script = buildStartupScript({
  screenId: "FT:1",
  name: "Blue Track check-in",
  url: "https://fasttraxent.com/tv?screen=FT:1",
});

describe("startup script", () => {
  it("uses CRLF line endings", () => {
    // A .bat with bare LF endings misbehaves on some Windows shells, and these
    // files go onto machines nobody will be sitting in front of.
    expect(script).toContain("\r\n");
    expect(script.split("\r\n").length).toBeGreaterThan(20);
    // No lone LF anywhere.
    expect(script.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("finds Edge by full path, with a fallback and a readable failure", () => {
    // PATH is not reliable under the Winlogon shell — the existing kiosk
    // scripts hardcode the path for the same reason.
    expect(script).toContain("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(script).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(script).toContain("Could not find Microsoft Edge");
  });

  it("never leaves a bare % in the URL — batch would eat it", () => {
    // THE 2026-08-11 OUTAGE. `%` starts a parameter substitution in a .bat, so
    // a percent-encoded screen id was silently corrupted: FT%3A1 -> FTA1, the
    // player asked for a screen that does not exist, and every board sat on the
    // unprovisioned ads-only fallback all evening.
    const encoded = buildStartupScript({
      screenId: "FT:1",
      name: "Blue",
      url: "https://fasttraxent.com/tv?screen=FT:1",
    });
    const line = encoded.split("\r\n").find((l) => l.startsWith('set "TV_URL='))!;
    // Any % that survives must be doubled — cmd renders %% as a single %.
    expect(line.replace(/%%/g, "")).not.toContain("%");
  });

  it("passes a plain colon through, because that is what the route now sends", () => {
    const line = script.split("\r\n").find((l) => l.startsWith('set "TV_URL='))!;
    expect(line).toContain("screen=FT:1");
    expect(line).not.toContain("%");
  });

  it("opens the right screen in true kiosk mode", () => {
    expect(script).toContain("https://fasttraxent.com/tv?screen=FT:1");
    expect(script).toContain("--kiosk ");
    expect(script).toContain("--edge-kiosk-type=fullscreen");
  });

  it("disables the idle reset", () => {
    // Edge kiosk wipes the session after a few idle minutes by default. On
    // signage — idle by definition — that is a reload loop.
    expect(script).toContain("--kiosk-idle-timeout-minutes=0");
  });

  it("never shows a dialog on a wall", () => {
    expect(script).toContain("--disable-session-crashed-bubble");
    expect(script).toContain("--hide-crash-restore-bubble");
    expect(script).toContain("--noerrdialogs");
    expect(script).toContain("--disable-infobars");
  });

  it("keeps rendering while unattended", () => {
    // A backgrounded renderer would throttle the animations the screen exists
    // to show.
    expect(script).toContain("--disable-background-timer-throttling");
    expect(script).toContain("--disable-renderer-backgrounding");
  });

  it("waits for the network before launching", () => {
    // A TV and its switch power on together; without this Edge lands on an
    // error page and stays there all evening.
    expect(script).toContain(":waitnet");
    expect(script).toContain("goto waitnet");
  });

  it("relaunches forever, with a pause so a crash loop cannot spin the CPU", () => {
    expect(script).toContain("/wait");
    expect(script).toContain(":launch");
    expect(script).toContain("goto launch");
    expect(script).toContain("timeout /t 5");
  });

  it("gives each screen its own Edge profile", () => {
    // So two screens on one PC stay independent, and a staff member opening
    // Edge for something else cannot disturb the wall.
    expect(script).toContain("C:\\TV\\profile-ft-1");
  });

  it("names the file safely for Windows", () => {
    // The colon in a screen id is illegal in a Windows filename.
    expect(startupScriptFileName("FT:1")).toBe("tv-ft-1.bat");
    expect(startupScriptFileName("HPFM:99")).toBe("tv-hpfm-99.bat");
    expect(startupScriptFileName("FT:1")).not.toContain(":");
  });
});

describe("instructions", () => {
  const steps = startupInstructions("FT:1");

  it("names the folder and the file", () => {
    const all = steps.join(" ");
    expect(all).toContain("C:\\TV\\");
    expect(all).toContain("tv-ft-1.bat");
  });

  it("installs the launcher as the WINDOWS SHELL", () => {
    const all = steps.join(" ");
    expect(all).toContain("Winlogon");
    expect(all).toContain("Shell");
    expect(all).toContain("explorer.exe");
    // The full path, not just the filename — the registry value is a path.
    expect(all).toContain("C:\\TV\\tv-ft-1.bat");
  });

  it("offers the shell method and NOTHING ELSE", () => {
    // ONE METHOD FOR EVERY SCREEN (owner 2026-08-19). The Run-key route used to
    // be step 5 here with the shell as an afterthought, and this asserts the
    // reversal held: two documented ways to start a player meant two ways for one
    // to be half-configured, and the Run-key one left a desktop behind the board
    // that only showed itself when Edge crashed.
    const all = steps.join(" ");
    expect(all).not.toContain("CurrentVersion\\Run");
    expect(all).not.toMatch(/run at sign-in|Run key/i);
  });

  it("teaches the way back out BEFORE taking the desktop away", () => {
    // Task Manager is the escape hatch and it is load-bearing: Ctrl+Shift+Esc is
    // handled by Windows, not the shell, so it still opens on a machine whose
    // shell is a batch file. Someone has to know that before they set the value.
    const all = steps.join(" ");
    expect(all).toContain("Ctrl+Shift+Esc");
    expect(all).toMatch(/no Start menu|no desktop|Safe Mode/);
    // And the escape hatch is taught before the change that needs it.
    const escapeAt = steps.findIndex((s) => s.includes("Ctrl+Shift+Esc"));
    const shellAt = steps.findIndex((s) => s.includes("Winlogon"));
    expect(escapeAt).toBeGreaterThanOrEqual(0);
    expect(escapeAt).toBeLessThan(shellAt);
  });

  it("makes the player sign itself in", () => {
    // Without autologon a reboot leaves the wall on the lock screen and the shell
    // never starts at all — which looks exactly like a broken script.
    expect(steps.join(" ")).toContain("netplwiz");
  });

  it("says to test by double-clicking while a desktop still exists", () => {
    const all = steps.join(" ");
    expect(all).toMatch(/Double-click/i);
    expect(all).toMatch(/STILL WORKS|still works/);
  });
});

/* ── two monitors, one player PC ───────────────────────────────────────── */

const dual = buildDualStartupScript({
  left: { screenId: "FT:7", name: "Blue Pit", url: "https://fasttraxent.com/tv?screen=FT:7" },
  right: { screenId: "FT:8", name: "Red Pit", url: "https://fasttraxent.com/tv?screen=FT:8" },
});

/** The executable lines — comments explain the approaches that FAILED, and a
 *  naive `toContain` would happily match those and pass for the wrong reason. */
const dualCode = dual
  .split("\r\n")
  .filter((l) => !/^\s*REM\b/.test(l))
  .join("\n");

describe("two-monitor startup script", () => {
  it("uses CRLF line endings", () => {
    expect(dual).toContain("\r\n");
    expect(dual.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("opens BOTH screens, left first", () => {
    expect(dualCode).toContain("https://fasttraxent.com/tv?screen=FT:7");
    expect(dualCode).toContain("https://fasttraxent.com/tv?screen=FT:8");
    // Left is the one this console babysits; right is the one it spawns.
    expect(dualCode).toMatch(/set "LEFT_URL=.*FT:7"/);
    expect(dualCode).toMatch(/set "RIGHT_URL=.*FT:8"/);
    expect(dualCode).toContain('set "TV_URL=%LEFT_URL%"');
  });

  it("gives each board its OWN Edge profile", () => {
    // Sharing a profile means the second launch hands its URL to the first
    // instance and every window flag is ignored — both boards on one monitor.
    expect(dualCode).toContain('set "LEFT_SLOT=ft-7"');
    expect(dualCode).toContain('set "RIGHT_SLOT=ft-8"');
    expect(dualCode).toContain('set "TV_PROFILE=C:\\TV\\profile-%TV_SLOT%"');
  });

  it("places by --window-position and fullscreens by --start-fullscreen", () => {
    expect(dualCode).toContain("--window-position=%TV_X%,%TV_Y%");
    expect(dualCode).toContain("--start-fullscreen");
  });

  it("never reintroduces the three approaches that failed on real hardware", () => {
    // --app: Edge ignores --start-fullscreen for app windows, so the board keeps
    // a title bar. --kiosk: claims the primary display, so it cannot drive two
    // monitors. SendKeys F11: needs foreground rights no autostarted script has,
    // and a stray F11 knocks the OTHER board out of fullscreen.
    expect(dualCode).not.toContain("--app=");
    expect(dualCode).not.toContain("--kiosk");
    expect(dualCode).not.toContain("SendKeys");
    expect(dualCode).not.toContain("AppActivate");
  });

  it("warns when the PC forces Edge sign-in", () => {
    // BrowserSignin=2 shows "your admin needs you to sign in" INSTEAD of the
    // board, and nothing on a dark wall says why.
    expect(dualCode).toContain("BrowserSignin");
    expect(dual).toContain("FORCES EDGE SIGN-IN");
  });

  it("reads the monitor layout without a pipe in the probe", () => {
    // A `^|` inside a for /f backquote reaches PowerShell literally and the whole
    // probe falls back to hardcoded 1920x1080 guesses.
    const probe = dualCode.split("\n").find((l) => l.includes("AllScreens")) ?? "";
    expect(probe, "the monitor probe line").not.toBe("");
    expect(probe).not.toContain("|");
    expect(dualCode).toContain("MON_COUNT");
  });

  it("relaunches forever and staggers nothing on focus", () => {
    expect(dualCode).toContain("goto launch");
    expect(dualCode).toContain('start "" /wait "%EDGE%"');
  });

  it("never leaves a bare % in either URL", () => {
    const encoded = buildDualStartupScript({
      left: { screenId: "FT:7", name: "Blue", url: "https://x/tv?screen=FT%3A7" },
      right: { screenId: "FT:8", name: "Red", url: "https://x/tv?screen=FT%3A8" },
    });
    expect(encoded).toContain("FT%%3A7");
    expect(encoded).toContain("FT%%3A8");
  });

  it("names both screens in the filename", () => {
    expect(dualStartupScriptFileName("FT:7", "FT:8")).toBe("tv-pair-ft-7-ft-8.bat");
    expect(dualStartupScriptFileName("FT:7", "FT:8")).not.toContain(":");
  });

  it("leads its instructions with the sign-in policy, before any wiring", () => {
    const steps = dualStartupInstructions("FT:7", "FT:8");
    expect(steps[0]).toContain("BrowserSignin");
    expect(steps.join(" ")).toContain("Extend");
    expect(steps.join(" ")).toContain("SWAP_SIDES");
  });

  it("installs the pair the SAME one way a single screen is installed", () => {
    // The two launchers disagreed about three flags once (see EDGE_COMMON_FLAGS)
    // and the fix was one list. The install method is the same kind of thing: one
    // set of steps, shared, so a fix to one cannot skip the other.
    const steps = dualStartupInstructions("FT:7", "FT:8");
    const all = steps.join(" ");
    expect(all).toContain("Winlogon");
    expect(all).toContain("C:\\TV\\tv-pair-ft-7-ft-8.bat");
    expect(all).toContain("Ctrl+Shift+Esc");
    expect(all).toContain("netplwiz");
    expect(all).not.toContain("CurrentVersion\\Run");
  });

  it("orders the monitor check BEFORE the shell change", () => {
    // Getting the sides wrong is fixable from a desktop and awkward without one,
    // so SWAP_SIDES has to be settled while explorer is still the shell.
    const steps = dualStartupInstructions("FT:7", "FT:8");
    const swapAt = steps.findIndex((s) => s.includes("SWAP_SIDES"));
    const shellAt = steps.findIndex((s) => s.includes("Winlogon"));
    expect(swapAt).toBeGreaterThanOrEqual(0);
    expect(swapAt).toBeLessThan(shellAt);
  });
});
