import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerCustomerTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "search_customer",
    "Search for a customer by name, phone, or email",
    { query: z.string().describe("Name, phone number, or email to search") },
    async ({ query }) => {
      // Strip characters that have special meaning in Clover filter syntax
      const safeQuery = query.replace(/[~=&<>()`]/g, "").trim().toLowerCase();
      // Clover's customers endpoint doesn't support substring filters — fetch and match client-side
      const data = await clover.get<any>(clover.v3("/customers"), {
        expand: "addresses,emailAddresses,phoneNumbers",
        limit: 200,
      });
      const elements = (data.elements ?? []).filter((c: any) => {
        const fullName = `${c.firstName ?? ""} ${c.lastName ?? ""}`.toLowerCase();
        const phone = c.phoneNumbers?.elements?.[0]?.phoneNumber ?? "";
        const email = c.emailAddresses?.elements?.[0]?.emailAddress?.toLowerCase() ?? "";
        return fullName.includes(safeQuery) || phone.includes(safeQuery) || email.includes(safeQuery);
      }).slice(0, 20);
      return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
    }
  );

  server.tool(
    "get_customer",
    "Get full profile and order history for a customer",
    { customerId: z.string() },
    async ({ customerId }) => {
      const [profile, orders] = await Promise.all([
        clover.get<any>(clover.v3(`/customers/${customerId}`), {
          expand: "addresses,emailAddresses,phoneNumbers",
        }),
        clover.get<any>(clover.v3("/orders"), {
          filter: `customers.id=${customerId}`,
          expand: "lineItems,payments",
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
            recentOrders: orders.elements?.slice(0, 10),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "create_customer",
    "Add a new customer to Clover (e.g. when taking a reservation or catering inquiry)",
    {
      firstName: z.string(),
      lastName: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      note: z.string().optional().describe("Internal note e.g. 'regular, likes extra basil'"),
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

  server.tool(
    "get_vip_customers",
    "Identify top customers by spend or visit frequency — useful for loyalty outreach",
    {
      topN: z.number().optional().default(10).describe("How many top customers to return"),
      minOrders: z.number().optional().default(3).describe("Minimum number of visits"),
    },
    async ({ topN, minOrders }) => {
      // 90-day window keeps the result set manageable and reflects current loyalty
      const since = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const orders = await clover.get<any>(clover.v3("/orders"), {
        expand: "customers",
        filter: [`paymentState=PAID`, `createdTime>=${since}`],
        limit: 500,
        orderBy: "createdTime DESC",
      });

      const customerMap: Record<string, { name: string; orders: number; totalCents: number }> = {};
      for (const order of orders.elements ?? []) {
        const customer = order.customers?.elements?.[0];
        if (!customer?.id) continue;
        if (!customerMap[customer.id]) {
          customerMap[customer.id] = {
            name: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim(),
            orders: 0,
            totalCents: 0,
          };
        }
        customerMap[customer.id].orders++;
        customerMap[customer.id].totalCents += order.total ?? 0;
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
