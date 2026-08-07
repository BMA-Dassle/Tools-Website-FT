"use client";

/**
 * The first-party mobile waiver flow (/waiver). Mounts the shared WaiverParty
 * (KioskPartyManager) in mobile theme with the guardian-signs-for-minor chain
 * ON — the kiosk players section, on a phone. Two modes:
 *
 *   Standalone (/waiver?c=)         — a guest adds their family and signs; the
 *                                     waiver is on file for their visit.
 *   Reservation-scoped (…&loc=&pid=) — signatures ATTACH to a specific BMI
 *                                     reservation (a group-event contract or a
 *                                     web booking), with a lean event-info header
 *                                     and a Text/Email/Copy/Share block so the
 *                                     organizer can forward the link to the whole
 *                                     party WITHOUT exposing the confirmation,
 *                                     prices or payments. An ONLINE booking's link
 *                                     DOES show the party, redacted to a given name
 *                                     plus one initial — the ShareBlock disclosure
 *                                     says so, and must stay true to the payload.
 *
 * Standalone brand comes from the host (x-brand); center from ?c=. Reservation
 * mode derives center + Pandora location from the authoritative locationId.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  IconCheck,
  IconChevronRight,
  IconLink,
  IconMail,
  IconMessage,
  IconShare2,
} from "@tabler/icons-react";
import type { Brand, CenterCode } from "~/features/booking/types";
import type { PartyMember } from "~/features/booking/state/types";
import { KioskPartyManager, peopleReady } from "~/features/kiosk/components/KioskPartyManager";
import { BrandLogo } from "~/features/kiosk/components/BrandLogo";
import { BrandedLoader } from "~/features/kiosk/components/BrandedLoader";
import { useReservationJoinAttach } from "./attach/reservation-join";
import type { WaiverRosterEntry } from "./roster";
import {
  addMemberSupersedingPreload,
  coveredPersonIds,
  isPreloadedMember,
  membersOwnedHere,
  mergeRosterIntoParty,
  reservationWaiverStatus,
  waiverProgress,
  type ReservationWaiverStatus,
} from "./roster-preload";
import { MobileWaiverPhoto } from "./MobileWaiverPhoto";

type PandoraLocation = "fasttrax" | "headpinz" | "naples";

/** Reservation mode: locationId is authoritative for center + Pandora location
 *  (467486 = FastTrax FM, 332160 = HeadPinz FM, 332145 = HeadPinz Naples). */
function locationInfo(locationId: number): { center: CenterCode; pandora: PandoraLocation } {
  if (locationId === 332145) return { center: "naples", pandora: "naples" };
  if (locationId === 332160) return { center: "fort-myers", pandora: "headpinz" };
  return { center: "fort-myers", pandora: "fasttrax" };
}

/** Standalone: center-first Pandora location (a Naples waiver records at Naples,
 *  never HP Fort Myers — the 2026-07-20 misroute class). */
function pandoraLocationFor(brand: Brand, center: CenterCode): PandoraLocation {
  if (center === "naples") return "naples";
  return brand === "headpinz" ? "headpinz" : "fasttrax";
}

function standaloneCenterName(brand: Brand, center: CenterCode): string {
  if (center === "naples") return "HeadPinz Naples";
  return brand === "headpinz" ? "HeadPinz Fort Myers" : "FastTrax Fort Myers";
}

interface WaiverContextSummary {
  label: string;
  activity: string | null;
  whenLabel: string;
  centerName: string;
  /** Registered on the reservation (BMI projectPersons). */
  total: number;
  /** Of those, how many hold a currently-valid waiver — the authoritative count
   *  across everyone's devices, not just this phone's roster. */
  signed?: number;
  /**
   * WHO is on the booking, redacted to "Ann A." + per-person waiver validity.
   * Present ONLY for an ONLINE booking (racing / laser / gel) whose Pandora sweep
   * landed inside the route's deadline; ABSENT for a group function (a contract
   * party returns through the contract confirmation page) and ABSENT on a sweep
   * miss (`signed` is absent then too — the route never ships rows with validity
   * guessed `false`, which would tell signed guests to sign again).
   *
   * Gate the preload on THIS field, never on `signed`: a group function returns
   * `signed` with no roster. `[]` is a real answer (an online booking with an
   * empty persons_list) and is distinct from `undefined`.
   */
  roster?: WaiverRosterEntry[];
  /**
   * The SHORT sign-only link the Share sheet hands out (`/w/{code}`), minted
   * server-side. Absent for a standalone visit (no reservation to attach to) and on
   * a mint failure — ShareBlock falls back to the page URL, which is the long
   * sign-only form, so sharing always works.
   *
   * Never the organizer link. Sharing must not be able to pass on the roster.
   */
  shareUrl?: string;
  /**
   * True when this visitor arrived on the ORGANIZER code for this reservation (the
   * `/w/{code}` cookie, resolved against the stored row). It is the same condition
   * the route uses to decide whether to send `roster` at all, so it is a UI hint,
   * not a permission — the server has already withheld anything it should.
   */
  canManage?: boolean;
}

/** Kiosk flow-head, phone scale: logo + activity label, then the signed-progress
 *  bar, then the k-display title — the same reading order as KioskFlow. */
function WaiverHead({
  brand,
  subtitle,
  signed,
  total,
}: {
  brand: Brand;
  subtitle: string;
  signed: number;
  total: number;
}) {
  return (
    <header className="mb-5">
      <div className="k-fh-top">
        <BrandLogo brand={brand} className="h-[36px] w-auto" alt={`${brandName(brand)} home`} />
        <span className="k-fh-activity">Waiver</span>
      </div>
      {/* Only meaningful for a GROUP. With one person "1 of 1 signed" under a full
          cyan bar reads as a completed loading bar, not as progress. */}
      {total > 1 && (
        <>
          <div className="k-prog" role="presentation">
            {Array.from({ length: total }, (_, i) => (
              <span key={i} className={i < signed ? "done" : ""} />
            ))}
          </div>
          <div className="k-prog-label k-num" aria-live="polite">
            {signed} of {total} signed
          </div>
        </>
      )}
      <h1 className="k-display k-fh-title">Sign your waiver</h1>
      <p className="mt-1 text-sm text-[var(--k-dim)]">{subtitle}</p>
    </header>
  );
}

function brandName(brand: Brand): string {
  return brand === "headpinz" ? "HeadPinz" : "FastTrax";
}

/** The ONE place a counted remainder is put into words. Reached only through
 *  `groupWaiverLine`, which is what actually keeps the ready card and the terminal
 *  card from wording the same reservation differently — saying so here was not
 *  enough on its own, and they drifted anyway. Module scope, not a render-body const
 *  (a helper called from an earlier closure is a TDZ ReferenceError tsc misses). */
function stillNeedWaiverLine(n: number): string {
  return n === 1
    ? "1 more person on this reservation still needs a waiver."
    : `${n} more people on this reservation still need a waiver.`;
}

/**
 * The ONE group-wide sentence either card may add. Both read it from the same
 * status, so the ready card and the terminal card can never describe the same
 * reservation differently — and neither can go SILENT about people who are still
 * outstanding, which is how a device-scoped "You're all set" ended up implying a
 * booking was finished.
 *
 * `null` — nothing to say — is reachable from exactly two places: standalone (no
 * reservation, so nobody is outside the party on screen) and `covered` (the booking
 * really is done, and the ready card's headline already says so). Silence anywhere
 * else would be a completion claim by omission.
 */
function groupWaiverLine(status: ReservationWaiverStatus | null): string | null {
  if (!status || status.kind === "covered") return null;
  if (status.kind === "unknown") {
    // No number, and no claim in either direction — an invitation is the only thing
    // that is true when we cannot see the rest of the booking.
    return "If anyone else on the booking hasn't signed, they can sign from this link.";
  }
  return status.count === null
    ? "Other people on this reservation still need a waiver."
    : stillNeedWaiverLine(status.count);
}

/** May this page state that every waiver on the booking is signed? ONLY from the
 *  authoritative reservation status — `covered` — or standalone (`null`), where the
 *  `ready` gate has already proven every person on screen is covered and there is no
 *  reservation to speak for. Never from this device's rows (invariant 6). */
function mayClaimAllSigned(status: ReservationWaiverStatus | null): boolean {
  return status === null || status.kind === "covered";
}

export function WaiverFlow({
  brand,
  initialCenter,
  reservation,
}: {
  brand: Brand;
  initialCenter: CenterCode | null;
  reservation?: { locationId: number; projectId: string } | null;
}) {
  const resInfo = reservation ? locationInfo(reservation.locationId) : null;

  // Standalone: FastTrax host is Fort Myers; a HeadPinz visitor with no ?c picks
  // their center. Reservation mode derives center from locationId (below).
  const [standaloneCenter, setStandaloneCenter] = useState<CenterCode | null>(
    brand === "fasttrax" ? "fort-myers" : initialCenter,
  );
  const [party, setParty] = useState<PartyMember[]>([]);
  const [ctx, setCtx] = useState<WaiverContextSummary | null>(null);
  // True once the context fetch has RESOLVED (either way). Until then a
  // reservation link shows the branded loader instead of an empty party over
  // "N registered" — a production load sat for a long moment with no loading
  // indication at all (owner 2026-07-31). On failure the flow renders exactly
  // as before: the header is best-effort, signing works without it.
  const [ctxSettled, setCtxSettled] = useState(false);
  // Terminal state after "I'm done". The roster is cleared then, so both facts the
  // card states are FROZEN at that moment: the first names of what this device
  // filed (no DOB, no phone, no last names) and where the RESERVATION stood.
  // Recomputing either from `party` after the wipe would report "0 waivers on file"
  // — and, worse, an empty party has no unsigned rows left to contradict a
  // "nobody else to sign" reading of the card (roster-preload.ts invariant 6).
  const [finished, setFinished] = useState<{
    names: string[];
    status: ReservationWaiverStatus | null;
  } | null>(null);
  // Member ids whose waiver was signed ON THIS DEVICE. The completion gate is
  // scoped to what this phone is responsible for, and for a guest who arrived on a
  // forwarded link that is exactly "the preloaded rows I signed" — their own row
  // keeps its `res:` id, so nothing else distinguishes it from the seven strangers
  // beside it. See roster-preload.ts invariant 4.
  const [signedHere, setSignedHere] = useState<ReadonlySet<string>>(() => new Set<string>());
  // NOTE: the licence-grant collection that used to live here was removed with
  // the hidden offer (see the terminal card). It was a
  // `ReadonlyMap<personId, grant>` kept ACROSS the "I'm done" wipe for the same
  // reason `carriedCovered` is. Nothing else consumed it, so it is dead state
  // while the offer is hidden — the SERVER still mints a grant on every
  // signature and `licence-grant.ts` / the offer endpoints are untouched, so
  // restoring is re-adding this state plus the six-line collector in
  // `onWaiverSigned`.
  // Person ids this device has PROVEN covered, kept ACROSS the "I'm done" wipe.
  // While the rows are on screen `party` proves it; the wipe destroys them on
  // purpose, and the roster is never re-seeded, so this is all that is left to stop
  // the outstanding count creeping back up on the next person in line (they would be
  // told to sign the waiver this phone just filed). Ids only — no names, no dates.
  const [carriedCovered, setCarriedCovered] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Signer-only guardians: adults who signed for a minor but are NOT playing.
  // Kept OUT of `party`, exactly as the kiosk keeps them out of session.party, so
  // they never reach the reservation attach or any purchase path. "Join the fun"
  // moves the same object (same id) onto the roster so minors' refs stay valid.
  const [guardians, setGuardians] = useState<PartyMember[]>([]);

  const center: CenterCode | null = resInfo ? resInfo.center : standaloneCenter;
  const location: PandoraLocation | null = resInfo
    ? resInfo.pandora
    : center
      ? pandoraLocationFor(brand, center)
      : null;

  // Reservation mode: fetch the lean, PII-safe event-info header (+ the roster for
  // an online booking).
  //
  // POLLED, not one-shot. The server omits `signed` (and with it the roster) when
  // its Pandora sweep misses the deadline — which reliably happens on the FIRST
  // request after Azure has gone cold (the kiosk prewarns for the same reason).
  // The server re-sweeps on every request until one lands, but a page that asks
  // once inherits whatever the unlucky first request got: an organizer staring at
  // "6 registered" over an empty list, fixed by a manual reload ("second time
  // going to the page it's there" — owner 2026-07-31). So while the response
  // carries no `signed`, keep asking on a short interval — each retry warms
  // Pandora's per-person cache further, so one of them lands — and give up after
  // CTX_MAX_ATTEMPTS rather than poll a genuinely broken backend forever. The
  // loader stays up during the retries (see ctxSettled), which is exactly what it
  // is for.
  useEffect(() => {
    if (!reservation || !center) return;
    let cancelled = false;
    const CTX_MAX_ATTEMPTS = 5;
    const CTX_RETRY_DELAY_MS = 2_500;
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void (async () => {
      try {
        for (let attempt = 1; attempt <= CTX_MAX_ATTEMPTS && !cancelled; attempt++) {
          if (attempt > 1) await delay(CTX_RETRY_DELAY_MS);
          if (cancelled) return;
          const res = await fetch(
            `/api/waiver/context?c=${center}&loc=${reservation.locationId}&pid=${reservation.projectId}`,
            { cache: "no-store" },
          );
          // res.json() is safe for the roster's 17-digit person ids because the route
          // serializes every one as a JSON *string* — pinned by its own wire test
          // (`"personId":"51383608123456789"`). The BMI precision rule bites on
          // unquoted numeric ids; do NOT "simplify" that serialization.
          const data = await res.json();
          if (cancelled) return;
          if (res.ok && data.ok) {
            setCtx(data as WaiverContextSummary);
            // `signed` present ⇒ the sweep landed; the roster (organizer, online
            // booking) rode the same result. Absent ⇒ sweep missed — retry.
            if (data.signed !== undefined) return;
          }
        }
      } catch {
        /* header is best-effort — the sign flow works without it */
      } finally {
        if (!cancelled) setCtxSettled(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation, center]);

  // ONLINE booking (racing / laser / gel): seed the party from the reservation's
  // roster so the guest sees who is on the booking — and who still needs a waiver
  // — instead of "3 of 8 registered" over an empty list and a demand to retype
  // eight people (owner 2026-07-30). A group function sends no roster and behaves
  // exactly as it did before.
  //
  // ONCE, deliberately: from here the party is the guest's working set. They add
  // people, sign, promote a guardian, and "I'm done" CLEARS the roster off a phone
  // that gets handed to the next person in line — re-seeding would undo all of
  // that. mergeRosterIntoParty appends only what is missing, so a guest who signed
  // themselves in before the fetch landed keeps their own row (and their real
  // name), and signer-only guardians are left where they are.
  const seededRef = useRef(false);
  useEffect(() => {
    const roster = ctx?.roster;
    if (!roster || seededRef.current) return;
    seededRef.current = true;
    setParty((prev) => mergeRosterIntoParty(prev, roster, guardians));
  }, [ctx, guardians]);

  // Preloaded rows are ALREADY registered on this reservation — that is where they
  // came from — and the only name they carry is the redacted "Ann A.". Attaching
  // them would re-register an existing projectPerson under a first name of "Ann"
  // and a last name of "A."; only people who signed in or signed up on THIS device
  // attach (see roster-preload.ts invariant 2).
  const attachParty = useMemo(() => party.filter((m) => !isPreloadedMember(m)), [party]);

  // Reservation mode: each member who reaches (person id + valid waiver) attaches
  // to the reservation — Neon persist-first, then the probe-gated BMI attach.
  useReservationJoinAttach({
    party: attachParty,
    target: reservation ?? null,
    center,
    kioskId: null,
    enabled: !!reservation && !!center,
  });

  // `wp-mobile` scopes the kiosk look (tokens, k-* primitives, px re-proportioning)
  // to the whole page, not just the party manager — so the head, share modal and
  // success card are the same design system as the kiosk. The deep navy is the
  // kiosk's --k-deep on BOTH brands, mirroring .kiosk-canvas. Mobile-first width
  // that grows into a desktop window instead of stranding a phone column on a
  // monitor — paired with the >=768px type/spacing block in waiver-party.css.
  const shell = (children: ReactNode) => (
    <div
      className="wp-mobile min-h-screen bg-[#000418]"
      style={{ "--accent": "#00E2E5" } as CSSProperties}
    >
      {/* max-w-xl, not 3xl: this is a short form, and a wider column just stretched
          the rows so "Remove" ended up 500px from the name it belongs to. */}
      <main className="wp-mobile-page mx-auto w-full max-w-md px-4 pt-6 md:max-w-xl md:px-8 md:pt-10">
        {children}
      </main>
    </div>
  );

  // Standalone HeadPinz visitor with no center yet — pick one (reservation mode
  // always resolves a center from locationId, so it never lands here).
  if (!center || !location) {
    return shell(
      <>
        <WaiverHead
          brand={brand}
          subtitle="Which location are you visiting?"
          signed={0}
          total={0}
        />
        <div className="space-y-3">
          {(
            [
              ["fort-myers", "HeadPinz Fort Myers"],
              ["naples", "HeadPinz Naples"],
            ] as const
          ).map(([code, label]) => (
            <button
              key={code}
              type="button"
              className="k-glass k-tap flex w-full items-center justify-between px-4 py-4 text-left"
              onClick={() => setStandaloneCenter(code)}
            >
              <span className="k-display text-lg">{label}</span>
              <IconChevronRight aria-hidden size={20} className="text-[var(--k-cyan)]" />
            </button>
          ))}
        </div>
      </>,
    );
  }

  // EVERY row is included and visible with its Sign-waiver button — 17-digit
  // Office ids sign directly now (proven from production's own sign ledger; see
  // roster-preload.ts § "EVERY preloaded row with a person id is signable").
  // `includedIds` is display/participation state, not the completion gate; it has
  // to match the party the manager was actually given, or its own blockReason
  // would report on members it isn't rendering.
  const partyIds = new Set(party.map((m) => m.id));
  // The completion gate is scoped to what THIS DEVICE is responsible for. A
  // preloaded row nobody here has touched is somebody else's job: it renders, and
  // it must not hold this phone in the flow forever (roster-preload.ts invariant
  // 4). peopleReady itself is untouched — it is shared with the kiosk; we hand it
  // a narrower participating set, which is exactly what its `ids` argument is for.
  const myMembers = membersOwnedHere(party, signedHere);
  const myIds = myMembers.map((m) => m.id);
  const ready = myIds.length > 0 && peopleReady(party, myIds) === true;
  // Live signed count for the kiosk-style progress bar (kiosk shows step-of-N;
  // the waiver's real progress is how much of the party is done).
  const signedCount = party.filter((m) => m.waiverValid).length;

  // GROUP-WIDE, and never this device's rows: where the RESERVATION stands. Every
  // sentence and every bar below that speaks for the whole booking reads this, and
  // only this — see roster-preload.ts invariant 6 for why `party` may not answer it
  // (removed cards, an empty persons_list and the "I'm done" wipe all leave zero
  // unsigned rows on screen for a booking where nobody has signed). `null` =
  // standalone: there is no reservation, so nobody is outside the party on screen.
  const groupStatus: ReservationWaiverStatus | null = reservation
    ? reservationWaiverStatus({
        signed: ctx?.signed,
        total: ctx?.total,
        roster: ctx?.roster,
        party,
        covered: carriedCovered,
      })
    : null;
  const groupLine = groupWaiverLine(groupStatus);
  // The head bar answers to the same status: filling it is the same claim as saying
  // "All waivers signed" out loud.
  const progress = waiverProgress({
    status: groupStatus,
    partySize: party.length,
    partySigned: signedCount,
    signed: ctx?.signed,
    total: ctx?.total,
  });

  // Does the link this guest is about to forward actually show the party? Read off
  // `ctx.roster`, the same field the preload gates on, so the disclosure in
  // ShareBlock can never claim less than the payload delivers. False for a group
  // function (no roster by design), for an online booking with nobody registered,
  // and on a sweep miss — in all three cases no name is on the link.
  const linkShowsNames = !!ctx?.roster?.length;

  // Remove — shared by the party cards and the sign-in rows. For the ORGANIZER
  // it is REAL: the person comes off the reservation itself (BMI projectPerson
  // row + our Neon join, via the organizer-gated roster-remove route — the
  // Office UI's own call, probe-proven from the owner's HAR 2026-07-31).
  // Optimistic locally; a failed server removal puts the row back rather than
  // lying about it. Anyone else's Remove stays what it always was — tidying
  // this screen — because the server refuses their cookie anyway, and a hidden
  // preloaded row comes back on the next load.
  const removeFromParty = (id: string) => {
    const member = party.find((m) => m.id === id);
    setParty((p) => p.filter((m) => m.id !== id));
    const personId = member ? (member.pandoraPersonId ?? member.bmiPersonId) : null;
    if (!member || !reservation || !center || !ctx?.canManage || !personId) return;
    const restore = () => setParty((p) => (p.some((m) => m.id === id) ? p : [...p, member]));
    void fetch("/api/waiver/roster-remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        c: center,
        loc: reservation.locationId,
        pid: reservation.projectId,
        personId,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!d?.ok) restore();
      })
      .catch(restore);
  };

  // "I'm done" clears the roster off the screen. The waivers are already durable
  // (Pandora + the Neon audit row + the reservation attach), so nothing is lost —
  // what goes away is a list of real names and birth years left sitting on a
  // phone that gets handed to the next person in line (owner 2026-07-30).
  if (finished) {
    // FROZEN at "I'm done", never recomputed: the wipe emptied `party`, and an empty
    // party cannot contradict anything. Both cards word the reservation through the
    // same `groupWaiverLine`, so the terminal card can no longer be the quiet one.
    const finishedLine = groupWaiverLine(finished.status);
    const finishedOutstanding = finished.status?.kind === "outstanding";
    return shell(
      <>
        <WaiverHead
          brand={brand}
          subtitle={reservation ? (ctx?.centerName ?? "") : standaloneCenterName(brand, center)}
          signed={0}
          total={0}
        />
        <div className="rounded-[18px] border border-[var(--k-ok)]/40 bg-[var(--k-ok)]/10 p-5 text-center">
          {/* "You're all set" is a claim about THIS DEVICE's work — never about the
              booking — which is what makes it safe to say while other people on the
              reservation are outstanding. It only holds up while the line below
              actually owns up to them, in EVERY state: this card used to render
              nothing at all unless it held a positive count, so a booking we could
              not vouch for read exactly like a finished one. */}
          <p className="k-display flex items-center justify-center gap-2 text-lg text-[var(--k-ok)]">
            <IconCheck aria-hidden size={20} stroke={3} />
            You&apos;re all set
          </p>
          <p className="mt-2 text-sm text-[var(--k-dim)]">
            {finished.names.length === 1
              ? `${finished.names[0]}'s waiver is on file.`
              : `${finished.names.length} waivers are on file.`}{" "}
            {reservation
              ? "We have them saved to your reservation."
              : "We'll have them when you arrive."}
          </p>
          {finishedLine && (
            <p
              className={`mt-2 text-sm ${finishedOutstanding ? "text-[var(--k-warn)]" : "text-[var(--k-dim)]"}`}
            >
              {finishedOutstanding
                ? `${finishedLine} Share the link below so they can sign.`
                : finishedLine}
            </p>
          )}
        </div>
        {/* THE RACING LICENCE IS HIDDEN HERE FOR NOW (owner 2026-08-06).
            It resolved the login code through BMI's Office CLOUD api, which
            trails the on-prem Firebird by p50 31 min / p90 68 min after signing
            — so at the moment a waiver finishes the code reliably does not
            exist and the card had nothing to show. A Pandora endpoint that
            returns the code directly is coming; when it lands, restore this and
            the twin on the ready card below.
            `WaiverLicenceOffer` and the grant plumbing are left intact — the
            server still mints a grant on every signature — so restoring is
            re-adding this one line in both places. */}
        <button
          type="button"
          onClick={() => setFinished(null)}
          className="k-btn-ghost k-tap mt-4 w-full"
        >
          Sign someone else
        </button>
        {reservation && (
          <ShareBlock
            label={ctx?.label ?? "your reservation"}
            showsNames={linkShowsNames}
            shareUrl={ctx?.shareUrl}
          />
        )}
      </>,
    );
  }

  // Reservation link, context still in flight: the kiosk's branded loader
  // instead of an empty party under "N registered". Keyed on `ctxSettled`, not
  // on the first response — a summary that arrived WITHOUT the sweep result is
  // still "loading the people", and the fetch loop above is mid-retry for
  // exactly that case. A failed/exhausted loop settles and falls through to the
  // normal flow rather than spinning forever — signing has never depended on
  // the header.
  if (reservation && !ctxSettled) {
    return shell(
      <>
        <WaiverHead brand={brand} subtitle="Loading reservation…" signed={0} total={0} />
        <div className="flex justify-center py-10">
          <BrandedLoader
            brand={brand}
            size={180}
            label="Loading your reservation"
            sublabel="One moment"
          />
        </div>
      </>,
    );
  }

  return shell(
    <>
      <WaiverHead
        brand={brand}
        // Reservation mode: WHEN and WHERE only. The activity list is a raw BMI
        // resource list and runs long — a real group event came back with 14
        // resources ("FT VIP Room · FT Room 2 · Duck Lane 1 · …"), which buried
        // the title under a wall of text on a phone. It lives in the card below,
        // clamped.
        subtitle={
          reservation
            ? [ctx?.whenLabel, ctx?.centerName].filter(Boolean).join(" · ") ||
              "Loading reservation…"
            : standaloneCenterName(brand, center)
        }
        // The RESERVATION's progress, not this phone's — a full bar over "N of N
        // signed" says "All waivers signed" just as loudly as the card at the
        // bottom, and `signedCount`/`party.length` would happily fill it for a
        // booking with four people outstanding (roster-preload.ts § waiverProgress).
        signed={progress.signed}
        total={progress.total}
      />

      {reservation && <EventInfoCard ctx={ctx} />}

      <KioskPartyManager
        mode="waiver"
        theme="mobile"
        guardianSigning
        // The kiosk's model: a minor registers first; the adult who signs is found
        // when the waiver comes up (choose / add new / look up). No guardian field
        // on the player form, and no "add an adult first" dead end.
        guardianResolution="sign-time"
        guardians={guardians}
        onAddGuardian={(g) => setGuardians((gs) => [...gs, g])}
        onUpdateGuardian={(id, patch) =>
          setGuardians((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)))
        }
        onPromoteGuardian={(g) => {
          setGuardians((gs) => gs.filter((x) => x.id !== g.id));
          setParty((p) => addMemberSupersedingPreload(p, g));
        }}
        hasCamera
        photoStep="required-adults"
        renderPhoto={(args) => <MobileWaiverPhoto {...args} />}
        party={party}
        brandLocation={location}
        center={center}
        includedIds={partyIds}
        onIncludedChange={() => {}}
        // A guest who is already a preloaded row may still sign in through the
        // lookup / a license scan / a linked-family tap instead of tapping their
        // own row. The real account SUPERSEDES the redacted placeholder in place —
        // two cards for one human would leave a row nobody can ever satisfy.
        onAddMember={(m) => setParty((p) => addMemberSupersedingPreload(p, m))}
        onUpdateMember={(id, patch) =>
          setParty((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m)))
        }
        onRemoveMember={removeFromParty}
        onWaiverSigned={(info) => {
          // THIS DEVICE signed this member — so it counts toward this device's
          // completion even when the row came from the reservation roster (that is
          // the guest who opened a forwarded link and signed their own row).
          setSignedHere((prev) => new Set(prev).add(info.memberId));
          // `info.licenceGrant` is still minted server-side and still arrives
          // here; nothing consumes it while the licence offer is hidden.
          // Best-effort E-SIGN audit row in our own DB (Pandora holds the
          // signature image; this is the persist-to-Neon record of acceptance).
          void fetch("/api/waiver/record", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              personId: info.personId,
              firstName: info.firstName,
              center,
              waiverId: info.waiverId,
              termsVersion: info.templateContentId,
              signedByPersonId: info.signerPersonId,
            }),
          }).catch(() => {});
        }}
      />

      {reservation && (
        <ShareBlock
          label={ctx?.label ?? "your reservation"}
          showsNames={linkShowsNames}
          shareUrl={ctx?.shareUrl}
        />
      )}

      {ready && (
        <div className="mt-6 rounded-[18px] border border-[var(--k-ok)]/40 bg-[var(--k-ok)]/10 p-4 text-center">
          {/* "All waivers signed" is a claim about the whole RESERVATION, so it is
              spoken by the reservation — `mayClaimAllSigned` — and by nothing else.
              It was previously licensed by "no unsigned rows on this screen", which
              is also true of a booking whose persons_list came back empty, of one
              whose cards the guest removed, and of one this phone already wiped. With
              four people on the booking still unsigned it is a lie, and the guest is
              the one holding the link that would fix it. */}
          <p className="k-display flex items-center justify-center gap-2 text-lg text-[var(--k-ok)]">
            <IconCheck aria-hidden size={20} stroke={3} />
            {/* A JS string, so the apostrophe is a literal one — `&apos;` inside an
                expression would render as five characters on the guest's screen. */}
            {mayClaimAllSigned(groupStatus) ? "All waivers signed" : "You're all set"}
          </p>
          <p className="mt-1 text-sm text-[var(--k-dim)]">
            {reservation
              ? "Saved to your reservation."
              : "We'll have these on file when you arrive."}
            {groupLine ? ` ${groupLine}` : ""}
          </p>
          {/* Licence offer hidden for now — see the note on the terminal card.
              When it returns it belongs HERE, above the button: below it is a
              thing you scroll past on the way to the obvious action, which for
              reach is the same as not shipping it. */}
          {/* Deliberate end to the flow: without it the roster of names just sits
              on the screen and the guest has to guess whether they can leave. It is
              gated on `ready` — this DEVICE's members — so a guest who signed only
              their own row can always finish, however much of the booking is left. */}
          <button
            type="button"
            onClick={() => {
              // Only what THIS DEVICE filed — `party` still holds the preloaded
              // rows of people who never signed here, and counting them would
              // report "8 waivers are on file" for one signature.
              setFinished({
                names: myMembers.map((m) => m.firstName).filter(Boolean),
                status: groupStatus,
              });
              // The wipe is about to destroy the only proof that this phone covered
              // these people; keep their ids so the next person in line is not told
              // to sign a waiver that is already on file.
              setCarriedCovered((prev) => coveredPersonIds(party, prev));
              setParty([]);
              setSignedHere(new Set());
            }}
            className="k-btn-primary k-tap mt-4 w-full"
          >
            I&apos;m done
          </button>
        </div>
      )}
    </>,
  );
}

/** Lean event-info card — which reservation these signatures attach to. The
 *  activity/when/center line lives in the head subtitle, so this card carries the
 *  reservation identity + guest count only.
 *  Deliberately NO pricing / deposit / payments. The party itself IS shown, in the
 *  roster below, redacted to a given name + one initial — so do not read this card
 *  as a promise that the page is name-free (see /api/waiver/context). */
function EventInfoCard({ ctx }: { ctx: WaiverContextSummary | null }) {
  return (
    <section className="k-glass mb-5 px-4 py-3">
      <div className="k-eyebrow">Signing for</div>
      <p className="k-display mt-1 text-base">{ctx?.label ?? "Your reservation"}</p>
      {/* Name, when, and signed-of-registered. The BMI resource list ("FT VIP
          Room · Duck Lane 1 · …", 14 entries on a real event) is deliberately
          NOT here — it was noise, not information, for someone signing. */}
      {!!ctx?.whenLabel && <p className="k-num mt-1 text-sm">{ctx.whenLabel}</p>}
      {/* No fraction until the count is actually known — "0 of 100" would read as
          "nobody has signed" when it really means "we haven't counted yet". */}
      {!!ctx?.total && (
        <p className="k-num mt-1 text-xs text-[var(--k-dim)]">
          {ctx.signed === undefined
            ? `${ctx.total} registered`
            : `${ctx.signed} of ${ctx.total} registered`}
        </p>
      )}
    </section>
  );
}

/** Forward the confirmation-free waiver link to the rest of the party. */
/** Client-only hydration flag (server snapshot false → client true) — lets us
 *  read window.location / navigator without a setState-in-effect or a hydration
 *  mismatch. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

function ShareBlock({
  label,
  showsNames,
  shareUrl,
}: {
  label: string;
  showsNames: boolean;
  /** Server-minted SHORT sign-only link. Falls back to the page URL. */
  shareUrl?: string;
}) {
  const hydrated = useHydrated();
  const [copied, setCopied] = useState(false);
  // One button, not a four-button grid: sharing is secondary to signing, and the
  // inline block was the busiest thing on the screen (owner 2026-07-30).
  const [open, setOpen] = useState(false);
  /**
   * Prefer the server-minted SHORT sign-only link. `window.location.href` is the
   * fallback and is safe — `/w/{code}` carries the code in an HttpOnly cookie, so
   * the address bar never holds a capability to copy — but it is the long form, and
   * for an ORGANIZER it is the URL *they* were sent, which reads as "here is my
   * link" when what they mean is "here is one to sign with".
   */
  const url = shareUrl || (hydrated ? window.location.href : "");
  const canNativeShare =
    hydrated && typeof navigator !== "undefined" && typeof navigator.share === "function";

  const subject = `Sign the waiver for ${label}`;
  const bodyText = `${subject}: ${url}`;

  const nativeShare = () => {
    void navigator.share({ title: subject, text: subject, url }).catch(() => {});
  };
  const copy = () => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const rowBtn =
    "k-tap flex w-full items-center gap-3 rounded-[14px] border border-[var(--k-line)] px-4 py-3 text-left text-sm font-semibold text-white";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="k-btn-ghost k-tap mt-6 w-full">
        <IconShare2 aria-hidden size={18} />
        Share with your group
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 p-4 md:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wp-share-title"
        >
          {/* Backdrop dismiss. A sibling button rather than a click handler on the
              overlay div, so it is keyboard-reachable and jsx-a11y clean. */}
          <button
            type="button"
            aria-label="Close share options"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="k-glass relative w-full max-w-sm px-4 py-5">
            <div id="wp-share-title" className="k-eyebrow">
              Share with your group
            </div>
            {/* This has to match what /api/waiver/context actually returns. Until
                2026-07-30 it claimed unconditionally that the link showed the
                event and none of the booking — true right up to the moment an
                ONLINE booking started shipping the party's redacted names. A
                privacy claim the payload contradicts is worse than no claim.
                share-disclosure.test.ts holds the shape of this sentence. */}
            <p className="mt-2 text-xs text-[var(--k-dim)]">
              Anyone can sign from this link.{" "}
              {showsNames
                ? "It shows the event and who's on the booking — first name and last initial only —"
                : "It shows the event only —"}{" "}
              never your confirmation number, prices or payment details.
            </p>
            <div className="mt-4 space-y-2">
              <a href={`sms:?&body=${encodeURIComponent(bodyText)}`} className={rowBtn}>
                <IconMessage aria-hidden size={18} className="text-[var(--k-cyan)]" />
                Text it
              </a>
              <a
                href={`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`}
                className={rowBtn}
              >
                <IconMail aria-hidden size={18} className="text-[var(--k-cyan)]" />
                Email it
              </a>
              <button type="button" onClick={copy} className={rowBtn}>
                <IconLink aria-hidden size={18} className="text-[var(--k-cyan)]" />
                {copied ? "Copied" : "Copy link"}
              </button>
              {canNativeShare && (
                <button type="button" onClick={nativeShare} className={rowBtn}>
                  <IconShare2 aria-hidden size={18} className="text-[var(--k-cyan)]" />
                  More sharing options
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="k-tap mt-4 w-full text-sm text-[var(--k-dim)]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
