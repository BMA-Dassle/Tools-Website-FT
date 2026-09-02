"use client";

/**
 * A SCENE THAT THROWS MUST NOT REBOOT THE WALL.
 *
 * There was exactly one error boundary in this app, at the route (app/tv/error.tsx),
 * so any exception from any scene took the whole panel down and reloaded it. On a
 * single screen that is a blink. On the front-desk wall it is five TVs going dark
 * together and coming back through the boot loader, in the lobby, at the moment a
 * guest just finished at a kiosk — which is precisely what happened (owner
 * 2026-09-01: "when a kiosk reservation checked in the welcome crashed all the
 * screens and they rebooted").
 *
 * The blast radius was wrong. A celebration is ONE SCENE of a rotation; if it cannot
 * render, the honest answer is to show something else for eight seconds, not to
 * destroy a working page — the page is also running the pricing board, the check-in
 * list, the cached films and the phase lock, none of which were broken.
 *
 * So each frame gets its own boundary, and a scene that throws is skipped FOR THAT
 * FRAME ONLY:
 *
 *   THE PANEL KEEPS SELLING. The fallback is house advertising, the same floor every
 *   other degraded path in this surface falls to.
 *
 *   THE NEXT SCENE GETS A CLEAN ATTEMPT. The failure is remembered against the frame
 *   key, so it clears the moment the wall moves on. A scene broken by one particular
 *   event does not poison the rotation behind it.
 *
 *   IT NAMES ITSELF. The scene name goes to the server with the stack, which is the
 *   thing the route boundary could never say — see crash-log.server.ts.
 *
 * The route boundary stays exactly as it is. It is now the backstop for what it was
 * always meant for — a throw in the shell itself, outside any scene — rather than
 * the first line of defence against ordinary scene bugs.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportCrash } from "../crash-report";

interface Props {
  /** Changes when the wall cuts. A new frame clears any previous failure. */
  frameKey: string;
  /** For the crash report, and for deciding whether the fallback is safe. */
  scene: string;
  /** What to show instead — house ads, except when ads are what threw. */
  fallback: ReactNode;
  children: ReactNode;
}

interface State {
  crashed: boolean;
  /** The key the current `crashed` verdict belongs to. */
  forKey: string | null;
}

export class SceneBoundary extends Component<Props, State> {
  state: State = { crashed: false, forKey: null };

  /**
   * Clear the verdict when the frame changes.
   *
   * Runs before every render INCLUDING the re-render React performs after a
   * child throws — at which point the key has not changed, so the `crashed`
   * flag set below survives to be read by render().
   */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.frameKey === state.forKey) return null;
    return { crashed: false, forKey: props.frameKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Nobody is at the wall to read a console; this is the only record there is.
    console.error(`[tv] scene "${this.props.scene}" threw`, error, info.componentStack);
    reportCrash({ error, scene: this.props.scene, origin: "scene" });
  }

  render() {
    if (!this.state.crashed) return this.props.children;
    // If HOUSE ADS are the thing that threw, rendering house ads as the fallback
    // would throw again inside this boundary's own render and escape to the route
    // boundary — turning the one failure this cannot absorb into the reboot it
    // exists to prevent. The venue ground is the floor beneath the floor.
    if (this.props.scene === "ads") {
      return <div aria-hidden style={{ position: "absolute", inset: 0, background: "#000418" }} />;
    }
    return this.props.fallback;
  }
}
