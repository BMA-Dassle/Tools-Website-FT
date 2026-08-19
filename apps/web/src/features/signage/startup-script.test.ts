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

/**
 * Every `goto x` / `call :x` in a batch file must land on a `:x` that exists.
 * cmd does not fail loudly on a typo — it prints "The system cannot find the
 * batch label specified" to a console nobody is looking at and carries on,
 * which on a wall panel is indistinguishable from working. Both launchers grew
 * a set of subroutines and two re-entry points; this is the cheap structural
 * check that they are all wired up.
 */
function expectLabelsResolve(batch: string) {
  const lines = batch.split("\r\n");
  const defined = new Set(
    lines
      .map((l) => /^:([A-Za-z0-9_]+)\s*$/.exec(l.trim())?.[1]?.toLowerCase())
      .filter((l): l is string => !!l),
  );
  const targets = new Set<string>();
  for (const line of lines) {
    if (line.trim().startsWith("REM ")) continue;
    for (const m of line.matchAll(/\b(?:goto|call)\s+:?([A-Za-z0-9_]+)/g)) {
      const name = m[1].toLowerCase();
      if (name !== "eof") targets.add(name);
    }
  }
  for (const t of targets) {
    expect(defined, `goto/call :${t} has no matching label`).toContain(t);
  }
  expect(targets.size).toBeGreaterThan(2);
}

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
    expect(script).toContain("goto waitnetloop");
  });

  it("WAITS ON EVERY LAUNCH, NOT JUST THE FIRST (the relaunch used to skip it)", () => {
    // THE 2026-08-19 FAILURE. The wait sat ABOVE :launch, so `goto launch`
    // jumped straight over it. The relaunch that happens during a network
    // outage — the one case the wait exists for — went directly onto Edge's
    // error page, where it stayed: Edge had not exited, so the loop below never
    // fired again, and nothing on that page could ever retry.
    const lines = script.split("\r\n");
    const launchAt = lines.indexOf(":launch");
    const gotoLaunchAt = lines.lastIndexOf("goto launch");
    const callAt = lines.indexOf("call :waitnet");
    expect(launchAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThan(launchAt);
    expect(callAt).toBeLessThan(gotoLaunchAt);
  });

  it("checks OUR address, not just a public resolver", () => {
    // Pinging 1.1.1.1 says the internet is up. It does not say DNS resolves us,
    // that Vercel is answering, or that the app booted — and a player that can
    // ping the world but not reach the site is exactly a player on an error page.
    expect(script).toContain('set "TV_PROBE=https://fasttraxent.com/api/kiosk/version"');
    expect(script).toContain('curl.exe -s -f -o nul --max-time 10 "%TV_PROBE%"');
  });

  it("still has a check when the URL cannot be parsed", () => {
    // A launcher URL is data reaching a shell. A probe we cannot build must
    // degrade to the old ping, never to no check at all.
    const odd = buildStartupScript({ screenId: "FT:1", name: "Blue", url: "not a url" });
    expect(odd).toContain('set "TV_PROBE="');
    expect(odd).toContain("if not defined TV_PROBE goto probeping");
    expect(odd).toContain("ping -n 3 1.1.1.1");
  });

  it("starts exactly one network watchdog, and it recycles only on the way BACK UP", () => {
    // The only thing that recovers a board ALREADY parked on the error page:
    // Edge is alive, so the relaunch loop never fires. The watchdog kills it
    // once the network returns. Killing it DURING the outage would be strictly
    // worse — a screen that rode the outage out is showing its last good board,
    // and it would be replaced by the launcher's waiting console.
    expect(script.match(/start "TV network watchdog" \/min/g)).toHaveLength(1);
    expect(script).toContain('if /I "%~1"=="netwatch" goto netwatch');
    expect(script).toContain("if %DOWNFOR% GEQ 2 (");
    expect(script).toContain("taskkill /f /im msedge.exe");

    // The kill is inside the branch reached only when a probe SUCCEEDS.
    const lines = script.split("\r\n");
    const failBranchAt = lines.indexOf("if errorlevel 1 (", lines.indexOf(":netwatchloop"));
    const killAt = lines.findIndex((l) => l.includes("taskkill"));
    const gateAt = lines.indexOf("if %DOWNFOR% GEQ 2 (");
    expect(failBranchAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(failBranchAt);
    expect(killAt).toBeGreaterThan(gateAt);
  });

  it("every label a goto or call jumps to actually exists", () => {
    // A batch file with a typo'd label does not fail loudly; it prints "The
    // system cannot find the batch label" to a console nobody is looking at and
    // carries on, which on a wall panel is indistinguishable from working.
    expectLabelsResolve(script);
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

  it("waits for the network on EVERY launch, on BOTH boards", () => {
    // :launch is shared — the main path falls into it and the second board's
    // watchdog re-entry reaches it via :run — so one `call` inside the loop
    // covers both. It used to sit above the loop and a relaunch skipped it.
    const lines = dual.split("\r\n");
    const launchAt = lines.indexOf(":launch");
    const callAt = lines.indexOf("call :waitnet");
    const gotoLaunchAt = lines.lastIndexOf("goto launch");
    expect(callAt).toBeGreaterThan(launchAt);
    expect(callAt).toBeLessThan(gotoLaunchAt);
    // And the re-entry path really does reach it.
    expect(lines.indexOf(":run")).toBeLessThan(launchAt);
    expect(lines.indexOf(":watch")).toBeLessThan(lines.indexOf(":run"));
  });

  it("sets the probe BEFORE the re-entry dispatch — both re-entries read it", () => {
    // `watch` and `netwatch` both jump past the rest of the file, so a probe
    // assigned further down would be empty in exactly the two processes that
    // need it, and every check would silently degrade to the ping fallback.
    const lines = dual.split("\r\n");
    const probeAt = lines.findIndex((l) => l.startsWith('set "TV_PROBE='));
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(lines.indexOf('if /I "%~1"=="watch" goto watch'));
    expect(probeAt).toBeLessThan(lines.indexOf('if /I "%~1"=="netwatch" goto netwatch'));
  });

  it("starts exactly ONE network watchdog for the pair, not one per board", () => {
    // The spawn sits on the main path, above the :watch re-entry, so the second
    // board's process cannot start a second one. Two watchdogs would race to
    // taskkill the same Edge.
    expect(dual.match(/start "TV network watchdog" \/min/g)).toHaveLength(1);
    expect(dualCode).toContain("taskkill /f /im msedge.exe");
  });

  it("every label a goto or call jumps to actually exists", () => {
    expectLabelsResolve(dual);
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
