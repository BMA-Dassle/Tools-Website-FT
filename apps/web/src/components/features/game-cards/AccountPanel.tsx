"use client";

/**
 * Signed-in layer for the reload page: optional phone-OTP sign-in, a multi-
 * account picker (name / rewards points / linked-card count), the selected
 * account's linked game cards (multi-select reload, rename, remove, add), and
 * its saved payment cards. Payment methods only appear once an account is
 * selected. Anonymous guests just don't open it. Built to be liftable into the
 * account dashboard — all state comes from `useGameCardAccount`.
 */
import { useState } from "react";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Input from "~/components/ui/Input";
import ErrorBox from "~/components/ui/ErrorBox";
import type { GameCardAccount } from "~/features/game-cards/account-hooks";
import { normalizeCard } from "~/features/game-cards/normalize";

const PANEL = "space-y-3 p-5 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]";

export default function AccountPanel({
  account,
  onReloadCards,
}: {
  account: GameCardAccount;
  onReloadCards: (accountNumbers: string[], locationCode: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"contact" | "otp">("contact");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [addEntry, setAddEntry] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [nick, setNick] = useState("");
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());

  const { authed, session } = account;

  // ── Signed out: collapsed sign-in affordance ─────────────────────────────
  if (!authed) {
    if (!open) {
      return (
        <button
          onClick={() => setOpen(true)}
          className="w-full rounded-xl border border-white/15 px-4 py-2.5 text-sm text-[#00E2E5] backdrop-blur-md transition hover:border-white/30"
        >
          Sign in for saved cards &amp; faster reloads →
        </button>
      );
    }
    return (
      <Card className={PANEL}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Sign in</h2>
          <button className="text-xs text-white/40 underline" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
        {phase === "contact" ? (
          <>
            <p className="text-xs text-white/60">
              We&apos;ll text you a code. Saved cards make future reloads one tap.
            </p>
            <Input
              label="Mobile number"
              inputMode="tel"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
            {account.requestOtp.isError && (
              <ErrorBox>Couldn&apos;t send a code. Try again.</ErrorBox>
            )}
            <Button
              loading={account.requestOtp.isPending}
              disabled={contact.trim().length < 7}
              onClick={async () => {
                await account.requestOtp.mutateAsync(contact.trim());
                setPhase("otp");
              }}
            >
              Send code
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-white/60">Enter the 6-digit code we texted you.</p>
            <Input
              label="Code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            />
            {account.verifyOtp.data && account.verifyOtp.data.ok === false && (
              <ErrorBox>Incorrect code. {account.verifyOtp.data.attemptsLeft ?? 0} left.</ErrorBox>
            )}
            <Button
              loading={account.verifyOtp.isPending}
              disabled={code.length !== 6}
              onClick={() => account.verifyOtp.mutate({ contact: contact.trim(), code })}
            >
              Verify
            </Button>
            <button className="text-xs text-white/40 underline" onClick={() => setPhase("contact")}>
              Change number
            </button>
          </>
        )}
      </Card>
    );
  }

  // ── Signed in, no account yet → ask to create rewards account ────────────
  const noAccount = account.accounts.length === 0 && account.customerIds.length === 0;
  if (noAccount) {
    return (
      <Card className={PANEL}>
        <h2 className="text-base font-semibold text-white">Create a HeadPinz Rewards account?</h2>
        <p className="text-xs text-white/60">
          We didn&apos;t find an account for {session.data?.contactMasked ?? "your number"}. Create
          one to save cards and earn rewards.
        </p>
        {account.createAccount.isError && (
          <ErrorBox>Couldn&apos;t create the account. Try again.</ErrorBox>
        )}
        <div className="flex gap-2">
          <Button
            loading={account.createAccount.isPending}
            onClick={() => account.createAccount.mutate()}
          >
            Create account
          </Button>
          <Button variant="secondary" onClick={() => account.logout.mutate()}>
            Not now
          </Button>
        </div>
      </Card>
    );
  }

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h2 className="text-base font-semibold text-white">Your cards</h2>
        {account.rewardsPoints != null && (
          <p className="text-xs text-[#00E2E5]">
            {account.rewardsPoints.toLocaleString()} rewards points
          </p>
        )}
      </div>
      <button className="text-xs text-white/40 underline" onClick={() => account.logout.mutate()}>
        Sign out
      </button>
    </div>
  );

  const acctLabel = (a: { customerId: string; name: string | null }) =>
    a.name || `Account ••${a.customerId.slice(-4)}`;

  // ── Multi-account, none selected → picker only ───────────────────────────
  if (account.accounts.length > 1 && !account.selectedCustomerId) {
    return (
      <Card className={PANEL}>
        {header}
        <div className="text-[11px] uppercase tracking-wide text-white/40">Choose an account</div>
        <div className="grid gap-1.5">
          {account.accounts.map((a) => (
            <button
              key={a.customerId}
              onClick={() => account.setSelectedCustomerId(a.customerId)}
              className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2.5 text-left transition hover:border-white/30"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-white">{acctLabel(a)}</div>
                {a.email && <div className="truncate text-xs text-white/40">{a.email}</div>}
              </div>
              <span className="shrink-0 text-xs text-white/40">
                {a.cardCount} {a.cardCount === 1 ? "card" : "cards"}
              </span>
            </button>
          ))}
        </div>
      </Card>
    );
  }

  // ── Selected account (or single) → cards + saved payment methods ─────────
  const toggle = (acct: string) =>
    setSelectedCards((prev) => {
      const next = new Set(prev);
      if (next.has(acct)) next.delete(acct);
      else next.add(acct);
      return next;
    });

  const reloadSelected = () => {
    const picked = account.gameCards.filter((c) => selectedCards.has(c.accountNumber));
    if (!picked.length) return;
    const locs = new Set(picked.map((c) => c.locationCode));
    const commonLoc = locs.size === 1 ? (picked[0].locationCode ?? null) : null;
    onReloadCards(
      picked.map((c) => c.accountNumber),
      commonLoc,
    );
  };

  return (
    <Card className={PANEL}>
      {header}

      {account.accounts.length > 1 && (
        <button
          className="text-xs text-white/40 underline"
          onClick={() => {
            account.setSelectedCustomerId(null);
            setSelectedCards(new Set());
          }}
        >
          ‹ Switch account
        </button>
      )}

      <div className="space-y-2">
        {account.gameCards.length === 0 && (
          <p className="text-xs text-white/50">No saved game cards yet. Add one below.</p>
        )}
        {account.gameCards.map((c) => (
          <div key={c.accountNumber} className="space-y-1 rounded-lg bg-white/[0.04] px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-[#00E2E5]"
                checked={selectedCards.has(c.accountNumber)}
                onChange={() => toggle(c.accountNumber)}
                aria-label={`Select ${c.label || c.accountNumber}`}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white">
                  {c.label || `Card ${c.accountNumber}`}
                </div>
                <div className="text-xs text-white/40">
                  {c.balance
                    ? `${c.balance.tokens} tokens · ${c.balance.eTickets} eTickets`
                    : c.accountNumber}
                </div>
              </div>
              <button
                className="shrink-0 rounded-md border border-white/20 px-2.5 py-1 text-xs text-white/70"
                onClick={() => onReloadCards([c.accountNumber], c.locationCode)}
              >
                Reload
              </button>
            </div>
            {editing === c.accountNumber ? (
              <div className="flex gap-1 pl-6">
                <input
                  className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white"
                  value={nick}
                  placeholder="Nickname"
                  onChange={(e) => setNick(e.target.value)}
                />
                <button
                  className="text-xs text-[#00E2E5]"
                  onClick={async () => {
                    await account.renameCard.mutateAsync({
                      accountNumber: c.accountNumber,
                      nickname: nick,
                    });
                    setEditing(null);
                  }}
                >
                  Save
                </button>
              </div>
            ) : (
              <div className="flex gap-3 pl-6 text-[11px] text-white/40">
                <button
                  onClick={() => {
                    setEditing(c.accountNumber);
                    setNick(c.label ?? "");
                  }}
                >
                  Nickname
                </button>
                <button onClick={() => account.unlinkCard.mutate(c.accountNumber)}>Remove</button>
              </div>
            )}
          </div>
        ))}

        {selectedCards.size > 0 && (
          <Button onClick={reloadSelected}>Reload {selectedCards.size} selected</Button>
        )}

        <div className="flex gap-1">
          <input
            className="flex-1 rounded bg-white/10 px-2 py-1.5 text-sm text-white"
            inputMode="numeric"
            placeholder="Add a card number"
            value={addEntry}
            onChange={(e) => setAddEntry(e.target.value.replace(/\D/g, ""))}
          />
          <Button
            loading={account.linkCard.isPending}
            disabled={normalizeCard(addEntry).length === 0}
            onClick={async () => {
              await account.linkCard.mutateAsync(normalizeCard(addEntry));
              setAddEntry("");
            }}
          >
            Add
          </Button>
        </div>
        {account.linkCard.isError && (
          <ErrorBox>Couldn&apos;t add that card. Check the number.</ErrorBox>
        )}
      </div>

      {/* Saved payment methods — only for the selected account */}
      {account.savedCards.length > 0 && (
        <div className="space-y-1 border-t border-white/10 pt-3">
          <div className="text-[11px] uppercase tracking-wide text-white/40">Payment methods</div>
          {account.savedCards.map((pc) => (
            <div key={pc.id} className="flex items-center justify-between text-sm">
              <span className="text-white/70">
                {pc.brand} •••• {pc.last4}
                {pc.expired ? " (expired)" : ""}
              </span>
              <button
                className="text-[11px] text-white/40 underline"
                onClick={() => account.removeSavedCard.mutate(pc.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
