import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { CLOVER_ID } from "../lib/ids.js";

export function registerCustomerTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "search_customer",
    "Search for a customer by name, phone, or email",
    { query: z.string().min(1).max(200).describe("Name, phone number, or email to search") },
    async ({ query }) => {
      // Strip characters that have special meaning in Clover filter syntax
      const safeQuery = query.replace(/[~=&<>()`]/g, "").trim().toLowerCase();
      // Clover's customers endpoint doesn't support substring filters — fetch
      // and match client-side. F4 fix: getAll so customers beyond the first
      // 200 are searchable.
      const customers = await clover.getAll<any>(clover.v3("/customers"), {
        expand: "addresses,emailAddresses,phoneNumbers",
      });
      const elements = customers.filter((c: any) => {
        const fullName = `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase();
        const phone = c.phoneNumbers?.elements?.[0]?.phoneNumber ?? "";
        const email = c.emailAddresses?.elements?.[0]?.emailAddress?.toLowerCase() ?? "";
        return fullName.includes(safeQuery) || phone.includes(safeQuery) || email.includes(safeQuery);
      });
      // CodeRabbit (PR #35): surface truncation instead of silently capping —
      // the same "hidden truncation" failure mode F4 removes elsewhere.
      const truncated = elements.length > 20;
      const results = elements.slice(0, 20);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            matchCount: elements.length,
            ...(truncated ? { note: "Showing first 20 of " + elements.length + " matches — refine the query to narrow results." } : {}),
            results,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_customer",
    "Get full profile and order history for a customer",
    { customerId: CLOVER_ID },
    async ({ customerId }) => {
      const [profile, orders] = await Promise.all([
        clover.get<any>(clover.v3(`/customers/${customerId}`), {
          expand: "addresses,emailAddresses,phoneNumbers",
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: `customers.id=${customerId}`,
          // CodeRabbit (PR #37): payments expand dropped — the slim projection
          // never reads payment fields, and expanded payment data can carry
          // card/tender PII we have no reason to pull.
          expand: "lineItems",
          limit: 50,
          orderBy: "createdTime DESC",
        }),
      ]);
      const totalSpend = (orders.elements ?? []).reduce(
        (sum: number, o: any) => sum + (o.total ?? 0), 0
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            profile,
            orderCount: orders.elements?.length ?? 0,
            totalSpendCents: totalSpend,
            totalSpendDollars: (totalSpend / 100).toFixed(2),
            spendNote: "totalSpend covers the 50 most recent orders",
            // Slim projection (CodeRabbit, PR #35): full expanded order objects
            // (payments, line-item internals) are excess PII for an LLM-facing
            // summary. Keep only what the summary needs.
            recentOrders: (orders.elements ?? []).slice(0, 10).map((o: any) => ({
              id: o.id,
              createdAt: o.createdTime ? new Date(o.createdTime).toISOString() : null,
              total: `$${((o.total ?? 0) / 100).toFixed(2)}`,
              state: o.state ?? null,
              items: (o.lineItems?.elements ?? []).map((li: any) => li.name).filter(Boolean),
            })),
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "create_customer",
    "Add a new customer to Clover (e.g. when taking a reservation or catering inquiry)",
    {
      firstName: z.string().min(1).max(100),
      lastName: z.string().max(100).optional(),
      phone: z.string().max(50).optional(),
      email: z.string().email("must be a valid email address").max(200).optional(),
      note: z.string().max(1000).optional().describe("Internal note e.g. 'regular, likes extra basil'"),
    },
    async ({ firstName, lastName, phone, email, note }) => {
      const body: Record<string, unknown> = { firstName };
      if (lastName) body.lastName = lastName;
      if (note) body.note = note;
      if (phone) body.phoneNumbers = { elements: [{ phoneNumber: phone }] };
      if (email) body.emailAddresses = { elements: [{ emailAddress: email }] };
      const data = await clover.post<any>(clover.v3("/customers"), body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  tool(
    server,
    "get_vip_customers",
    "Identify top customers by spend or visit frequency — useful for loyalty outreach",
    {
      topN: z.number().int().positive().max(100).optional().default(10).describe("How many top customers to return"),
      minOrders: z.number().int().positive().max(1000).optional().default(3).describe("Minimum number of visits"),
    },
    async ({ topN, minOrders }) => {
      // 90-day window keeps the result set manageable and reflects current loyalty.
      // F4 fix: getAll — busy merchants exceed 500 PAID orders in 90 days and
      // the old get(limit:500) computed VIP rankings from an arbitrary slice.
      const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const orders = await clover.getAll<any>(clover.v3("/orders"), {
        expand: "customers",
        filter: [`paymentState=PAID`, `createdTime>=${since}`],
        orderBy: "createdTime DESC",
      });

      const customerMap: Record<string, { name: string; orders: number; totalCents: number }> = {};
      for (const order of orders) {
        const customer = (order as any).customers?.elements?.[0];
        if (!customer?.id) continue;
        if (!customerMap[customer.id]) {
          customerMap[customer.id] = {
            name: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim(),
            orders: 0,
            totalCents: 0,
          };
        }
        customerMap[customer.id].orders++;
        customerMap[customer.id].totalCents += (order as any).total ?? 0;
      }

      const ranked = Object.entries(customerMap)
        .filter(([, v]) => v.orders >= minOrders)
        .sort(([, a], [, b]) => b.totalCents - a.totalCents)
        .slice(0, topN)
        .map(([id, v]) => ({
          id,
          name: v.name,
          visits: v.orders,
          totalSpent: `$${(v.totalCents / 100).toFixed(2)}`,
        }));

      return { content: [{ type: "text", text: JSON.stringify(ranked, null, 2) }] };
    }
  );
}
