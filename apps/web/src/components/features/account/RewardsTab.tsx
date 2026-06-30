"use client";

import { IconStar, IconDeviceMobile } from "@tabler/icons-react";
import Card from "~/components/ui/Card";
import type { DashRewards } from "~/features/account/dashboard-types";

export default function RewardsTab({ rewards }: { rewards: DashRewards }) {
  if (rewards.status === "not_applicable") {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconDeviceMobile size={32} className="text-white/30" />
        <p className="text-white/70">Sign in with your phone number to see HeadPinz Rewards.</p>
        <p className="text-sm text-white/45">
          Your rewards balance is tied to the phone number on your account. Log out and sign in with
          your mobile number to view your points.
        </p>
      </Card>
    );
  }

  if (rewards.status === "unavailable") {
    return (
      <Card className="p-6">
        <p className="text-white/70">We couldn&apos;t load your rewards right now.</p>
      </Card>
    );
  }

  if (!rewards.account) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconStar size={32} className="text-white/30" />
        <p className="text-white/70">You&apos;re not enrolled in HeadPinz Rewards yet.</p>
        <p className="text-sm text-white/45">
          Earn Pinz on every visit. You&apos;ll be invited to join the next time you book or check
          in.
        </p>
      </Card>
    );
  }

  const { balance, lifetimePoints, enrolledAt } = rewards.account;
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <IconStar size={24} style={{ color: "var(--account-accent)" }} />
        <h2 className="text-lg font-semibold text-white">HeadPinz Rewards</h2>
      </div>
      <div className="mt-6 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-white">{balance.toLocaleString()}</span>
        <span className="text-white/50">Pinz available</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-white/40">Lifetime points</p>
          <p className="text-white/80">{lifetimePoints.toLocaleString()}</p>
        </div>
        {enrolledAt && (
          <div>
            <p className="text-white/40">Member since</p>
            <p className="text-white/80">
              {new Date(enrolledAt).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
