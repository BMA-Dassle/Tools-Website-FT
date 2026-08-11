/**
 * The Windows startup script for a TV player. PURE — string in, string out.
 *
 * Everything here is aimed at ONE failure mode: a screen that is wrong at 6pm
 * on a Saturday with nobody free to fix it. So the batch file is defensive
 * rather than clever.
 *
 *   - WAITS FOR THE NETWORK. A TV and its switch power up together; Edge
 *     launched three seconds in lands on a connection error and sits there.
 *   - RELAUNCHES FOREVER. If Edge is closed, crashes, or is killed by an
 *     update, the loop brings it straight back.
 *   - ITS OWN EDGE PROFILE per screen, so a staff member opening Edge for
 *     something else cannot disturb the wall, and two screens on one machine
 *     stay independent.
 *   - FULL PATH TO EDGE, matching the existing kiosk scripts: PATH is not
 *     reliable under the Winlogon shell.
 *   - NO IDLE RESET. Edge kiosk mode defaults to wiping the session after a few
 *     idle minutes — on signage, which is idle by definition, that is a reload
 *     loop. Explicitly disabled.
 *   - NO CRASH BUBBLE. After a power cut Edge otherwise opens asking to restore
 *     pages, and the wall shows a dialog until someone clicks it.
 */

export interface StartupScriptArgs {
  screenId: string;
  /** Staff-facing placement name, for the comments. */
  name: string;
  /** Fully-qualified URL the player opens. */
  url: string;
}

/** Safe for a Windows filename and an Edge profile directory. */
export function startupScriptFileName(screenId: string): string {
  return `tv-${screenId.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.bat`;
}

/**
 * `%` is a parameter substitution in a batch file, so a percent-encoded URL is
 * silently corrupted: `FT%3A1` becomes `FTA1`. Doubling it is the documented
 * cmd escape and renders as a single `%`.
 *
 * Callers should not be percent-encoding these URLs at all — a colon is legal
 * in a query value — but a URL is user-supplied data reaching a shell, so this
 * never trusts that.
 */
function escapeForBatch(url: string): string {
  return url.replace(/%/g, "%%");
}

export function buildStartupScript({ screenId, name, url }: StartupScriptArgs): string {
  const profile = `C:\\TV\\profile-${screenId.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
  const label = name || screenId;

  // CRLF throughout — a .bat with bare LF line endings misbehaves on older
  // Windows shells, and this file is going onto machines we will not be sitting
  // in front of.
  return [
    `@echo off`,
    `REM ============================================================`,
    `REM  FastTrax / HeadPinz lobby TV`,
    `REM  Screen : ${screenId}  (${label})`,
    `REM`,
    `REM  Put this file in  C:\\TV\\  and set it to run at sign-in (or as`,
    `REM  the Windows shell). See the admin page for the exact steps.`,
    `REM ============================================================`,
    ``,
    `title Lobby TV - ${screenId}`,
    `set "TV_URL=${escapeForBatch(url)}"`,
    `set "TV_PROFILE=${profile}"`,
    ``,
    `REM Edge lives in one of two places depending on the install. Use the`,
    `REM full path rather than trusting PATH, same as the kiosk scripts.`,
    `set "EDGE=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"`,
    `if not exist "%EDGE%" set "EDGE=C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"`,
    `if not exist "%EDGE%" (`,
    `  echo Could not find Microsoft Edge. Install it, then run this again.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    ``,
    `REM A TV and its network switch power on together. Without this wait,`,
    `REM Edge opens before DNS is up and parks on an error page all evening.`,
    `echo Waiting for network...`,
    `:waitnet`,
    `ping -n 3 1.1.1.1 >nul 2>&1`,
    `if errorlevel 1 (`,
    `  timeout /t 5 /nobreak >nul`,
    `  goto waitnet`,
    `)`,
    ``,
    `REM Edge TRUE kiosk - no address bar, no hover reveal, no chrome.`,
    `REM /wait so this script notices when Edge exits and can bring it back.`,
    `:launch`,
    `start "" /wait "%EDGE%" ^`,
    ` --kiosk "%TV_URL%" ^`,
    ` --edge-kiosk-type=fullscreen ^`,
    ` --kiosk-idle-timeout-minutes=0 ^`,
    ` --user-data-dir="%TV_PROFILE%" ^`,
    ` --no-first-run ^`,
    ` --no-default-browser-check ^`,
    ` --disable-session-crashed-bubble ^`,
    ` --hide-crash-restore-bubble ^`,
    ` --noerrdialogs ^`,
    ` --disable-infobars ^`,
    ` --disable-features=TranslateUI,msEdgeTranslate ^`,
    ` --disable-background-timer-throttling ^`,
    ` --disable-backgrounding-occluded-windows ^`,
    ` --disable-renderer-backgrounding ^`,
    ` --overscroll-history-navigation=0 ^`,
    ` --disable-pinch ^`,
    ` --autoplay-policy=no-user-gesture-required`,
    ``,
    `REM Edge exited - closed, crashed, or updated itself. Pause briefly so a`,
    `REM crash loop cannot spin the CPU, then put the screen back up.`,
    `timeout /t 5 /nobreak >nul`,
    `goto launch`,
    ``,
  ].join("\r\n");
}

/**
 * Setup instructions, kept beside the generator so the script and the steps
 * can never drift apart.
 */
export function startupInstructions(screenId: string): string[] {
  const file = startupScriptFileName(screenId);
  return [
    `Download the script from the LIVE site, not from a preview link — the URL baked into it is whichever address you downloaded it from, and a TV pointed at a preview goes dark as soon as that preview is replaced.`,
    `Create the folder C:\\TV\\ on the player PC.`,
    `Save ${file} into C:\\TV\\.`,
    `Double-click it once to check the screen comes up. Press Alt+F4 to close, then Alt+Tab out of the loop window and close it too.`,
    `To start it automatically at sign-in: press Win+R, run  regedit , go to HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run , right-click → New → String Value, name it  LobbyTV , and set its data to  C:\\TV\\${file}`,
    `For a locked-down player with no desktop at all, set the shell instead: HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon , edit the  Shell  value from  explorer.exe  to  C:\\TV\\${file} . Do this only on a machine used for nothing else — there is no Start menu afterwards, and you will need another sign-in or Safe Mode to undo it.`,
    `Also worth setting on the player: Settings → System → Power → screen and sleep both set to Never.`,
    `BRIEFING ROOM SCREENS ONLY: turn the Windows volume up and unmute it, and check the TV's own volume. The briefing video plays with sound — the launcher already allows that, but a muted player is silent with no clue why.`,
  ];
}
