"use client";

import { useId, useState, type FormEvent } from "react";
import type { CentreCode } from "~/features/crm/core/types";
import type { CollateralItem } from "~/features/crm/collateral/contracts";
import { COLLATERAL_TEST_IDS } from "~/features/crm/collateral/contracts";
import {
  COLLATERAL_ACCEPT,
  COLLATERAL_MAX_BYTES,
  collateralTypeFromName,
  parseTagInput,
  titleFromFilename,
  tooBigMessage,
} from "~/features/crm/collateral/service/library";
import { CENTRES, CENTRE_CODES } from "~/features/crm/core/centres";
import { errorMessage } from "../lib/crm-fetch";
import { Banner } from "../primitives/Banner";
import { collateralMessage } from "./model";

/**
 * Add a file to the library. ONE sheet with two ways in, because there are two
 * realities:
 *
 *   Upload      the normal path, when Vercel Blob has a token;
 *   Add by URL  the honest degrade when it does not (brief C6: the screen says
 *               so plainly), and also the way a director points at something
 *               already hosted — a menu on the marketing site, say.
 *
 * The size and extension checks run HERE as well as on the server, from the
 * SAME table (`service/library.ts`), so a rep learns that a 40 MB video is not
 * going to work before waiting for 40 MB to upload — and the server still
 * refuses it if the client is bypassed.
 *
 * Nothing here uses `autoFocus` (R13 / jsx-a11y).
 */
export interface UploadSheetProps {
  blobConfigured: boolean;
  onUpload: (form: FormData) => Promise<CollateralItem>;
  onCreateByUrl: (input: {
    title: string;
    centre: CentreCode | null;
    blobUrl: string;
    tags: string[];
    validFrom: string | null;
    validUntil: string | null;
  }) => Promise<CollateralItem>;
  onDone: (item: CollateralItem) => void;
  onCancel: () => void;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function UploadSheet({
  blobConfigured,
  onUpload,
  onCreateByUrl,
  onDone,
  onCancel,
}: UploadSheetProps) {
  const ids = useId();
  const [mode, setMode] = useState<"file" | "url">(blobConfigured ? "file" : "url");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [centre, setCentre] = useState<string>("");
  const [tags, setTags] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = (next: File | null) => {
    setFile(next);
    setError(null);
    if (next && !title.trim()) setTitle(titleFromFilename(next.name));
    if (next && next.size > COLLATERAL_MAX_BYTES) setError(tooBigMessage(next.size));
    else if (next && !collateralTypeFromName(next.name)) {
      setError(collateralMessage("unsupported_file_type"));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) return setError("Give it a name a rep will recognise.");
    if (validFrom && !YMD.test(validFrom)) return setError("Valid from must be a date.");
    if (validUntil && !YMD.test(validUntil)) return setError("Valid until must be a date.");
    setError(null);
    setPending(true);
    try {
      if (mode === "file") {
        if (!file) throw new Error("no_file");
        if (file.size > COLLATERAL_MAX_BYTES) throw new Error("file_too_big");
        if (!collateralTypeFromName(file.name)) throw new Error("unsupported_file_type");
        const form = new FormData();
        form.set("file", file);
        form.set("title", cleanTitle);
        if (centre) form.set("centre", centre);
        if (tags.trim()) form.set("tags", tags.trim());
        if (validFrom) form.set("validFrom", validFrom);
        if (validUntil) form.set("validUntil", validUntil);
        onDone(await onUpload(form));
      } else {
        onDone(
          await onCreateByUrl({
            title: cleanTitle,
            centre: (centre || null) as CentreCode | null,
            blobUrl: url.trim(),
            tags: parseTagInput(tags),
            validFrom: validFrom || null,
            validUntil: validUntil || null,
          }),
        );
      }
    } catch (err) {
      setError(collateralMessage(errorMessage(err)));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      className="stack"
      style={{ gap: 14 }}
      onSubmit={submit}
      data-testid={COLLATERAL_TEST_IDS.uploadSheet}
    >
      {!blobConfigured ? (
        <Banner tone="warn" testId={COLLATERAL_TEST_IDS.blobBanner}>
          File upload is off for this deployment: BLOB_READ_WRITE_TOKEN is not set. Paste the
          file&rsquo;s public link instead — everything else about it works the same.
        </Banner>
      ) : null}

      {blobConfigured ? (
        <div className="seg" role="group" aria-label="How to add the file">
          <button
            type="button"
            aria-pressed={mode === "file"}
            onClick={() => setMode("file")}
            disabled={pending}
          >
            Upload a file
          </button>
          <button
            type="button"
            aria-pressed={mode === "url"}
            onClick={() => setMode("url")}
            disabled={pending}
          >
            Add by URL
          </button>
        </div>
      ) : null}

      {mode === "file" ? (
        <div className="field">
          <label htmlFor={`${ids}-file`}>File</label>
          <input
            id={`${ids}-file`}
            className="input"
            type="file"
            accept={COLLATERAL_ACCEPT}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            disabled={pending}
          />
          <div className="xs muted">PDF, PowerPoint, Word, Excel or an image. Up to 25 MB.</div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`${ids}-url`}>Public link to the file</label>
          <input
            id={`${ids}-url`}
            className="input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            disabled={pending}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor={`${ids}-title`}>Name</label>
        <input
          id={`${ids}-title`}
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Group Pricing HPFM 2026"
          disabled={pending}
        />
      </div>

      <div className="field">
        <label htmlFor={`${ids}-centre`}>Centre</label>
        <select
          id={`${ids}-centre`}
          className="select"
          value={centre}
          onChange={(e) => setCentre(e.target.value)}
          disabled={pending}
        >
          <option value="">All centres</option>
          {CENTRE_CODES.map((c) => (
            <option key={c} value={c}>
              {CENTRES[c].name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${ids}-tags`}>Tags</label>
        <input
          id={`${ids}-tags`}
          className="input"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="pricing, holiday"
          disabled={pending}
        />
        <div className="xs muted">Separate with commas. Tags are the folders on this screen.</div>
      </div>

      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${ids}-from`}>Valid from</label>
          <input
            id={`${ids}-from`}
            className="input"
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            disabled={pending}
          />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-until`}>Valid until</label>
          <input
            id={`${ids}-until`}
            className="input"
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            disabled={pending}
          />
          <div className="xs muted">After this day it drops out of the pickers.</div>
        </div>
      </div>

      {error ? <Banner tone="crit">{error}</Banner> : null}

      <div className="hstack" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Add to library"}
        </button>
      </div>
    </form>
  );
}
