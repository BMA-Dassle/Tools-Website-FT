import { describe, it, expect } from "vitest";
import { buildStartupScript, startupScriptFileName, startupInstructions } from "./startup-script";

const script = buildStartupScript({
  screenId: "FT:1",
  name: "Blue Track check-in",
  url: "https://fasttraxent.com/tv?screen=FT%3A1",
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

  it("opens the right screen in true kiosk mode", () => {
    expect(script).toContain("https://fasttraxent.com/tv?screen=FT%3A1");
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

  it("names the folder, the file and both registry routes", () => {
    const all = steps.join(" ");
    expect(all).toContain("C:\\TV\\");
    expect(all).toContain("tv-ft-1.bat");
    expect(all).toContain("CurrentVersion\\Run");
    expect(all).toContain("Winlogon");
  });

  it("warns that replacing the shell removes the desktop", () => {
    // Someone will try this on their own laptop otherwise.
    expect(steps.join(" ")).toMatch(/no Start menu|Safe Mode/);
  });
});
