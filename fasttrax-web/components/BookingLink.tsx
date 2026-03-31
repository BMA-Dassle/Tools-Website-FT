"use client";

import { trackBookingClick } from "@/lib/analytics";

export default function BookingLink({
  href,
  className,
  style,
  children,
}: {
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={style}
      onClick={trackBookingClick}
    >
      {children}
    </a>
  );
}
