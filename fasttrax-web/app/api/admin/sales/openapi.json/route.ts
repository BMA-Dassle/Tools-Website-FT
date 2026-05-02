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
    title: "FastTrax Sales Admin API",
    description: [
      "Read-only sales reporting for the FastTrax + HeadPinz web reservations dashboard.",
      "",
      "**Auth**: every request requires the `x-api-key` header (or `?apiKey=` query param).",
      "Keys are issued by FastTrax ops and rotated centrally — request one from the operator team.",
      "",
      "**Time zone**: all date params and `byDay` rows are bucketed in `America/New_York` (ET).",
      "Reservations made between midnight UTC and 4 AM ET roll into the *previous* ET calendar day.",
      "",
      "**Range cap**: aggregations are computed live against Postgres + Redis on every request.",
      "Practical max range is ~90 days — the underlying SMS log retains 90 days, sales_log has no cap.",
    ].join("\n"),
    version: "1.0.0",
    contact: {
      name: "FastTrax Operations",
      email: "ops@fasttraxent.com",
    },
  },
  servers: [
    { url: "https://fasttraxent.com", description: "Production" },
    { url: "https://headpinz.com", description: "Production (HeadPinz brand mirror — same data)" },
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
    },
  },
  paths: {
    "/api/admin/sales/list": {
      get: {
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
