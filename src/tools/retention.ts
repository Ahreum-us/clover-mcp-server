import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { resolvePeriod } from "../lib/date.js";

const CLOVER_ID = z.string().regex(/^[A-Z0-9]+$/i, "must be alphanumeric").max(40);

export function registerRetentionTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "get_lapsed_customers",
    "Find customers who haven't visited in a while. Great for win-back campaigns.",
    {
      daysSinceVisit: z.number().int().positive().max(3650).optional().default(30)
        .describe("Flag customers who haven't visited in this many days"),
      minPastVisits: z.number().int().positive().max(1000).optional().default(2)
        .describe("Only include customers with at least this many past visits (filters out one-timers)"),
    },
    async ({ daysSinceVisit, minPastVisits }) => {
      const cutoff = Date.now() - daysSinceVisit * 24 * 60 * 60 * 1000;
      const lookback = Date.now() - 365 * 24 * 60 * 60 * 1000;

      // PHASE 3: migrated from get(limit:1000) to getAll() — busy restaurants
      // exceed 1000 paid orders/year and would silently truncate.
      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${lookback}`, "paymentState=PAID"],
        expand: "customers",
      });

      const customerActivity: Record<string, {
        name: string; lastVisit: number; visits: number; totalCents: number;
      }> = {};

      for (const order of orders) {
        const c = (order as any).customers?.elements?.[0];
        if (!c?.id) continue;
        const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
        if (!customerActivity[c.id]) customerActivity[c.id] = { name, lastVisit: 0, visits: 0, totalCents: 0 };
        if ((order as any).createdTime > customerActivity[c.id].lastVisit) {
          customerActivity[c.id].lastVisit = (order as any).createdTime;
        }
        customerActivity[c.id].visits++;
        customerActivity[c.id].totalCents += (order as any).total ?? 0;
      }

      const lapsed = Object.entries(customerActivity)
        .filter(([, v]) => v.lastVisit < cutoff && v.visits >= minPastVisits)
        .sort(([, a], [, b]) => b.totalCents - a.totalCents)
        .map(([id, v]) => ({
          id,
          name: v.name,
          lastVisit: new Date(v.lastVisit).toDateString(),
          daysSinceVisit: Math.floor((Date.now() - v.lastVisit) / 1000 / 60 / 60 / 24),
          totalVisits: v.visits,
          lifetimeSpend: `$${(v.totalCents / 100).toFixed(2)}`,
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            lapsedCustomers: lapsed.length,
            customers: lapsed,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "draft_winback_message",
    "Generate a personalized win-back message for a lapsed customer via WhatsApp or SMS.",
    {
      customerId: CLOVER_ID.describe("Clover customer ID"),
      restaurantName: z.string().max(200).optional().default("our restaurant"),
      offerDetail: z.string().max(300).optional().describe("Optional promo to include e.g. '10% off your next visit'"),
      channel: z.enum(["whatsapp", "sms", "email"]).optional().default("whatsapp"),
      language: z.string().max(20).optional().describe("BCP-47 language code (e.g. 'vi', 'ko', 'es'). Defaults to English."),
    },
    async ({ customerId, restaurantName, offerDetail, channel, language }) => {
      const [profile, orders] = await Promise.all([
        clover.get<any>(clover.v3(`/customers/${customerId}`), {
          expand: "phoneNumbers,emailAddresses",
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: [`customers.id=${customerId}`, "paymentState=PAID"],
          expand: "lineItems",
          limit: 10,
          orderBy: "createdTime DESC",
        }),
      ]);

      const firstName = profile.firstName ?? "there";
      const favItem = (() => {
        const counts: Record<string, number> = {};
        for (const o of orders.elements ?? []) {
          for (const li of o.lineItems?.elements ?? []) {
            counts[li.name ?? ""] = (counts[li.name ?? ""] ?? 0) + 1;
          }
        }
        return Object.entries(counts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
      })();

      const offer = offerDetail ? `\n\n🎁 Special offer just for you: ${offerDetail}` : "";
      const favLine = favItem ? ` Your ${favItem} is waiting for you!` : "";

      const messages: Record<string, string> = {
        whatsapp: `Hi ${firstName}! 👋 It's been a while since we've seen you at ${restaurantName}.${favLine} We miss you and hope you're doing well!${offer}\n\nCome visit us soon — we'd love to see you again. 🍜`,
        sms: `Hi ${firstName}, it's ${restaurantName}! We miss you — come back soon.${favItem ? ` Your ${favItem} is ready!` : ""}${offerDetail ? ` ${offerDetail}.` : ""}`,
        email: `Subject: We miss you, ${firstName}!\n\nHi ${firstName},\n\nIt's been a while since your last visit to ${restaurantName}, and we wanted to reach out.${favLine}${offer}\n\nWe hope to see you again soon!\n\nWarm regards,\n${restaurantName}`,
      };

      const contact = channel === "email"
        ? profile.emailAddresses?.elements?.[0]?.emailAddress
        : profile.phoneNumbers?.elements?.[0]?.phoneNumber;

      const result: Record<string, any> = {
        customer: firstName,
        channel,
        contact: contact ?? "No contact info on file",
        message: messages[channel],
      };

      if (language && language !== "en") {
        result._language_directive = `Rewrite the message field naturally in the language with BCP-47 code: ${language}. Keep the warm, personal tone. Do not translate the restaurant name.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    server,
    "get_customer_birthdays",
    "Find customers with birthdays this month for outreach. Requires birthday to be stored in customer note as 'birthday: MM/DD'.",
    {
      month: z.number().int().min(1).max(12).optional().describe("Month number 1-12. Defaults to current month."),
    },
    async ({ month }) => {
      const targetMonth = month ?? new Date().getMonth() + 1;
      // F4 fix: getAll instead of get(limit:500) — merchants with >500
      // customers silently missed birthdays past the cap.
      const customers = await clover.getAll<any>(clover.v3("/customers"), {
        expand: "phoneNumbers,emailAddresses",
      });

      const birthdayPattern = /b(?:irth)?(?:day)?[:\s]+(\d{1,2})[\/\-](\d{1,2})/i;
      const matches = customers.filter((c: any) => {
        if (!c.note) return false;
        const m = c.note.match(birthdayPattern);
        if (!m) return false;
        return parseInt(m[1]) === targetMonth;
      }).map((c: any) => {
        const m = c.note.match(birthdayPattern);
        return {
          name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
          id: c.id,
          birthday: m ? `${m[1]}/${m[2]}` : "see note",
          phone: c.phoneNumbers?.elements?.[0]?.phoneNumber ?? null,
          note: c.note,
        };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            month: targetMonth,
            birthdaysFound: matches.length,
            tip: "Store birthdays in customer notes as 'birthday: MM/DD' to enable this feature.",
            customers: matches,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_first_time_customers",
    "Identify new customers who visited for the first time in a given period.",
    {
      period: z.enum(["today", "yesterday", "week"]).optional().default("week"),
    },
    async ({ period }) => {
      // F1 fix: use both bounds so "yesterday" excludes first visits today.
      const { startMs, endMs } = resolvePeriod(period);

      // 2-year lookback to compute "first visit" accurately. Migrated to
      // getAll so high-volume merchants don't silently miss returning customers.
      const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
      const allOrders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${twoYearsAgo}`, "paymentState=PAID"],
        expand: "customers",
      });

      const firstVisit: Record<string, number> = {};
      for (const o of allOrders) {
        const c = (o as any).customers?.elements?.[0];
        if (!c?.id) continue;
        if (!firstVisit[c.id] || (o as any).createdTime < firstVisit[c.id]) {
          firstVisit[c.id] = (o as any).createdTime;
        }
      }

      const newCustomers = allOrders
        .filter((o: any) => {
          const c = o.customers?.elements?.[0];
          return c?.id && firstVisit[c.id] >= startMs && firstVisit[c.id] <= endMs;
        })
        .map((o: any) => {
          const c = o.customers.elements[0];
          return {
            id: c.id,
            name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
            firstVisit: new Date(o.createdTime).toDateString(),
            orderTotal: `$${((o.total ?? 0) / 100).toFixed(2)}`,
          };
        });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            newCustomers: newCustomers.length,
            customers: newCustomers,
          }, null, 2),
        }],
      };
    }
  );
}
