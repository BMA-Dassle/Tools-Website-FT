import { NextResponse } from "next/server";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "FastTrax Booking Record API",
    description: "Read booking records for check-in integration. All endpoints require `x-api-key` header.",
    version: "1.0.0",
  },
  servers: [
    { url: "https://fasttraxent.com", description: "Production" },
    { url: "http://localhost:3000", description: "Development" },
  ],
  security: [{ ApiKeyAuth: [] }],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey" as const,
        in: "header" as const,
        name: "x-api-key",
      },
    },
    schemas: {
      RacerAssignment: {
        type: "object",
        properties: {
          racerName: { type: "string", example: "Eric Osborn" },
          personId: { type: "string", example: "409523", nullable: true },
          product: { type: "string", example: "Starter Race Blue" },
          productId: { type: "string", example: "24965505" },
          tier: { type: "string", enum: ["starter", "intermediate", "pro"] },
          track: { type: "string", example: "Blue", nullable: true },
          category: { type: "string", enum: ["adult", "junior"] },
          heatName: { type: "string", example: "Heat 26" },
          heatStart: { type: "string", format: "date-time", example: "2026-04-07T16:00:00" },
          heatStop: { type: "string", format: "date-time", nullable: true },
        },
      },
      Contact: {
        type: "object",
        properties: {
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string", format: "email" },
          phone: { type: "string" },
        },
      },
      BookingRecord: {
        type: "object",
        properties: {
          billId: { type: "string", description: "BMI bill/order ID" },
          billIds: { type: "array", items: { type: "string" } },
          contact: { $ref: "#/components/schemas/Contact" },
          primaryPersonId: { type: "string", nullable: true },
          racers: { type: "array", items: { $ref: "#/components/schemas/RacerAssignment" } },
          isCreditOrder: { type: "boolean" },
          cashOwed: { type: "number" },
          creditApplied: { type: "number" },
          totalAmount: { type: "number" },
          date: { type: "string", format: "date", description: "Race date YYYY-MM-DD" },
          status: { type: "string", enum: ["pending_payment", "confirmed"], description: "pending_payment before checkout, confirmed after" },
          reservationNumber: { type: "string", description: "BMI reservation number (e.g. W23905). Set after payment confirmation.", nullable: true },
          reservationCode: { type: "string", description: "QR code value for check-in scanning", nullable: true },
          confirmations: {
            type: "array",
            nullable: true,
            items: {
              type: "object",
              properties: {
                billId: { type: "string" },
                racerName: { type: "string" },
                resNumber: { type: "string" },
                resCode: { type: "string" },
              },
            },
          },
          createdAt: { type: "string", format: "date-time" },
          confirmedAt: { type: "string", format: "date-time", nullable: true },
          updatedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
  paths: {
    "/api/booking-record": {
      get: {
        summary: "Look up booking records",
        description: "Query by billId, reservation number, personId, or date. Returns a single record or array depending on query type.",
        parameters: [
          { name: "billId", in: "query" as const, schema: { type: "string" }, description: "BMI bill/order ID" },
          { name: "resNumber", in: "query" as const, schema: { type: "string" }, description: "Reservation number (e.g. W23905)" },
          { name: "personId", in: "query" as const, schema: { type: "string" }, description: "BMI person ID — returns array of all bookings for this person" },
          { name: "date", in: "query" as const, schema: { type: "string", format: "date" }, description: "Race date YYYY-MM-DD — returns array of all bookings on this date" },
        ],
        responses: {
          "200": {
            description: "Booking record(s)",
            content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/BookingRecord" }, { type: "array", items: { $ref: "#/components/schemas/BookingRecord" } }] } } },
          },
          "401": { description: "Unauthorized — missing or invalid x-api-key" },
          "404": { description: "Record not found" },
        },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(spec, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
