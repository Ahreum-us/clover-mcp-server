import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";

const CLOVER_ID = z.string().regex(/^[A-Z0-9]+$/i, "must be alphanumeric").max(40);

// Clover has no native reservations — stored in a local JSON file.
// In production this would be a proper database.
const RESERVATIONS_FILE = join(process.env.RESERVATIONS_PATH ?? ".", "reservations.json");

interface Reservation {
  id: string;
  customerId?: string;
  customerName: string;
  phone?: string;
  partySize: number;
  date: string;
  time: string;
  notes?: string;
  status: "confirmed" | "cancelled" | "seated" | "no-show";
  createdAt: string;
}

function loadReservations(): Reservation[] {
  if (!existsSync(RESERVATIONS_FILE)) return [];
  try { return JSON.parse(readFileSync(RESERVATIONS_FILE, "utf-8")); } catch { return []; }
}

function saveReservations(data: Reservation[]) {
  writeFileSync(RESERVATIONS_FILE, JSON.stringify(data, null, 2));
}

export function registerReservationTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "create_reservation",
    "Book a table reservation. Stores locally and optionally links to a Clover customer record.",
    {
      customerName: z.string().min(1).max(200),
      partySize: z.number().int().positive().max(500).describe("Number of guests"),
      date: z.string().max(20).describe("Reservation date e.g. 2026-06-10"),
      time: z.string().max(20).describe("Reservation time e.g. 7:00 PM"),
      phone: z.string().max(50).optional(),
      notes: z.string().max(1000).optional().describe("Special requests, allergies, occasion, etc."),
      customerId: CLOVER_ID.optional().describe("Link to existing Clover customer ID if known"),
    },
    async ({ customerName, partySize, date, time, phone, notes, customerId }) => {
      const reservations = loadReservations();
      const id = `RES-${randomUUID()}`;

      const reservation: Reservation = {
        id,
        customerId,
        customerName,
        phone,
        partySize,
        date,
        time,
        notes,
        status: "confirmed",
        createdAt: new Date().toISOString(),
      };

      reservations.push(reservation);
      saveReservations(reservations);

      if (customerId) {
        const customer = await clover.get<any>(clover.v3(`/customers/${customerId}`));
        const existingNote = customer.note ?? "";
        await clover.post<any>(clover.v3(`/customers/${customerId}`), {
          note: `${existingNote}\nReservation ${id}: ${date} at ${time}, party of ${partySize}${notes ? `. Notes: ${notes}` : ""}`.trim(),
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId: id,
            status: "confirmed",
            summary: `${customerName} — party of ${partySize} on ${date} at ${time}`,
            notes: notes ?? null,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_reservations",
    "Get all reservations for a specific date or date range.",
    {
      date: z.string().max(20).optional().describe("ISO date string e.g. 2026-06-10. Defaults to today."),
      status: z.enum(["all", "confirmed", "cancelled", "seated", "no-show"]).optional().default("confirmed"),
    },
    async ({ date, status }) => {
      const targetDate = date ?? new Date().toISOString().split("T")[0];
      const reservations = loadReservations().filter(r =>
        r.date === targetDate && (status === "all" || r.status === status)
      ).sort((a, b) => a.time.localeCompare(b.time));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: targetDate,
            totalCovers: reservations.reduce((s, r) => s + r.partySize, 0),
            reservations,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "update_reservation_status",
    "Update a reservation status: confirm, seat, mark no-show, or cancel.",
    {
      reservationId: z.string().min(1).max(60),
      status: z.enum(["confirmed", "seated", "no-show", "cancelled"]),
      notes: z.string().max(500).optional().describe("Optional note to append"),
    },
    async ({ reservationId, status, notes }) => {
      const reservations = loadReservations();
      const idx = reservations.findIndex(r => r.id === reservationId);

      if (idx === -1) {
        return { content: [{ type: "text", text: `Reservation ${reservationId} not found.` }] };
      }

      reservations[idx].status = status;
      if (notes) reservations[idx].notes = `${reservations[idx].notes ?? ""} | ${notes}`.trim();
      saveReservations(reservations);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            reservationId,
            updatedStatus: status,
            reservation: reservations[idx],
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_reservation_summary",
    "Overview of upcoming reservations: total covers, busiest time slots, special requests.",
    {
      date: z.string().max(20).optional().describe("ISO date string. Defaults to today."),
    },
    async ({ date }) => {
      const targetDate = date ?? new Date().toISOString().split("T")[0];
      const reservations = loadReservations().filter(r => r.date === targetDate && r.status !== "cancelled");

      const byHour: Record<string, number> = {};
      const specialRequests = reservations.filter(r => r.notes).map(r => ({
        name: r.customerName,
        time: r.time,
        party: r.partySize,
        note: r.notes,
      }));

      for (const r of reservations) {
        byHour[r.time] = (byHour[r.time] ?? 0) + r.partySize;
      }

      const peakTime = Object.entries(byHour).sort(([, a], [, b]) => b - a)[0];

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: targetDate,
            totalReservations: reservations.length,
            totalCovers: reservations.reduce((s, r) => s + r.partySize, 0),
            peakTime: peakTime ? `${peakTime[0]} (${peakTime[1]} covers)` : "No reservations",
            specialRequests,
          }, null, 2),
        }],
      };
    }
  );
}
