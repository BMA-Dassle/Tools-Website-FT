import { NextResponse } from "next/server";

/**
 * GET /api/admin/sales/openapi.json
 *
 * Public OpenAPI 3.0 spec for the FastTrax sales-admin endpoints.
 * Exposed for external consumers (HeadPinz portal, any future
 * dashboard integration) — auth is handled by `x-api-key` against
 * the SALES_API_KEYS env var.
 *
 * Note: the spec itself is served WITHOUT authentication so Swagger
 * UI / external tooling can fetch it for discovery. Calls to the
 * documented endpoints still require a valid x-api-key (or the
 * operator admin token — see middleware.ts).
 *
 * Robots: this route is under /api/admin/* which is already covered
 * by robots.txt's Disallow: /api/* directive — won't be indexed.
 */

const spec = {
  openapi: "3.0.3",
  info: {
    title: "FastTrax Admin API",
    description: [
      "Admin API surface for the FastTrax employee portal and HeadPinz portal.",
      "",
      "Three logical groupings, all gated by the same `x-api-key` header:",
      "  • **Sales** — read-only sales reporting (totals + raw entries).",
      "  • **Videos** — race-video pipeline: list, refresh, manual / bulk resend, block / unblock.",
      "  • **E-Tickets** — pre-race + check-in SMS log + per-message resend.",
      "",
      "**Auth**: every request requires the `x-api-key` header (or `?apiKey=` query param).",
      "Keys are issued by FastTrax ops and rotated centrally — request one from the operator team.",
      "",
      "**Time zone**: all date params and `byDay` rows are bucketed in `America/New_York` (ET).",
      "Reservations made between midnight UTC and 4 AM ET roll into the *previous* ET calendar day.",
      "",
      "**Range cap**: aggregations are computed live against Postgres + Redis on every request.",
      "Practical max range is ~90 days — the underlying SMS log retains 90 days, sales_log has no cap.",
      "",
      "**Idempotency**: video / e-ticket mutating endpoints (resend, bulk-resend, block) are NOT",
      "idempotent — each call sends a fresh SMS / hits the VT3 disable endpoint. Confirm before retrying.",
    ].join("\n"),
    version: "1.1.0",
    contact: {
      name: "FastTrax Operations",
      email: "ops@fasttraxent.com",
    },
  },
  servers: [
    { url: "https://fasttraxent.com", description: "Production" },
    { url: "https://headpinz.com", description: "Production (HeadPinz brand mirror — same data)" },
  ],
  tags: [
    { name: "Sales", description: "Read-only sales reporting." },
    { name: "Videos", description: "Race-video pipeline: list, refresh, resend, bulk resend, block / unblock." },
    { name: "E-Tickets", description: "Pre-race + check-in SMS log + per-message resend." },
    { name: "POV Codes", description: "ViewPoint / POV unlock-code issuance, redemption, and breakage." },
  ],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey" as const,
        in: "header" as const,
        name: "x-api-key",
        description: "API key issued by FastTrax ops. Set as the `x-api-key` header on every request.",
      },
    },
    schemas: {
      SaleEntry: {
        type: "object",
        description: "One confirmed reservation row, newest-first in the `entries` array.",
        properties: {
          ts: { type: "string", format: "date-time", example: "2026-05-02T18:54:49.015Z" },
          billId: { type: "string", description: "BMI bill / order id", example: "63000000003382314", nullable: true },
          reservationNumber: { type: "string", description: "Customer-facing reservation # (e.g. W33846)", example: "W33846", nullable: true },
          brand: { type: "string", enum: ["fasttrax", "headpinz"], nullable: true },
          location: { type: "string", enum: ["fortmyers", "naples"], nullable: true },
          bookingType: { type: "string", enum: ["racing", "racing-pack", "attractions", "mixed", "other"] },
          participantCount: { type: "integer", description: "Racer count (MAX of line.persons across distinct karting lines)", example: 4, nullable: true },
          isNewRacer: { type: "boolean", nullable: true, description: "True for first-time racers, false for returning, null when unknown" },
          rookiePack: { type: "boolean", nullable: true, description: "Legacy boolean — superseded by packageId. Kept for back-compat." },
          packageId: { type: "string", nullable: true, example: "ultimate-qualifier-weekend", description: "Stable package identifier when this booking used a named bundle." },
          povPurchased: { type: "boolean", nullable: true },
          povQty: { type: "integer", nullable: true },
          licensePurchased: { type: "boolean", nullable: true },
          expressLane: { type: "boolean", nullable: true, description: "True for returning racers with valid waivers who skip Guest Services." },
          raceProductNames: { type: "array", items: { type: "string" }, nullable: true },
          addOnNames: { type: "array", items: { type: "string" }, nullable: true },
          totalUsd: { type: "number", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },
        },
      },
      RacingBreakdown: {
        type: "object",
        properties: {
          reservations: { type: "integer" },
          newRacers: { type: "integer" },
          returningRacers: { type: "integer" },
          expressLane: { type: "integer" },
          rookiePack: {
            type: "object",
            properties: {
              count: { type: "integer" },
              pctOfNew: { type: "number" },
              pctOfRacing: { type: "number" },
            },
          },
          packages: {
            type: "object",
            properties: {
              total: { type: "integer", description: "Sum across all package variants in range" },
              byType: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", example: "ultimate-qualifier-weekend" },
                    label: { type: "string", example: "Ultimate Qualifier" },
                    count: { type: "integer" },
                    pctOfRacing: { type: "number" },
                  },
                },
              },
            },
          },
          pov: {
            type: "object",
            properties: {
              count: { type: "integer", description: "Number of bookings that included POV video" },
              qty: { type: "integer", description: "Total POV videos sold (sum of povQty)" },
              attachRate: { type: "number" },
              byNewRacer: { type: "integer" },
              byReturning: { type: "integer" },
              attachRateNewRacer: { type: "number" },
              attachRateReturning: { type: "number" },
              byTier: {
                type: "array",
                nullable: true,
                items: {
                  type: "object",
                  properties: {
                    tier: { type: "string", enum: ["starter", "intermediate", "pro"] },
                    racingCount: { type: "integer" },
                    povCount: { type: "integer" },
                    attachRate: { type: "number" },
                  },
                },
              },
            },
          },
          license: {
            type: "object",
            properties: { count: { type: "integer" } },
          },
          addOnAttachCount: { type: "integer" },
          addOnAttachRate: { type: "number" },
          topRaceProducts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                count: { type: "integer" },
              },
            },
          },
        },
      },
      AttractionsBreakdown: {
        type: "object",
        properties: {
          reservations: { type: "integer" },
          topAddOns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                count: { type: "integer" },
              },
            },
          },
        },
      },
      DailyTotal: {
        type: "object",
        properties: {
          ymd: { type: "string", format: "date", example: "2026-05-02", description: "ET calendar day" },
          reservations: { type: "integer" },
          racers: { type: "integer" },
        },
      },
      SmsDailyCounts: {
        type: "object",
        properties: {
          date: { type: "string", format: "date", example: "2026-05-02" },
          attempts: { type: "integer", description: "Every SMS send attempt this day (success + failure)" },
          ok: { type: "integer", description: "Provider-accepted (HTTP 2xx at send time)" },
          delivered: { type: "integer", description: "Carrier-confirmed handset delivery (DLR webhook)" },
          bySource: {
            type: "object",
            properties: {
              bookingConfirm: { type: "integer", description: "Booking-confirmation SMS" },
              eTicket: { type: "integer", description: "Pre-race e-ticket SMS (~30 min before each heat)" },
              checkIn: { type: "integer", description: "'Now checking in' alert SMS (heat just got called)" },
              video: { type: "integer", description: "Race-video-ready SMS" },
              other: { type: "integer", description: "Admin resends, level-up, fallback" },
            },
          },
        },
      },
      SmsTotals: {
        type: "object",
        properties: {
          attempts: { type: "integer" },
          ok: { type: "integer" },
          delivered: { type: "integer" },
          bookingConfirm: { type: "integer" },
          eTicket: { type: "integer" },
          checkIn: { type: "integer" },
          video: { type: "integer" },
          other: { type: "integer" },
        },
      },
      SalesListResponse: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" },
              days: { type: "integer" },
            },
          },
          totals: {
            type: "object",
            properties: {
              reservations: { type: "integer" },
              racers: { type: "integer", description: "Sum of participantCount across all entries" },
              racingReservations: { type: "integer" },
              racingPackReservations: { type: "integer" },
              attractionReservations: { type: "integer" },
              mixedReservations: { type: "integer" },
            },
          },
          racing: { $ref: "#/components/schemas/RacingBreakdown" },
          attractions: { $ref: "#/components/schemas/AttractionsBreakdown" },
          byDay: {
            type: "array",
            items: { $ref: "#/components/schemas/DailyTotal" },
          },
          sms: {
            type: "object",
            nullable: true,
            properties: {
              totals: { $ref: "#/components/schemas/SmsTotals" },
              byDay: {
                type: "array",
                items: { $ref: "#/components/schemas/SmsDailyCounts" },
              },
            },
          },
          entries: {
            type: "array",
            items: { $ref: "#/components/schemas/SaleEntry" },
            description: "Raw reservation rows, newest first, paged to `limit`.",
          },
        },
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },

      // ── Videos ─────────────────────────────────────────────────────────
      VideoMatchEntry: {
        type: "object",
        description: [
          "One row from the videos board. `matched: true` rows have full racer + session info",
          "(linked to a Pandora session by the cron / webhook). `matched: false` rows are raw VT3",
          "videos that haven't been linked yet — staff can manually send them by supplying",
          "`overridePhone` / `overrideEmail` to /resend, which creates a real match record.",
        ].join("\n"),
        properties: {
          matched: { type: "boolean" },
          videoId: { type: "integer", description: "VT3 internal video id" },
          videoCode: { type: "string", description: "10-char VT3 share code (used as primary key)", example: "BX99JBXTQ7" },
          systemNumber: { type: "string", description: "Camera base / dock id (video.system.name)", example: "1" },
          cameraNumber: { type: "integer", description: "Hardware camera id (video.camera)", nullable: true, example: 12 },
          customerUrl: { type: "string", description: "VT3 customer-facing watch URL", example: "https://vt3.io/?code=BX99JBXTQ7" },
          thumbnailUrl: { type: "string", nullable: true },
          capturedAt: { type: "string", format: "date-time" },
          duration: { type: "number", nullable: true, description: "Seconds" },
          matchedAt: { type: "string", format: "date-time", description: "= capturedAt for unmatched rows; cron-link timestamp for matched rows" },

          // Matched-only fields ↓ — null/undefined when matched=false
          firstName: { type: "string", nullable: true },
          lastName: { type: "string", nullable: true },
          sessionId: { type: "string", nullable: true },
          personId: { type: "string", nullable: true },
          track: { type: "string", nullable: true, example: "Blue Track" },
          heatNumber: { type: "integer", nullable: true },
          raceType: { type: "string", nullable: true, example: "Starter Race" },
          email: { type: "string", format: "email", nullable: true },
          phone: { type: "string", nullable: true },

          // Overlay (VT3-derived state, mirrored from /api/cron/video-match overlay pass)
          viewed: { type: "boolean", nullable: true, description: "Customer has loaded the watch page or media-centre at least once" },
          firstViewedAt: { type: "string", format: "date-time", nullable: true },
          lastViewedAt: { type: "string", format: "date-time", nullable: true },
          purchased: { type: "boolean", nullable: true, description: "True only when VT3 marks purchaseType=PAID" },
          purchaseType: { type: "string", nullable: true, example: "PAID" },
          unlockedAt: { type: "string", format: "date-time", nullable: true },

          // Block state
          blocked: { type: "boolean", nullable: true },
          blockLevel: { type: "string", enum: ["video", "session", "person"], nullable: true },
          blockReason: { type: "string", nullable: true },
          blockedAt: { type: "string", format: "date-time", nullable: true },

          // Notify outcome — set by cron / webhook / resend handlers
          pendingNotify: { type: "boolean", nullable: true, description: "True while VT3 hasn't sampled / encoded the video yet" },
          notifySmsOk: { type: "boolean", nullable: true },
          notifySmsError: { type: "string", nullable: true },
          notifySmsSentTo: { type: "string", nullable: true },
          notifySmsSentAt: { type: "string", format: "date-time", nullable: true },
          notifyEmailOk: { type: "boolean", nullable: true },
          notifyEmailError: { type: "string", nullable: true },
          notifyEmailSentTo: { type: "string", format: "email", nullable: true },
          notifyEmailSentAt: { type: "string", format: "date-time", nullable: true },
          viaGuardian: { type: "boolean", nullable: true, description: "True when notification went to guardian instead of racer (minor + guardian fallback)" },
        },
      },
      VideoListResponse: {
        type: "object",
        properties: {
          date: { type: "string", format: "date", example: "2026-05-03" },
          total: { type: "integer", description: "Total rows after all filters" },
          returned: { type: "integer", description: "Rows in this page (≤ limit)" },
          entries: { type: "array", items: { $ref: "#/components/schemas/VideoMatchEntry" } },
        },
      },
      VideoRefreshGetResponse: {
        type: "object",
        properties: {
          videoCode: { type: "string" },
          vt3: {
            type: "object",
            description: "Raw VT3 record as returned by the VT3 API. `null` if not in the last 500.",
            nullable: true,
          },
          ours: {
            $ref: "#/components/schemas/VideoMatchEntry",
            nullable: true,
          },
        },
      },
      VideoRefreshPostResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          videoCode: { type: "string" },
          before: { type: "object", description: "Overlay fields BEFORE refresh" },
          after: { type: "object", description: "Overlay fields AFTER refresh" },
          vt3Raw: { type: "object", description: "Raw VT3 source fields used to compute the new overlay" },
        },
      },
      VideoResendBody: {
        type: "object",
        required: ["channel"],
        description: [
          "Two send modes:",
          "  • **Matched resend**: provide `sessionId` + `personId` (loads the existing match record).",
          "  • **Manual send**: provide `videoCode` + `capturedAt` + the relevant override(s) for an unmatched VT3 video.",
          "    Creates a synthetic match record so the row flips to matched on next refresh.",
        ].join("\n"),
        properties: {
          sessionId: { oneOf: [{ type: "string" }, { type: "integer" }], description: "Required for matched resend." },
          personId: { oneOf: [{ type: "string" }, { type: "integer" }], description: "Required for matched resend." },

          videoCode: { type: "string", description: "Required for manual unmatched send." },
          systemNumber: { type: "string", description: "VT3 base / dock id — manual send." },
          cameraNumber: { type: "integer", description: "VT3 hardware camera — manual send." },
          customerUrl: { type: "string", description: "VT3 customer URL — defaults to https://vt3.io/?code={videoCode} if omitted." },
          thumbnailUrl: { type: "string" },
          capturedAt: { type: "string", format: "date-time", description: "Required for manual send." },
          duration: { type: "number" },
          firstName: { type: "string" },
          lastName: { type: "string" },

          channel: { type: "string", enum: ["sms", "email", "both"] },
          overridePhone: { type: "string", description: "Send SMS here instead of the ticket's stored phone. Required for manual SMS send." },
          overrideEmail: { type: "string", format: "email", description: "Send email here instead of the ticket's stored email. Required for manual email send." },
        },
      },
      VideoResendResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          result: {
            type: "object",
            properties: {
              sms: {
                type: "object",
                nullable: true,
                properties: {
                  ok: { type: "boolean" },
                  status: { type: "integer", nullable: true },
                  sentTo: { type: "string", nullable: true },
                  error: { type: "string", nullable: true },
                },
              },
              email: {
                type: "object",
                nullable: true,
                properties: {
                  ok: { type: "boolean" },
                  status: { type: "integer", nullable: true },
                  sentTo: { type: "string", format: "email", nullable: true },
                  error: { type: "string", nullable: true },
                },
              },
            },
          },
          match: { $ref: "#/components/schemas/VideoMatchEntry" },
        },
      },
      VideoBulkResendBody: {
        type: "object",
        properties: {
          minutes: { type: "integer", default: 60, minimum: 1, maximum: 1440, description: "Lookback window — matches whose matchedAt falls within this many minutes of now are eligible." },
          dryRun: { type: "boolean", default: false, description: "Preview the candidate set without firing." },
        },
      },
      VideoBulkResendResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          dryRun: { type: "boolean" },
          windowMinutes: { type: "integer" },
          windowStart: { type: "string", format: "date-time" },
          windowEnd: { type: "string", format: "date-time" },
          candidates: { type: "integer" },
          sent: { type: "integer", description: "SMS successfully delivered." },
          queued: { type: "integer", description: "Rows pushed to the long-lived quota queue (will self-deliver after cooldown)." },
          failed: { type: "integer" },
          stoppedOnQuota: { type: "boolean" },
          skipped: { type: "integer" },
          skipReasons: { type: "object", additionalProperties: { type: "integer" } },
          candidateSample: {
            type: "array",
            description: "Only present when dryRun=true. First 20 candidates.",
            items: { type: "object" },
          },
        },
      },
      VideoBlockBody: {
        type: "object",
        required: ["videoCode", "block"],
        properties: {
          videoCode: { type: "string", example: "BX99JBXTQ7" },
          block: { type: "boolean", description: "true = block; false = unblock." },
          reason: { type: "string", description: "Optional free-text reason — stored on the match record. Truncated to 500 chars." },
        },
      },
      VideoBlockResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          block: { type: "boolean", description: "Echoes the requested action." },
          vt3Ok: { type: "boolean", description: "True if VT3's disable endpoint accepted the change." },
          stillBlocked: { type: "boolean", nullable: true, description: "Unblock-only: true when a session-level or person-level block still applies." },
          notified: { type: "boolean", nullable: true, description: "Unblock-only: true when an inline notify fired (ready video that had never been notified)." },
          vt3Linked: { type: "boolean", nullable: true, description: "Unblock-only: true when we pushed the customer email to VT3's customer profile." },
        },
      },

      // ── E-Tickets ──────────────────────────────────────────────────────
      EnrichedSmsLogEntry: {
        type: "object",
        description: "One SMS log row, joined back to the underlying race ticket / group ticket so the UI can render racer name + heat info next to the row.",
        properties: {
          ts: { type: "string", format: "date-time", description: "Send timestamp" },
          phone: { type: "string", example: "+12395551234" },
          source: { type: "string", enum: ["pre-race-cron", "checkin-cron", "admin-resend", "video-match", "booking-confirm"], example: "pre-race-cron" },
          status: { type: "integer", nullable: true, description: "Provider HTTP status at send time" },
          ok: { type: "boolean", description: "True for provider 2xx" },
          error: { type: "string", nullable: true },
          body: { type: "string", description: "Verbatim SMS body the customer received" },
          sessionIds: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] }, nullable: true },
          personIds: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] }, nullable: true },
          memberCount: { type: "integer", nullable: true },
          shortCode: { type: "string", nullable: true, description: "6-char /s/{code} redirect key — primary handle for resends + click telemetry" },
          provider: { type: "string", nullable: true, example: "voxtelesys" },
          providerMessageId: { type: "string", nullable: true, description: "Voxtelesys/Twilio id; used to correlate carrier DLR webhooks" },
          deliveryStatus: { type: "string", nullable: true, description: "Carrier DLR final state: delivered | undelivered | failed" },
          failedOver: { type: "boolean", nullable: true, description: "True when primary provider failed and we retried via Twilio" },
          viaGuardian: { type: "boolean", nullable: true },

          // Joined ticket fields
          racerNames: { type: "array", items: { type: "string" }, description: "Racer names extracted from the underlying RaceTicket / GroupTicket record" },
          track: { type: "string", nullable: true },
          heatNumber: { type: "integer", nullable: true },
          raceType: { type: "string", nullable: true },
          scheduledStart: { type: "string", format: "date-time", nullable: true },

          // Click telemetry — populated when /s/{code} has been visited
          clickCount: { type: "integer", nullable: true, description: "Number of times /s/{code} was visited" },
          clickFirst: { type: "string", format: "date-time", nullable: true },
          clickLast: { type: "string", format: "date-time", nullable: true },
        },
      },
      ETicketListResponse: {
        type: "object",
        properties: {
          date: { type: "string", format: "date" },
          total: { type: "integer" },
          returned: { type: "integer" },
          entries: { type: "array", items: { $ref: "#/components/schemas/EnrichedSmsLogEntry" } },
        },
      },
      ETicketResendBody: {
        type: "object",
        required: ["shortCode", "body"],
        properties: {
          shortCode: { type: "string", description: "Required. The 6-char /s/{code} redirect key from the SMS log entry — ties the resend back to a ticket." },
          body: { type: "string", description: "Required. Exact SMS body to resend (typically copied verbatim from the log entry)." },
          overridePhone: { type: "string", description: "Optional. Send to this E.164 number instead of the ticket's stored phone. Falls back to the ticket phone when omitted; required if the ticket is missing or has expired (12h TTL)." },
        },
      },
      ETicketResendResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          status: { type: "integer", nullable: true, description: "Provider HTTP status at send time" },
          sentTo: { type: "string", description: "E.164 number actually sent to (after canonicalization)" },
          error: { type: "string", nullable: true },
        },
      },

      // ── POV Codes ──────────────────────────────────────────────────────
      PovBreakageCodeRow: {
        type: "object",
        description: "One specific 10-char POV code on a sale row, joined to its VT3 redemption state via 5-char-prefix match.",
        properties: {
          code: { type: "string", description: "10-char POV unlock code (full plaintext from Redis pov:used). Treat as PII.", example: "ZBHT7XQF21" },
          redeemed: { type: "boolean", description: "True when VT3 marks the prefix as USED" },
          redeemedAt: { type: "string", format: "date-time", nullable: true },
          videoCode: { type: "string", nullable: true, description: "10-char VT3 share code unlocked by this POV code" },
          vt3Status: {
            type: "string",
            enum: ["ACTIVE", "USED", "REVOKED", "AMBIGUOUS", "MISSING"],
            description: "AMBIGUOUS = the 5-char prefix matches ≥ 2 VT3 records (rare); MISSING = our Redis has this code but VT3 doesn't (stale pool import).",
          },
        },
      },
      PovBreakageEntry: {
        type: "object",
        description: "One Neon sales_log row enriched with the codes we issued for that bill (Redis) and their VT3 redemption status.",
        properties: {
          billId: { type: "string", description: "BMI bill / order id from sales_log", example: "63000000003392152" },
          bookedAt: { type: "string", format: "date-time", description: "When the customer paid (Neon sales_log.ts)" },
          raceDate: { type: "string", format: "date", nullable: true, description: "YYYY-MM-DD ET — the date they BOOKED FOR. Pulled from booking-record cache; null when the booking record TTL has expired." },
          reservationNumber: { type: "string", nullable: true, example: "W23905" },
          racerName: { type: "string", nullable: true },
          email: { type: "string", format: "email", nullable: true },
          povQty: { type: "integer", description: "From Neon — number of POV products on this bill (operator truth)" },
          codesIssued: { type: "integer", description: "Codes in Redis pov:used keyed to this billId. Should equal povQty in the happy path." },
          codesRedeemed: { type: "integer", description: "Of the issued codes, how many VT3 marks USED" },
          codesActive: { type: "integer" },
          codesRevoked: { type: "integer" },
          codesAmbiguous: { type: "integer" },
          codes: {
            type: "array",
            items: { $ref: "#/components/schemas/PovBreakageCodeRow" },
            description: "Per-code rows. Length = codesIssued.",
          },
        },
      },
      PovBreakageDailyTotal: {
        type: "object",
        description: "Per-race-date roll-up. `breakage` is anchored on povSold − redeemed (operator truth), so it can be > 0 even when codesIssued matches.",
        properties: {
          ymd: { type: "string", format: "date", example: "2026-05-03" },
          salesRows: { type: "integer" },
          povSold: { type: "integer" },
          codesIssued: { type: "integer" },
          redeemed: { type: "integer" },
          breakage: { type: "integer" },
        },
      },
      PovReportPoint: {
        type: "object",
        description: "One time-bucket of VT3's video-report. All `*Count` fields are integers, ratios are 0..1 with 4-decimal precision.",
        properties: {
          siteId: { type: "integer", nullable: true, description: "FastTrax site id (992) or null when this is the cross-site aggregate" },
          from: { type: "string", description: "Bucket start (local ISO, no offset — interpret in `range.timezone`)", example: "2026-05-03T00:00:00" },
          to: { type: "string" },
          ymd: { type: "string", format: "date", description: "Convenience YYYY-MM-DD slice of `from` for chart axes" },

          // Volumes
          videoCount: { type: "integer", description: "TOTAL videos captured (every kart capture in the window)" },
          uploadedVideoCount: { type: "integer", description: "Videos that finished encoding to playable state" },
          unlockedVideoCount: { type: "integer", description: "Videos made playable to a customer (sales + free unlocks)" },
          videoSalesCount: { type: "integer", description: "TOTAL sales (paid OR consumed-via-credit). Operator term: 'sold'" },

          // Source-of-sale breakdown — these sum to videoSalesCount
          stripeVideoCount: { type: "integer", description: "Online card via Stripe (post-race vt3.io purchase). Operator term: 'online'" },
          stripeTerminalVideoCount: { type: "integer", description: "In-person card via Stripe Terminal" },
          venueVideoCount: { type: "integer", description: "Venue / cash purchase" },
          unlockCodeVideoCount: { type: "integer", description: "OUR website-issued POV unlock-codes redeemed. Operator term: 'unlock' = our web sales" },

          // Unlock-method breakdown
          preUnlockedVideoCount: { type: "integer", description: "Unlocked BEFORE race (bundle / credit pre-applied)" },
          postUnlockedVideoCount: { type: "integer", description: "Unlocked AFTER race (the standard purchase path)" },
          manualUnlockVideoCount: { type: "integer", description: "Staff override unlock (operator forced from the desk). Operator term: 'manual unlock' = our override" },
          apiUnlockVideoCount: { type: "integer", description: "API/integration unlock (none yet)" },

          // Engagement
          videoImpressionCount: { type: "integer", description: "Unique videos whose share page was opened" },
          videoPageImpressionCount: { type: "integer", description: "vt3.io/?code=X page hits (subset of impressions)" },
          mediaCentreImpressionCount: { type: "integer", description: "Media-centre tile hits (subset of impressions)" },

          // Pipeline health
          deliveryRate: { type: "number", description: "0..100 % — encoder pipeline health" },
          totalDataUp: { type: "integer", description: "Bytes uploaded — capacity planning" },
          averageVideoSize: { type: "integer", description: "Bytes / video — capacity planning" },

          // Computed conversion ratios (this endpoint adds these — VT3 doesn't return them)
          salesPerCaptured: { type: "number", description: "videoSalesCount / videoCount — what fraction of capture is monetized (0..1)" },
          unlockPerCaptured: { type: "number", description: "unlockedVideoCount / videoCount — what fraction is being watched (0..1)" },
          salesPerImpression: { type: "number", description: "videoSalesCount / videoImpressionCount — close-rate among viewers (0..1)" },
        },
      },
      PovReportTotals: {
        type: "object",
        description: "Sum of every PovReportPoint over the window, plus rolled-up conversion ratios.",
        properties: {
          videoCount: { type: "integer" },
          videoImpressionCount: { type: "integer" },
          videoPageImpressionCount: { type: "integer" },
          mediaCentreImpressionCount: { type: "integer" },
          unlockedVideoCount: { type: "integer" },
          videoSalesCount: { type: "integer" },
          stripeVideoCount: { type: "integer" },
          stripeTerminalVideoCount: { type: "integer" },
          venueVideoCount: { type: "integer" },
          unlockCodeVideoCount: { type: "integer" },
          preUnlockedVideoCount: { type: "integer" },
          postUnlockedVideoCount: { type: "integer" },
          uploadedVideoCount: { type: "integer" },
          manualUnlockVideoCount: { type: "integer" },
          apiUnlockVideoCount: { type: "integer" },
          totalDataUp: { type: "integer" },
          averageVideoSize: { type: "integer" },
          salesPerCaptured: { type: "number" },
          unlockPerCaptured: { type: "number" },
          salesPerImpression: { type: "number" },
        },
      },
      PovReportResponse: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" },
              days: { type: "integer" },
              timezone: { type: "string", example: "America/New_York" },
              interval: { type: "string", enum: ["hours", "days", "weeks", "months"] },
            },
          },
          sites: { type: "array", items: { type: "integer" }, description: "Sites the report covers (e.g. [992] = FastTrax)" },
          totals: { $ref: "#/components/schemas/PovReportTotals" },
          byInterval: {
            type: "array",
            items: { $ref: "#/components/schemas/PovReportPoint" },
            description: "One row per interval bucket (per the `interval` request param). FastTrax-only when present, otherwise the cross-site aggregate.",
          },
        },
      },
      PovBreakageResponse: {
        type: "object",
        properties: {
          range: {
            type: "object",
            properties: {
              from: { type: "string", format: "date" },
              to: { type: "string", format: "date" },
              days: { type: "integer" },
            },
          },
          totals: {
            type: "object",
            properties: {
              salesRows: { type: "integer", description: "Number of POV sales rows in window (Neon sales_log.pov_purchased = true)" },
              povSold: { type: "integer", description: "SUM(pov_qty) — operator-truth issued count from Neon" },
              codesIssued: { type: "integer", description: "Codes popped out of the Redis pool for those bills. Usually ≥ povSold (~1.36× in current data)." },
              issuanceGap: { type: "integer", description: "Bills sold POVs in Neon but have NO codes in Redis. Should be 0 in the happy path; > 0 = pipeline gap to investigate." },
              redeemed: { type: "integer", description: "Codes VT3 marks as USED (5-char-prefix match)" },
              active: { type: "integer", description: "Issued, not redeemed, not revoked" },
              revoked: { type: "integer" },
              ambiguous: { type: "integer", description: "Codes whose 5-char prefix matches ≥ 2 VT3 records (rare)" },
              missingFromVt3: { type: "integer", description: "In Redis but no VT3 record — stale pool imports" },
              breakage: { type: "integer", description: "povSold − redeemed. Dollar value sitting unclaimed." },
              redemptionPct: { type: "number", description: "redeemed / povSold (0..1, 4 decimals). Anchored on operator truth — this is the headline number." },
              breakagePct: { type: "number", description: "breakage / povSold (0..1, 4 decimals)" },
            },
          },
          pool: {
            type: "object",
            description: "Health of the available code pool — staff watch this to know when to import more.",
            properties: {
              available: { type: "integer", description: "Codes still in pov:codes Redis SET, ready to be issued" },
            },
          },
          byDay: {
            type: "array",
            items: { $ref: "#/components/schemas/PovBreakageDailyTotal" },
            description: "Per-race-date counts within the filter window. Useful for charting redemption decay.",
          },
          excluded: {
            type: "object",
            description: "Diagnostic counts for sales filtered out of the in-range slice.",
            properties: {
              outOfRange: { type: "integer", description: "Sales whose race date (or fallback booking ts) sits outside [from, to]" },
              noDate: { type: "integer", description: "Sales with no booking record AND no booking ts — should always be 0 in practice" },
            },
          },
          returned: { type: "integer" },
          entries: {
            type: "array",
            items: { $ref: "#/components/schemas/PovBreakageEntry" },
            description: "Raw per-bill rows newest-first by bookedAt, paged to `limit`. Aggregations always cover the full filtered set, not just this page.",
          },
        },
      },
    },
  },
  paths: {
    "/api/admin/sales/list": {
      get: {
        tags: ["Sales"],
        summary: "Sales report (aggregations + raw entries)",
        description: [
          "Returns aggregated metrics (totals, racing breakdown, attractions, daily volume, SMS)",
          "plus an array of raw reservation entries for the requested ET-day range.",
          "",
          "All percentages are pre-computed (one decimal place) so consumers don't need to do math.",
          "All dates are ET-bucketed; the response's `byDay` rows are aligned to the same calendar.",
        ].join("\n"),
        parameters: [
          {
            name: "from",
            in: "query" as const,
            description: "Start date (ET) — inclusive. Format YYYY-MM-DD. Defaults to today.",
            schema: { type: "string", format: "date", example: "2026-04-25" },
          },
          {
            name: "to",
            in: "query" as const,
            description: "End date (ET) — inclusive. Format YYYY-MM-DD. Defaults to today.",
            schema: { type: "string", format: "date", example: "2026-05-02" },
          },
          {
            name: "limit",
            in: "query" as const,
            description: "Max number of raw reservation entries returned in `entries[]`. Aggregations are always computed across the full range. Default 1000.",
            schema: { type: "integer", default: 1000, minimum: 1, maximum: 10000 },
          },
        ],
        responses: {
          "200": {
            description: "Sales report",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SalesListResponse" },
              },
            },
          },
          "401": {
            description: "Unauthorized — missing or invalid x-api-key",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
          "404": {
            description: "Endpoint hidden — same body as 401 to avoid leaking that the path exists.",
          },
          "500": {
            description: "Server error (Postgres / Redis hiccup)",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
            },
          },
        },
      },
    },
    "/api/admin/sales/openapi.json": {
      get: {
        tags: ["Sales"],
        summary: "OpenAPI 3.0 spec (this document)",
        description: "Returns this OpenAPI 3.0 specification. No auth required — exposed for tooling discovery.",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI 3.0 spec (application/json)",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    },

    // ── Videos ──────────────────────────────────────────────────────────
    "/api/admin/videos/list": {
      get: {
        tags: ["Videos"],
        summary: "List race-video matches for an ET day",
        description: [
          "Returns a merged list of (a) match records the cron / webhook has linked to a Pandora session,",
          "and (b) raw VT3 videos in the same ET window that haven't been linked yet.",
          "Matched rows carry full racer + session + heat info; unmatched rows carry only the VT3 fields",
          "and let staff manually send via /api/admin/videos/resend with overridePhone / overrideEmail.",
        ].join("\n"),
        parameters: [
          { name: "date", in: "query" as const, schema: { type: "string", format: "date" }, description: "YYYY-MM-DD ET day. Defaults to today." },
          { name: "show", in: "query" as const, schema: { type: "string", enum: ["all", "matched", "unmatched"], default: "all" }, description: "Filter by match state." },
          { name: "q", in: "query" as const, schema: { type: "string" }, description: "Free-text — racer name, camera number, video code, phone digits. Case-insensitive." },
          { name: "status", in: "query" as const, schema: { type: "string", enum: ["notified", "unnotified", "failed"] }, description: "Filter matched rows by notify outcome. Ignored for unmatched (no send state yet)." },
          { name: "limit", in: "query" as const, schema: { type: "integer", default: 200, minimum: 1, maximum: 500 } },
        ],
        responses: {
          "200": {
            description: "Video list",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoListResponse" } } },
          },
          "400": { description: "Invalid date format", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized — missing or invalid x-api-key" },
          "404": { description: "Endpoint hidden — same body as 401 to avoid leaking that the path exists." },
          "500": { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/api/admin/videos/refresh": {
      get: {
        tags: ["Videos"],
        summary: "Inspect a single video — VT3 raw vs. our match",
        description: [
          "Read-only debug endpoint. Pulls VT3's most recent 500 videos for the FastTrax site,",
          "finds the one with the supplied videoCode, and returns both the raw VT3 record and our",
          "stored match record side-by-side. Useful for explaining 'why does our admin show X but VT3",
          "shows Y' (typically stale unlockTime / purchaseType).",
        ].join("\n"),
        parameters: [
          { name: "videoCode", in: "query" as const, required: true, schema: { type: "string" }, description: "10-char VT3 share code." },
        ],
        responses: {
          "200": {
            description: "VT3 + our record side-by-side",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoRefreshGetResponse" } } },
          },
          "400": { description: "Missing videoCode", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized" },
          "500": { description: "VT3 fetch failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
      post: {
        tags: ["Videos"],
        summary: "Re-apply VT3 overlay onto our stored match record",
        description: [
          "Mutating sibling of GET. Pulls VT3 live data for the videoCode and rewrites our match record's",
          "viewed / firstViewedAt / lastViewedAt / purchased / purchaseType / unlockedAt fields to the latest VT3 values.",
          "Useful when the cron's 200-record window has scrolled past an older video and stale fields linger.",
        ].join("\n"),
        parameters: [
          { name: "videoCode", in: "query" as const, required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Refresh applied — before/after diff plus VT3 source fields",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoRefreshPostResponse" } } },
          },
          "400": { description: "Missing videoCode" },
          "401": { description: "Unauthorized" },
          "404": {
            description: "videoCode not found in VT3 latest 500 OR no match record exists",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "500": { description: "Refresh failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/api/admin/videos/resend": {
      post: {
        tags: ["Videos"],
        summary: "Resend (or manual-send) a race-video notification",
        description: [
          "Two send modes — pick one set of inputs:",
          "",
          "**Matched resend**: provide `sessionId` + `personId`. Loads the existing match record,",
          "rebuilds the exact SMS body + email HTML the cron would have sent, fires to the override",
          "(if any) or the snapshotted contact. Logs SMS with source='admin-resend'.",
          "",
          "**Manual unmatched send**: provide `videoCode` + `capturedAt` + override(s). Builds a synthetic",
          "match record and sends. On success, the match is persisted so the row flips to matched on the next list refresh.",
        ].join("\n"),
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VideoResendBody" } } },
        },
        responses: {
          "200": {
            description: "Send attempt result (ok=true even when one channel fails — inspect result.{sms,email})",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoResendResponse" } } },
          },
          "400": {
            description: "Invalid body — missing channel, missing required fields for the chosen send mode, or bad JSON",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
          },
          "401": { description: "Unauthorized" },
          "404": { description: "Match not found and no fallback to manual send", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/api/admin/videos/bulk-resend": {
      post: {
        tags: ["Videos"],
        summary: "Bulk re-fire video-ready SMS over a recent window",
        description: [
          "Re-sends the video-ready SMS for every match whose `matchedAt` falls within the last `minutes` and",
          "has a usable contact (racer-first, guardian-fallback for minor racers). Skips manual-send synthetic",
          "records and matches still pending VT3 upload.",
          "",
          "On hitting Vox / Twilio quota, remaining candidates are pushed onto the long-lived",
          "`sms:quota:queue` and self-deliver after the cooldown — no work is dropped.",
          "",
          "Use `dryRun: true` to preview the candidate set before firing.",
        ].join("\n"),
        requestBody: {
          required: false,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VideoBulkResendBody" } } },
        },
        responses: {
          "200": {
            description: "Bulk run result (or dry-run preview when dryRun=true)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoBulkResendResponse" } } },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/api/admin/videos/block": {
      post: {
        tags: ["Videos"],
        summary: "Block or unblock a race video",
        description: [
          "**Block**: writes a video-level block key, calls VT3 to disable the share URL, and patches our",
          "match record's blocked mirror so the videos board renders the block chip. If a match record",
          "exists and was sitting as pendingNotify, that flag is cleared (blocked records don't fire SMS).",
          "",
          "**Unblock**: removes our block key, re-resolves heat-level + person-level blocks (some may still",
          "apply, in which case `stillBlocked: true` and VT3 stays disabled), re-enables on VT3 if not still",
          "blocked, and — if the match was never notified and VT3 reports the video is ready — pushes the",
          "customer email to VT3 + fires notify inline so the customer doesn't have to wait for the next cron tick.",
        ].join("\n"),
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VideoBlockBody" } } },
        },
        responses: {
          "200": {
            description: "Block / unblock result",
            content: { "application/json": { schema: { $ref: "#/components/schemas/VideoBlockResponse" } } },
          },
          "400": { description: "Missing videoCode", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized" },
          "500": { description: "Block / unblock failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },

    // ── E-Tickets ──────────────────────────────────────────────────────
    "/api/admin/e-tickets/list": {
      get: {
        tags: ["E-Tickets"],
        summary: "List per-message SMS log for an ET day, enriched with ticket info",
        description: [
          "Reads the SMS log for the given date and joins each row back to the underlying RaceTicket /",
          "GroupTicket via the shortCode → /s/{code} → /t/{id} or /g/{id} chain.",
          "",
          "Default view excludes `video-match` (covered by the Videos board) and `booking-confirm` (covered",
          "by the sales dashboard). Pass `source=video-match` or `source=booking-confirm` to drill in.",
          "",
          "Each row also carries click telemetry (`clickCount`, `clickFirst`, `clickLast`) when the customer",
          "has visited the /s/{code} short URL.",
        ].join("\n"),
        parameters: [
          { name: "date", in: "query" as const, schema: { type: "string", format: "date" }, description: "YYYY-MM-DD ET. Defaults to today." },
          { name: "source", in: "query" as const, schema: { type: "string", enum: ["pre-race-cron", "checkin-cron", "admin-resend", "video-match", "booking-confirm"] }, description: "Filter to a single source. Default view excludes video-match + booking-confirm." },
          { name: "phone", in: "query" as const, schema: { type: "string" }, description: "Exact E.164 match." },
          { name: "sessionId", in: "query" as const, schema: { type: "string" }, description: "Entry must cover this session id." },
          { name: "personId", in: "query" as const, schema: { type: "string" }, description: "Entry must cover this person id." },
          { name: "q", in: "query" as const, schema: { type: "string" }, description: "Free-text — racer name, phone digits, or shortCode. Case-insensitive." },
          { name: "limit", in: "query" as const, schema: { type: "integer", default: 100, minimum: 1, maximum: 500 } },
          { name: "offset", in: "query" as const, schema: { type: "integer", default: 0, minimum: 0 } },
        ],
        responses: {
          "200": {
            description: "Enriched SMS log",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ETicketListResponse" } } },
          },
          "400": { description: "Invalid date format", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized" },
          "500": { description: "Server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    // ── POV Codes ──────────────────────────────────────────────────────
    "/api/admin/pov-codes/report": {
      get: {
        tags: ["POV Codes"],
        summary: "VT3 viewpoint video-report — captured, sold, unlocked, impressions, conversions",
        description: [
          "Pulls VT3's `/reporting/video-report` for the FastTrax site and surfaces every counter VT3",
          "exposes plus three computed conversion ratios.",
          "",
          "**Operator-language → API field map**:",
          "  • `sold` (total) → `videoSalesCount`",
          "  • `online` (post sales via vt3.io card purchase) → `stripeVideoCount` (also see `postUnlockedVideoCount`)",
          "  • `unlock` (our website-issued POV codes redeemed) → `unlockCodeVideoCount`",
          "  • `manual unlock` (staff override) → `manualUnlockVideoCount`",
          "",
          "**Volumes**:",
          "  • `videoCount` — every kart capture in the window (totals all-up)",
          "  • `uploadedVideoCount` — captures that finished encoding",
          "  • `unlockedVideoCount` — videos made playable (sales + free unlocks)",
          "",
          "**Engagement**:",
          "  • `videoImpressionCount` = `videoPageImpressionCount` + `mediaCentreImpressionCount`",
          "",
          "**Conversions (added by us)**:",
          "  • `salesPerCaptured` = videoSalesCount / videoCount",
          "  • `unlockPerCaptured` = unlockedVideoCount / videoCount",
          "  • `salesPerImpression` = videoSalesCount / videoImpressionCount",
          "",
          "Window is bucketed per the `interval` param (default daily). Date filter is ET; the endpoint",
          "applies the right DST offset before calling VT3.",
        ].join("\n"),
        parameters: [
          { name: "from", in: "query" as const, description: "ET start date (inclusive). YYYY-MM-DD. Default = 30 days ago.", schema: { type: "string", format: "date" } },
          { name: "to", in: "query" as const, description: "ET end date (inclusive — endpoint bumps this by 1 day before calling VT3). YYYY-MM-DD. Default = today.", schema: { type: "string", format: "date" } },
          { name: "interval", in: "query" as const, description: "Bucket granularity. Default `days`.", schema: { type: "string", enum: ["hours", "days", "weeks", "months"], default: "days" } },
        ],
        responses: {
          "200": {
            description: "Video report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PovReportResponse" } } },
          },
          "400": { description: "Invalid date or interval", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized" },
          "404": { description: "Endpoint hidden — same body as 401" },
          "500": { description: "VT3 fetch failed", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },

    "/api/admin/pov-codes/breakage": {
      get: {
        tags: ["POV Codes"],
        summary: "POV redemption + breakage report",
        description: [
          "Three-source cross-reference — Neon is the issued source-of-truth, VT3 is the redemption truth,",
          "Redis is the bridge that lets us go from a sale to a specific 10-char code:",
          "",
          "  1. **Neon `sales_log`** — every confirmed POV sale (`pov_purchased = true`, summed via `pov_qty`).",
          "     This is the operator-truth issued count; the headline `redemptionPct` is anchored on it.",
          "  2. **Redis `pov:used`** — codes popped out of the available pool for each billId. Bridges Neon",
          "     bills to specific codes for per-row inspection.",
          "  3. **VT3 `POST /unlock-codes`** — redemption registry. Status `USED` + `redeemedAt` set means",
          "     the customer entered the code on vt3.io and unlocked their video.",
          "",
          "**Cross-reference quirk**: VT3 returns codes MASKED in the API response (`ZBHT7*****`). Our Redis",
          "hash has full plaintext. We match by the first-5-character visible prefix; collision rate at our",
          "volume is ~0.06%. Ambiguous matches surface as a separate counter rather than silently miscounted.",
          "",
          "**Date filter targets the RACE date** (the ET day they booked the race for), pulled from the",
          "`bookingrecord:{billId}` Redis cache. Sales without a booking record fall back to the booking",
          "timestamp's ET day so they stay visible.",
          "",
          "**Headline number**: `totals.redemptionPct` = `redeemed / povSold`. Industry baseline for digital",
          "voucher redemption is 30–50%; sub-30% is worth investigating.",
        ].join("\n"),
        parameters: [
          { name: "from", in: "query" as const, description: "Race-date lower bound (ET, inclusive). YYYY-MM-DD. Default = 30 days ago.", schema: { type: "string", format: "date" } },
          { name: "to", in: "query" as const, description: "Race-date upper bound (ET, inclusive). YYYY-MM-DD. Default = today.", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query" as const, description: "Max raw rows in `entries[]`. Aggregations always span the full filtered set. Default 1000.", schema: { type: "integer", default: 1000, minimum: 1, maximum: 5000 } },
        ],
        responses: {
          "200": {
            description: "Breakage report",
            content: { "application/json": { schema: { $ref: "#/components/schemas/PovBreakageResponse" } } },
          },
          "400": { description: "Invalid date format", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized — missing or invalid x-api-key" },
          "404": { description: "Endpoint hidden — same body as 401 to avoid leaking that the path exists." },
          "500": { description: "Server error (Redis / VT3 / booking-record hiccup)", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },

    "/api/admin/e-tickets/resend": {
      post: {
        tags: ["E-Tickets"],
        summary: "Resend a single e-ticket SMS by shortCode",
        description: [
          "Sends `body` to the ticket's stored phone (or `overridePhone` when supplied). Logs the send",
          "with source='admin-resend' so audits distinguish it from cron-fired deliveries.",
          "",
          "Body is passed in verbatim from the UI — no reconstruction from ticket data. Trusts the auth-gated caller.",
          "",
          "Failures fail loudly (no retry queue) so the operator sees the error and can correct manually.",
        ].join("\n"),
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ETicketResendBody" } } },
        },
        responses: {
          "200": {
            description: "Send result — ok=true means provider 2xx, false means provider rejected",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ETicketResendResponse" } } },
          },
          "400": { description: "Invalid body or invalid phone", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          "401": { description: "Unauthorized" },
          "404": { description: "Ticket not found / shortCode expired AND no overridePhone supplied", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(spec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-api-key, x-admin-token, content-type",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "x-api-key, x-admin-token, content-type",
    },
  });
}
