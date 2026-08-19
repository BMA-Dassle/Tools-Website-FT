/**
 * The Windows startup script for a TV player. PURE — string in, string out.
 *
 * Two shapes, one flag list:
 *
 *   buildStartupScript      ONE screen on ONE player. Edge true kiosk.
 *   buildDualStartupScript  TWO screens on ONE player, one per monitor.
 *
 * Everything here is aimed at ONE failure mode: a screen that is wrong at 6pm
 * on a Saturday with nobody free to fix it. So the batch file is defensive
 * rather than clever.
 *
 *   - WAITS FOR THE NETWORK, ON EVERY LAUNCH. A TV and its switch power up
 *     together; Edge launched three seconds in lands on a connection error and
 *     sits there. The wait used to run once, above the relaunch loop, so the
 *     SECOND launch — the one after a crash, which is exactly the one that
 *     happens during an outage — skipped it entirely. It is a `call` inside the
 *     loop now.
 *   - CHECKS OUR OWN ADDRESS, not a public resolver. Pinging 1.1.1.1 proves the
 *     internet is up; it does not prove DNS resolves us, that Vercel is
 *     answering, or that the app booted. A player that can ping the world and
 *     not reach the site is precisely a player that lands on an error page.
 *   - RELAUNCHES FOREVER. If Edge is closed, crashes, or is killed by an
 *     update, the loop brings it straight back.
 *   - RECOVERS A BOARD THAT IS ALREADY DEAD. Nothing above helps a screen that
 *     is already parked on Edge's "can't reach this page": Edge has not exited,
 *     so the relaunch loop never fires, and no script of ours is running on that
 *     page to retry. So a second, minimised watchdog process watches our address
 *     and kills Edge once it comes BACK after an outage — the main loop then
 *     relaunches onto a network that is known good. That is the whole difference
 *     between a wall that heals itself and a drive to the venue (HeadPinz Fort
 *     Myers front desk, 2026-08-19).
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
 *
 * HOW IT IS STARTED IS NOT A CHOICE. Both shapes are installed the same way — as
 * the Windows SHELL, in place of explorer.exe (owner 2026-08-19, "I only want to
 * use shell method for all screens"). The Run-key alternative is gone from the
 * instructions on purpose; see shellMethodSteps for what the method is and why
 * one method beats two.
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

/** Filename for a two-monitor launcher. Names BOTH screens, because the file is
 *  specific to that pair and dropping the wrong one into C:\TV\ is how a wall
 *  ends up mirrored. */
export function dualStartupScriptFileName(leftScreenId: string, rightScreenId: string): string {
  return `tv-pair-${slug(leftScreenId)}-${slug(rightScreenId)}.bat`;
}

function slug(screenId: string): string {
  return screenId.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
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

/**
 * The flags BOTH launchers pass. One list so a fix to the single-screen script
 * cannot silently skip the two-monitor one — they were separate for one day and
 * immediately disagreed about three flags.
 *
 * How each launcher goes FULLSCREEN is deliberately not in here: kiosk mode
 * always claims the primary display, so the two-monitor launcher cannot use it.
 * See the comment at the launch line in buildDualStartupScript.
 */
const EDGE_COMMON_FLAGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--noerrdialogs",
  "--disable-infobars",
  "--disable-features=TranslateUI,msEdgeTranslate",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--overscroll-history-navigation=0",
  "--disable-pinch",
  "--autoplay-policy=no-user-gesture-required",
];

/** Lines of a `start` continuation block, one flag per line. */
function flagLines(flags: readonly string[]): string[] {
  return flags.map((f) => ` ${f} ^`);
}

/** Locate Edge, or bail with something a human can act on. */
const EDGE_LOOKUP: readonly string[] = [
  `REM Edge lives in one of two places depending on the install. Use the`,
  `REM full path rather than trusting PATH, same as the kiosk scripts.`,
  `set "EDGE=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"`,
  `if not exist "%EDGE%" set "EDGE=C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"`,
  `if not exist "%EDGE%" (`,
  `  echo Could not find Microsoft Edge. Install it, then run this again.`,
  `  pause`,
  `  exit /b 1`,
  `)`,
];

/**
 * The address the batch file checks to decide whether the network is really
 * there: our own version endpoint, which every TV already polls for
 * self-update. It touches no database and no vendor, so a 200 from it means DNS
 * resolved us, TLS completed and the app is serving — none of which a ping to a
 * public resolver can tell you.
 *
 * Returns null for a URL we cannot parse, and the batch file falls back to the
 * old ping. A launcher URL is data reaching a shell; this never assumes it is
 * well formed.
 */
function probeUrlFor(url: string): string | null {
  try {
    return new URL(url).origin + "/api/kiosk/version";
  } catch {
    return null;
  }
}

/**
 * `set "TV_PROBE=..."`, or an empty one that makes :probe fall back to ping.
 *
 * Takes every URL the launcher knows about and uses the first that parses —
 * a two-monitor player's boards are the same origin, so either will do, and
 * accepting both means one malformed side cannot cost the file its probe.
 */
function probeAssignment(...urls: string[]): string {
  for (const url of urls) {
    const probe = probeUrlFor(url);
    if (probe) return `set "TV_PROBE=${escapeForBatch(probe)}"`;
  }
  return `set "TV_PROBE="`;
}

/**
 * The two network subroutines BOTH launchers append, after the last `goto` so
 * nothing can fall into them.
 *
 * :probe    one check, errorlevel 0 when our site answered.
 * :waitnet  block until it does. CALLED FROM INSIDE THE RELAUNCH LOOP — the
 *           original wait sat above the loop, so `goto launch` skipped it and
 *           every relaunch during an outage went straight onto an error page.
 */
const NETWORK_SUBROUTINES: readonly string[] = [
  `REM -- network checks ---------------------------------------------------`,
  `REM Everything below this point is only ever reached by CALL or GOTO.`,
  ``,
  `REM One check. curl.exe ships with Windows 10 1803 and later; if it is`,
  `REM missing we fall back to pinging a public resolver, which is a weaker`,
  `REM test - it says the internet is up, not that our site is - but it beats`,
  `REM no test at all.`,
  `:probe`,
  `if not defined TV_PROBE goto probeping`,
  `where curl.exe >nul 2>&1 || goto probeping`,
  `curl.exe -s -f -o nul --max-time 10 "%TV_PROBE%"`,
  `exit /b %errorlevel%`,
  `:probeping`,
  `ping -n 3 1.1.1.1 >nul 2>&1`,
  `exit /b %errorlevel%`,
  ``,
  `REM Block until the site answers. A TV and its network switch power on`,
  `REM together, so without this Edge opens before DNS is up and parks on an`,
  `REM error page all evening - and an error page is a dead screen, because`,
  `REM Edge has not exited and the loop below never notices.`,
  `:waitnet`,
  `echo [%TIME%] checking the network...`,
  `:waitnetloop`,
  `call :probe`,
  `if errorlevel 1 (`,
  `  timeout /t 5 /nobreak >nul`,
  `  goto waitnetloop`,
  `)`,
  `goto :eof`,
];

/**
 * THE WATCHDOG THAT RECOVERS AN ALREADY-DEAD BOARD.
 *
 * Everything else here prevents a screen from reaching Edge's error page. This
 * is the only thing that gets one BACK from it: once a panel is sitting on
 * "Hmmm… can't reach this page" there is no JavaScript of ours left running to
 * retry, and the relaunch loop is blocked in `start /wait` because Edge is
 * perfectly alive.
 *
 * So a separate minimised process watches our address and kills Edge on the
 * DOWN-then-UP transition. The main loop's `start /wait` returns, :waitnet
 * confirms the network, and the board relaunches — within one minute of the
 * network coming back, with nobody at the venue.
 *
 * ON THE UP TRANSITION, NEVER WHILE DOWN. Killing Edge during the outage would
 * be strictly worse than leaving it: a screen that rode the outage out is
 * showing its last good board, and recycling it would replace that with the
 * launcher's waiting console. Two consecutive failures are required, so a single
 * slow probe cannot cost a healthy wall a blink.
 */
const NETWATCH_SECTION: readonly string[] = [
  `REM -- network watchdog (its own minimised process) ---------------------`,
  `:netwatch`,
  `title TV network watchdog`,
  `set "DOWNFOR=0"`,
  `:netwatchloop`,
  `timeout /t 60 /nobreak >nul`,
  `call :probe`,
  `if errorlevel 1 (`,
  `  set /a DOWNFOR+=1`,
  `  goto netwatchloop`,
  `)`,
  `REM Back up. If it was down for two checks running, this board may be`,
  `REM parked on Edge's error page with no way of its own to find out. Killing`,
  `REM Edge is what a person would do; the relaunch loop does the rest. It`,
  `REM takes every msedge.exe on the machine, which on a two-monitor player is`,
  `REM deliberate - both boards relaunch.`,
  `if %DOWNFOR% GEQ 2 (`,
  `  echo [%TIME%] network is back after an outage - recycling the board`,
  `  taskkill /f /im msedge.exe >nul 2>&1`,
  `)`,
  `set "DOWNFOR=0"`,
  `goto netwatchloop`,
];

/** Spawn the watchdog once, from the main path only. */
const SPAWN_NETWATCH: readonly string[] = [
  `REM Start the network watchdog in its own minimised window. It is what`,
  `REM brings this board back if it ever lands on Edge's error page.`,
  `start "TV network watchdog" /min cmd /c ""%~f0" netwatch"`,
];

export function buildStartupScript({ screenId, name, url }: StartupScriptArgs): string {
  const profile = `C:\\TV\\profile-${slug(screenId)}`;
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
    `REM  Put this file in  C:\\TV\\  and set it as the WINDOWS SHELL -- the`,
    `REM  Shell value under HKLM\\...\\Winlogon, in place of explorer.exe. That`,
    `REM  is the one method every screen on the estate uses; do not start it`,
    `REM  from a Run key instead. Full steps, including the way back out with`,
    `REM  Ctrl+Shift+Esc, are on the signage admin page.`,
    `REM ============================================================`,
    ``,
    `title Lobby TV - ${screenId}`,
    `set "TV_URL=${escapeForBatch(url)}"`,
    `set "TV_PROFILE=${profile}"`,
    probeAssignment(url),
    ``,
    `REM Watchdog re-entry - this file calls itself to watch the network. It`,
    `REM comes after the set lines above because the watchdog reads TV_PROBE.`,
    `if /I "%~1"=="netwatch" goto netwatch`,
    ``,
    ...EDGE_LOOKUP,
    ``,
    ...SPAWN_NETWATCH,
    ``,
    `REM Edge TRUE kiosk - no address bar, no hover reveal, no chrome.`,
    `REM /wait so this script notices when Edge exits and can bring it back.`,
    `REM`,
    `REM THE NETWORK CHECK IS INSIDE THE LOOP. It used to sit above :launch, so`,
    `REM a relaunch skipped it - and a relaunch during an outage is exactly the`,
    `REM case it exists for.`,
    `:launch`,
    `call :waitnet`,
    `start "" /wait "%EDGE%" ^`,
    ` --kiosk "%TV_URL%" ^`,
    ` --edge-kiosk-type=fullscreen ^`,
    ` --kiosk-idle-timeout-minutes=0 ^`,
    ` --user-data-dir="%TV_PROFILE%" ^`,
    ...flagLines(EDGE_COMMON_FLAGS).slice(0, -1),
    ` ${EDGE_COMMON_FLAGS[EDGE_COMMON_FLAGS.length - 1]}`,
    ``,
    `REM Edge exited - closed, crashed, or updated itself. Pause briefly so a`,
    `REM crash loop cannot spin the CPU, then put the screen back up.`,
    `timeout /t 5 /nobreak >nul`,
    `goto launch`,
    ``,
    ...NETWORK_SUBROUTINES,
    ``,
    ...NETWATCH_SECTION,
    ``,
  ].join("\r\n");
}

export interface DualScreenSide {
  screenId: string;
  name: string;
  url: string;
}

/**
 * TWO screens on ONE player PC, one per monitor.
 *
 * The left/right assignment comes from the screens' PAIRING GROUP (position 0
 * is left), so the wall's layout is data, not a hand-edited file. Everything
 * about how it reaches fullscreen was settled by measurement on real hardware —
 * see the block comment at the launch line, and do not "simplify" it back to
 * any of the three approaches listed there as failures.
 */
export function buildDualStartupScript({
  left,
  right,
}: {
  left: DualScreenSide;
  right: DualScreenSide;
}): string {
  const monitorProbe =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "$a=[System.Windows.Forms.Screen]::AllScreens; $l=$a[0].Bounds; $r=$a[0].Bounds; " +
    "foreach($s in $a){ if($s.Bounds.X -lt $l.X){$l=$s.Bounds}; if($s.Bounds.X -gt $r.X){$r=$s.Bounds} }; " +
    "($a.Count,$l.X,$l.Y,$l.Width,$l.Height,$r.X,$r.Y,$r.Width,$r.Height) -join [char]44";

  return [
    `@echo off`,
    `REM ============================================================`,
    `REM  FastTrax / HeadPinz signage - ONE player PC, TWO monitors`,
    `REM`,
    `REM     ${left.screenId} (${left.name || left.screenId})  ->  LEFT  monitor`,
    `REM     ${right.screenId} (${right.name || right.screenId})  ->  RIGHT monitor`,
    `REM`,
    `REM  Put this file in  C:\\TV\\  and set it as the WINDOWS SHELL -- the Shell`,
    `REM  value under HKLM\\...\\Winlogon, in place of explorer.exe. Same method as`,
    `REM  every other screen. Setup steps are at the bottom of this file, and on`,
    `REM  the signage admin page.`,
    `REM`,
    `REM  Which screen goes on which monitor comes from the two screens' PAIRING`,
    `REM  GROUP on the admin page (position 0 is the left monitor). Change the`,
    `REM  group there and download this file again rather than editing it.`,
    `REM ============================================================`,
    ``,
    `setlocal EnableExtensions`,
    ``,
    `REM Our own address, for every network check in this file. Set BEFORE the`,
    `REM re-entry dispatch because both re-entries read it.`,
    probeAssignment(left.url, right.url),
    ``,
    `REM Re-entry - this file calls itself twice: once to babysit the second`,
    `REM board, and once to watch the network.`,
    `if /I "%~1"=="watch" goto watch`,
    `if /I "%~1"=="netwatch" goto netwatch`,
    ``,
    `title Signage pair - ${left.screenId} + ${right.screenId}`,
    ``,
    `REM -- which board goes where ------------------------------------------`,
    `set "LEFT_URL=${escapeForBatch(left.url)}"`,
    `set "LEFT_LABEL=${(left.name || left.screenId).replace(/[<>|&^]/g, "")}"`,
    `set "LEFT_SLOT=${slug(left.screenId)}"`,
    `set "RIGHT_URL=${escapeForBatch(right.url)}"`,
    `set "RIGHT_LABEL=${(right.name || right.screenId).replace(/[<>|&^]/g, "")}"`,
    `set "RIGHT_SLOT=${slug(right.screenId)}"`,
    ``,
    `REM If the boards come up on the wrong sides, set this to 1 and rerun.`,
    `REM Windows decides which monitor is "first"; the cable order does not.`,
    `set "SWAP_SIDES=0"`,
    ``,
    ...EDGE_LOOKUP,
    ``,
    ...SPAWN_NETWATCH,
    ``,
    `REM -- refuse to be mysterious about the sign-in wall -------------------`,
    `REM If this PC forces Edge sign-in, every board shows "Your admin needs you`,
    `REM to sign in" instead of the screen, and nothing on the wall says why.`,
    `set "EDGE_SIGNIN="`,
    `for /f "tokens=3" %%V in ('reg query "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v BrowserSignin 2^>nul') do set "EDGE_SIGNIN=%%V"`,
    `if /I "%EDGE_SIGNIN%"=="0x2" (`,
    `  echo.`,
    `  echo *** THIS PC FORCES EDGE SIGN-IN ^(BrowserSignin=0x2^).`,
    `  echo *** The boards will show "Your admin needs you to sign in" instead of`,
    `  echo *** the screen. Guest and InPrivate do NOT get round it. See step 0 in`,
    `  echo *** the notes at the bottom of this file.`,
    `  echo.`,
    `  echo *** Carrying on anyway in case the profiles are already signed in.`,
    `  echo.`,
    `)`,
    ``,
    `REM -- read the monitor layout -----------------------------------------`,
    `REM Leftmost and rightmost screens by their X coordinate, so this file needs`,
    `REM no editing when a monitor is replaced with a different size. No pipe in`,
    `REM the probe: a ^| inside a for /f backquote reaches PowerShell literally`,
    `REM and the whole thing falls back to hardcoded guesses.`,
    `set "MON_COUNT="`,
    `for /f "usebackq tokens=1-9 delims=," %%A in (\`powershell -NoProfile -ExecutionPolicy Bypass -Command "${monitorProbe}"\`) do (`,
    `  set "MON_COUNT=%%A"`,
    `  set "LX=%%B"`,
    `  set "LY=%%C"`,
    `  set "LW=%%D"`,
    `  set "LH=%%E"`,
    `  set "RX=%%F"`,
    `  set "RY=%%G"`,
    `  set "RW=%%H"`,
    `  set "RH=%%I"`,
    `)`,
    ``,
    `if not defined MON_COUNT (`,
    `  echo Could not read the monitor layout - assuming two 1920x1080 screens side by side.`,
    `  set "MON_COUNT=2"`,
    `  set "LX=0"`,
    `  set "LY=0"`,
    `  set "LW=1920"`,
    `  set "LH=1080"`,
    `  set "RX=1920"`,
    `  set "RY=0"`,
    `  set "RW=1920"`,
    `  set "RH=1080"`,
    `)`,
    ``,
    `if %MON_COUNT% LSS 2 (`,
    `  echo.`,
    `  echo *** WARNING: only %MON_COUNT% monitor detected. Both boards will open on it,`,
    `  echo *** one on top of the other. Plug the second monitor in, extend the desktop`,
    `  echo *** ^(Win+P - Extend, not Duplicate^), then close this window and rerun.`,
    `  echo.`,
    `)`,
    ``,
    `echo Monitors: %MON_COUNT%   left %LW%x%LH% at %LX%,%LY%   right %RW%x%RH% at %RX%,%RY%`,
    ``,
    `if "%SWAP_SIDES%"=="1" (`,
    `  echo SWAP_SIDES is on - the two boards trade monitors.`,
    `  call :spawn "%RIGHT_LABEL%" "%RIGHT_URL%" "%LX%" "%LY%" "%LW%" "%LH%" "%RIGHT_SLOT%"`,
    `  set "TV_X=%RX%"`,
    `  set "TV_Y=%RY%"`,
    `  set "TV_W=%RW%"`,
    `  set "TV_H=%RH%"`,
    `) else (`,
    `  call :spawn "%RIGHT_LABEL%" "%RIGHT_URL%" "%RX%" "%RY%" "%RW%" "%RH%" "%RIGHT_SLOT%"`,
    `  set "TV_X=%LX%"`,
    `  set "TV_Y=%LY%"`,
    `  set "TV_W=%LW%"`,
    `  set "TV_H=%LH%"`,
    `)`,
    `set "TV_LABEL=%LEFT_LABEL%"`,
    `set "TV_URL=%LEFT_URL%"`,
    `set "TV_SLOT=%LEFT_SLOT%"`,
    ``,
    `REM This console becomes the LEFT-hand board's own watchdog, so there is`,
    `REM exactly one visible window to read when something is wrong.`,
    `goto run`,
    ``,
    `REM -- spawn the other board in its own minimised watchdog -------------`,
    `:spawn`,
    `start "%~1" /min cmd /c ""%~f0" watch "%~1" "%~2" "%~3" "%~4" "%~5" "%~6" "%~7""`,
    `goto :eof`,
    ``,
    `REM -- watchdog re-entry -----------------------------------------------`,
    `:watch`,
    `set "TV_LABEL=%~2"`,
    `set "TV_URL=%~3"`,
    `set "TV_X=%~4"`,
    `set "TV_Y=%~5"`,
    `set "TV_W=%~6"`,
    `set "TV_H=%~7"`,
    `set "TV_SLOT=%~8"`,
    `title TV - %TV_LABEL%`,
    ``,
    `REM -- launch, and keep it up forever ----------------------------------`,
    `:run`,
    `REM Its own Edge profile per board. This is load-bearing, not tidiness: two`,
    `REM windows sharing a profile means the second launch just hands its URL to`,
    `REM the first instance and every window flag is ignored - both boards end up`,
    `REM on one monitor.`,
    `set "TV_PROFILE=C:\\TV\\profile-%TV_SLOT%"`,
    ``,
    `:launch`,
    `REM THE NETWORK CHECK IS INSIDE THE LOOP, and both boards reach it - the`,
    `REM watchdog re-entry lands on :run, which falls into :launch. It used to`,
    `REM sit above the loop, so a relaunch skipped it, which is exactly the case`,
    `REM it exists for.`,
    `call :waitnet`,
    `echo [%TIME%] %TV_LABEL% at %TV_X%,%TV_Y% (%TV_W%x%TV_H%)`,
    `REM Two flags do the whole job, and BOTH matter:`,
    `REM`,
    `REM   --window-position puts the window on its monitor. Confirmed on the real`,
    `REM   two-monitor player: the board landed on the right screen first try.`,
    `REM`,
    `REM   --start-fullscreen fullscreens it with no title bar and no address bar,`,
    `REM   and needs no focus, no keystrokes and no foreground rights to do it.`,
    `REM`,
    `REM THREE THINGS THAT DO NOT WORK - none of these are worth retrying:`,
    `REM`,
    `REM   --app=URL. Edge IGNORES --start-fullscreen for app windows, so the`,
    `REM   board is placed correctly and keeps a title bar with the min/max/close`,
    `REM   buttons across the top of the wall (owner 2026-08-14).`,
    `REM`,
    `REM   --kiosk. It fullscreens cleanly but is reported to claim the PRIMARY`,
    `REM   display regardless of --window-position, which puts both boards on one`,
    `REM   monitor. That is why the single-screen launcher uses it and this one`,
    `REM   cannot.`,
    `REM`,
    `REM   Sending F11 with SendKeys after launch. F11 only reaches the FOREGROUND`,
    `REM   window, and Windows refuses SetForegroundWindow to a process that does`,
    `REM   not already own the foreground - which is every script autostarted at`,
    `REM   sign-in. Measured: activation failed 12 times out of 12 for the second`,
    `REM   board, and the stray F11 landed on the FIRST board and knocked it back`,
    `REM   out of fullscreen.`,
    `start "" /wait "%EDGE%" ^`,
    ` --start-fullscreen ^`,
    ` --window-position=%TV_X%,%TV_Y% ^`,
    ` --window-size=%TV_W%,%TV_H% ^`,
    ` --user-data-dir="%TV_PROFILE%" ^`,
    ...flagLines(EDGE_COMMON_FLAGS),
    ` "%TV_URL%"`,
    ``,
    `REM Edge exited - closed, crashed, or updated itself. Pause briefly so a`,
    `REM crash loop cannot spin the CPU, then put the board back up.`,
    `timeout /t 5 /nobreak >nul`,
    `goto launch`,
    ``,
    ...NETWORK_SUBROUTINES,
    ``,
    ...NETWATCH_SECTION,
    ``,
    `REM ============================================================`,
    `REM  SETUP ON THE PLAYER PC`,
    `REM`,
    ...dualStartupInstructions(left.screenId, right.screenId).map((s) => `REM  ${s}`),
    `REM ============================================================`,
    ``,
  ].join("\r\n");
}

/**
 * Setup instructions, kept beside the generator so the script and the steps
 * can never drift apart.
 */
/**
 * THE SHELL METHOD — the one way we start a signage player (owner 2026-08-19,
 * "I only want to use shell method for all screens").
 *
 * The launcher REPLACES explorer.exe as the Windows shell, rather than being
 * started by a Run key alongside a normal desktop. One method for every screen
 * on the estate, single-screen and two-monitor alike, because:
 *
 *   - THERE IS NO DESKTOP TO LEAK. No taskbar creeping up the bottom of the
 *     wall, no notification balloons over a guest-facing board, no Start menu
 *     for a passer-by to open.
 *   - THE BOARD IS THE SESSION. With no explorer to come back to, a killed Edge
 *     has nowhere to fall back TO except the launcher's own relaunch loop.
 *   - IT IS ONE SET OF STEPS TO TEACH. Two methods meant two ways for a player
 *     to be half-configured, and the Run-key one silently produced a desktop
 *     behind the board that only showed itself when Edge crashed.
 *
 * The trade is real and stated in the steps: no Start menu, and undoing it needs
 * Task Manager. Task Manager is the escape hatch and it is load-bearing —
 * Ctrl+Shift+Esc is handled by Windows itself, not by the shell, so it still
 * opens on a machine whose shell is a batch file. Anyone touching one of these
 * players needs to know that before they set the value, not after.
 *
 * Shared by both launchers so the steps cannot drift apart, and parameterised by
 * the file path only — everything else about the method is identical.
 */
function shellMethodSteps(fullPath: string): string[] {
  return [
    `LEARN THE WAY OUT FIRST: Ctrl+Shift+Esc opens Task Manager even with no desktop — Windows handles that key, not the shell. From there, More details → File → Run new task gets you  explorer.exe  (a temporary desktop) or  regedit . That is how you undo everything below, so do not set the shell until you have opened Task Manager on this PC once and seen it work.`,
    `Set the launcher AS THE WINDOWS SHELL. Win+R → regedit → HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon → double-click  Shell  and change  explorer.exe  to  ${fullPath}  — this needs an administrator, and it applies to every user who signs in on this PC, so only do it on a machine used for nothing but this screen.`,
    `Make the PC sign itself in, or a reboot leaves the wall on the lock screen with the launcher never started. Win+R → netplwiz → untick "Users must enter a user name and password", then enter the password twice. If that tick-box is missing, set  HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PasswordLess\\Device → DevicePasswordLessBuildVersion  to  0  and reopen netplwiz.`,
    `Reboot, and watch the whole way up. The screen should go from the Windows logo straight to the board with no desktop in between. That reboot IS the test — a shell that only works when you double-click it is not configured.`,
    `TO UNDO IT: Ctrl+Shift+Esc → File → Run new task → regedit → set that same  Shell  value back to  explorer.exe , then reboot. If the shell is broken badly enough that Task Manager will not open, boot Safe Mode (hold Shift while choosing Restart) — explorer runs there regardless of the value.`,
  ];
}

export function startupInstructions(screenId: string): string[] {
  const file = startupScriptFileName(screenId);
  return [
    `Download the script from the LIVE site, not from a preview link — the URL baked into it is whichever address you downloaded it from, and a TV pointed at a preview goes dark as soon as that preview is replaced.`,
    `Create the folder C:\\TV\\ on the player PC and save ${file} into it.`,
    `Double-click it once, WHILE THE DESKTOP STILL WORKS, and check the screen comes up. Press Alt+F4 to close Edge, then close BOTH console windows — the visible loop window and the minimised "TV network watchdog" one on the taskbar. Do not skip this — the next step removes the desktop you would fix a broken script from.`,
    `Settings → System → Power: set screen and sleep BOTH to Never.`,
    `The minimised "TV network watchdog" window is meant to be there. It checks this site once a minute and, if the network has been down and comes back, it restarts the board — which is how a screen that landed on Edge's "can't reach this page" gets itself back without anyone driving out. Do not close it.`,
    ...shellMethodSteps(`C:\\TV\\${file}`),
    `BRIEFING ROOM SCREENS ONLY: turn the Windows volume up and unmute it, and check the TV's own volume. The briefing video plays with sound — the launcher already allows that, but a muted player is silent with no clue why.`,
  ];
}

/**
 * Setup steps for a two-monitor player. Step 0 is first because the boards
 * cannot come up at all without it on a managed PC.
 */
export function dualStartupInstructions(leftScreenId: string, rightScreenId: string): string[] {
  const file = dualStartupScriptFileName(leftScreenId, rightScreenId);
  return [
    `0. THIS PC MUST NOT FORCE EDGE SIGN-IN. Check it first, because the boards cannot come up without it:   reg query "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v BrowserSignin   — if that returns 2, the org policy is "force users to sign in to use the browser" and every ordinary Edge window shows "Your admin needs you to sign in" instead of the board. Guest and InPrivate do NOT get round it: BrowserSignin=2 makes guest mode unavailable, and this estate also disables InPrivate, so both flags are accepted and then silently ignored.`,
    `0b. Clear it either by having whoever manages Intune/GPO exclude this player (preferred — a signage PC has no business holding a work identity), or by signing both boards' Edge profiles in ONCE by hand. With admin, and only if the policy is not being re-pushed:   reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge" /v BrowserSignin /t REG_DWORD /d 0 /f   — this needs an elevated prompt; a normal one fails with "Access is denied".`,
    `1. Extend the desktop across both monitors: Win+P → Extend. Duplicate shows the same board twice.`,
    `2. Set display scaling to 100% on BOTH monitors (Settings → System → Display → Scale). Scaling shifts the window coordinates and a board can land half off the screen.`,
    `3. Download this script from the LIVE site, not a preview link — the URLs baked into it are whichever address you downloaded it from.`,
    `4. Create C:\\TV\\ and save ${file} into it.`,
    `5. Double-click it once, WHILE THE DESKTOP STILL WORKS. ${leftScreenId} should fill the left monitor and ${rightScreenId} the right. If they are swapped, set SWAP_SIDES=1 near the top of the file and rerun — Windows decides which monitor is "first", and the cable order does not. Get this right before step 7, which takes the desktop away.`,
    `6. Settings → System → Power: screen and sleep both set to Never.`,
    `7. Now set it as the shell — the same method every screen on the estate uses. The steps are below, and the path is  C:\\TV\\${file}`,
    ...shellMethodSteps(`C:\\TV\\${file}`).map((s, i) => `7.${i + 1} ${s}`),
    `To close everything while you are still testing: click a board, press Alt+F4 on each, then close ALL THREE console windows — the visible one and the two minimised on the taskbar (the second board's watchdog and "TV network watchdog"). Otherwise the watchdogs bring the boards straight back. Once the shell is set there is no taskbar, so use Ctrl+Shift+Esc and end the cmd.exe tasks instead.`,
    `The "TV network watchdog" window is meant to be there. It checks this site once a minute and, if the network has been down and comes back, it restarts BOTH boards — which is how screens that landed on Edge's "can't reach this page" get themselves back without anyone driving out. Do not close it.`,
  ];
}
