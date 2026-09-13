"use client";

import { IconAlertTriangle, IconCheck, IconClock, IconFile } from "@tabler/icons-react";
import type { ContractCounts } from "~/features/crm/contracts/contracts";
import { CONTRACT_TEST_IDS } from "~/features/crm/contracts/contracts";
import { ICON } from "../primitives/icon-props";
import { Tile } from "../primitives/Tile";
import { tileSpecs, type TileSpec } from "./model";

/**
 * The four tiles above the contracts table (crm-events.js:236). "Needs
 * attention" is the only one that does anything: it switches the window, which
 * is what a director actually wants from it.
 *
 * A BUTTON, not a clickable div — the prototype used an `<a href="#">`, which
 * is a link that goes nowhere (jsx-a11y and a keyboard user both object).
 */
const ICONS: Record<TileSpec["key"], typeof IconFile> = {
  attention: IconAlertTriangle,
  outUnsigned: IconFile,
  deposits: IconCheck,
  balance: IconClock,
};

const ICON_CLASS: Record<TileSpec["key"], string> = {
  attention: "warn",
  outUnsigned: "",
  deposits: "good",
  balance: "orange",
};

export interface AttentionTilesProps {
  counts: ContractCounts;
  onShowAttention: () => void;
}

export function AttentionTiles({ counts, onShowAttention }: AttentionTilesProps) {
  const specs = tileSpecs(counts);
  return (
    <div className="grid grid-4" data-testid={CONTRACT_TEST_IDS.tiles}>
      {specs.map((spec) => {
        const Icon = ICONS[spec.key];
        const tile = (
          <Tile
            label={spec.label}
            value={spec.value}
            unit={spec.unit}
            sub={spec.sub}
            ico={<Icon {...ICON} />}
            icoCls={ICON_CLASS[spec.key]}
          />
        );
        if (spec.key !== "attention") return <div key={spec.key}>{tile}</div>;
        return (
          <button
            key={spec.key}
            type="button"
            className="tile-button"
            onClick={onShowAttention}
            aria-label={`Show the ${counts.attention} contracts that need attention`}
          >
            {tile}
          </button>
        );
      })}
    </div>
  );
}
