"use client";

import { IconPlus, IconSearch } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BUILDER_TEST_IDS } from "~/features/crm/bmi/contracts";
import { builderKeys } from "~/features/crm/bmi/queries";
import { fDate } from "~/features/crm/core/dates";
import { moneyExact } from "~/features/crm/core/format";
import { useCrmFetch } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { useDebouncedValue } from "../lib/use-debounced";
import { fetchCatalog } from "./queries";

/**
 * The product picker.
 *
 * TWO READS, ON PURPOSE. Typing searches NAMES only — the catalogue is
 * hundreds of products and pricing one is an Office round trip each. Choosing
 * one asks Office for THAT product's price ON THE EVENT'S DATE, because
 * weekday and weekend are different numbers and this is where that difference
 * lives. The price shown beside the Add button and the price the quote charges
 * are therefore the same read, for the same day — never a cached number and
 * never one carried over from another date.
 */

export interface AddLineProps {
  centre: string;
  date: string;
  lead: string;
  busy: boolean;
  onAdd: (input: { productId: string; productName: string; quantity: number }) => void;
}

export function AddLine({ centre, date, lead, busy, onAdd }: AddLineProps) {
  const crmFetch = useCrmFetch();
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<{ productId: string; name: string } | null>(null);
  const [quantity, setQuantity] = useState(1);
  // Debounced so a rep typing "birthday" does not run eight catalogue reads.
  const q = useDebouncedValue(term, 250, term);

  const listQ = useQuery({
    queryKey: builderKeys.catalog(centre, date, q),
    queryFn: () => fetchCatalog(crmFetch, { centre, date, q, lead }),
    placeholderData: keepPreviousData,
  });

  // The one price read: only for the product a rep actually chose, and only
  // for this event's date.
  const priceQ = useQuery({
    queryKey: builderKeys.price(centre, date, picked?.productId ?? "", quantity),
    queryFn: () =>
      fetchCatalog(crmFetch, {
        centre,
        date,
        productId: picked!.productId,
        quantity,
        lead,
      }),
    enabled: picked !== null,
  });

  const priceCents = priceQ.data?.products[0]?.priceCents ?? null;
  const products = listQ.data?.products ?? [];
  const unavailable = listQ.data?.source === "unavailable";

  return (
    <div className="stack" data-testid={BUILDER_TEST_IDS.addLine}>
      <div className="search">
        <IconSearch {...ICON} />
        <input
          type="search"
          value={term}
          placeholder="Search the BMI product catalogue…"
          aria-label="Search products"
          onChange={(e) => {
            setTerm(e.target.value);
            setPicked(null);
          }}
        />
      </div>

      {unavailable ? (
        <div className="xs muted">{listQ.data?.error}</div>
      ) : (
        <div className="tpl-grid" data-testid={BUILDER_TEST_IDS.catalog}>
          {products.slice(0, 24).map((p) => (
            <button
              key={p.productId}
              type="button"
              className={`tplc${picked?.productId === p.productId ? " opt pick" : ""}`}
              onClick={() => setPicked({ productId: p.productId, name: p.name })}
            >
              <span className="strong">{p.name}</span>
              <span className="xs muted">#{p.productId}</span>
            </button>
          ))}
        </div>
      )}

      {picked ? (
        <div className="hstack between">
          <div className="hstack">
            <div className="field avail-field">
              <label htmlFor="builder-qty">Qty</label>
              <input
                id="builder-qty"
                className="input"
                style={{ width: 80 }}
                type="number"
                min={1}
                max={10000}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <span className="small muted">
              {priceQ.isPending
                ? `Pricing for ${fDate(date)}…`
                : priceCents === null
                  ? "BMI did not return a price for this date"
                  : `${moneyExact(priceCents)} each on ${fDate(date)}`}
            </span>
          </div>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || priceQ.isPending}
            onClick={() =>
              onAdd({ productId: picked.productId, productName: picked.name, quantity })
            }
          >
            <IconPlus {...ICON} />
            <span className="lbl">Add to quote</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
