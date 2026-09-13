import { IconAlertTriangle, IconLoader2 } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Banner } from "./Banner";
import { ICON } from "./icon-props";

/**
 * The three states every query renders (the prototype has them on each screen):
 * loading (`.empty` with aria-busy), empty (`.empty`), error (a crit banner
 * with a Retry button). Hook-free; the screen passes `onRetry`.
 */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="empty" aria-busy="true" role="status">
      <IconLoader2 {...ICON} />
      <div>{label}</div>
    </div>
  );
}

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? null}
      <div>{children}</div>
    </div>
  );
}

export interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = "Retry" }: ErrorStateProps) {
  return (
    <Banner
      tone="crit"
      icon={<IconAlertTriangle {...ICON} />}
      actions={
        onRetry ? (
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : undefined
      }
    >
      {message}
    </Banner>
  );
}
