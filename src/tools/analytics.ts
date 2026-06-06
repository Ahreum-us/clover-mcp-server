import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerAnalyticsTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "get_sales_summary",
    "Get a revenue summary for today, this week, or a custom date range",
    {
      period: z.enum(["today", "yesterday", "week", "month", "custom"]).optional().default("today"),
      startDate: z.string().optional().describe("Required if period=custom. ISO date string."),
      endDate: z.string().optional().describe("Required if period=custom. ISO date string."),
    },
    async ({ period, startDate, endDate }) => {
      if (period === "custom" && (!startDate || !endDate)) {
        return { isError: true, content: [{ type: "text" as const, text: "startDate and endDate are required when period=custom" }] };
      }

      const now = new Date();
      let start: Date, end: Date;

      if (period === "today") {
        start = new Date(now.setHours(0, 0, 0, 0));
        end = new Date();
      } else if (period === "yesterday") {
        const y = new Date(); y.setDate(y.getDate() - 1);
        start = new Date(y.setHours(0, 0, 0, 0));
        end = new Date(y.setHours(23, 59, 59, 999));
      } else if (period === "week") {
        start = new Date(now); start.setDate(now.getDate() - 7);
        end = new Date();
      } else if (period === "month") {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end = new Date();
      } else {
        start = new Date(startDate!);
        end = new Date(endDate!);
      }

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, `createdTime<=${end.getTime()}`, "paymentState=PAID"],
        expand: "lineItems,payments",
        limit: 500,
      });

      const elements = orders.elements ?? [];
      const totalRevenueCents = elements.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const totalOrders = elements.length;
      const avgOrderCents = totalOrders > 0 ? Math.round(totalRevenueCents / totalOrders) : 0;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            from: start.toISOString(),
            to: end.toISOString(),
            totalRevenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
            totalOrders,
            averageOrderValue: `$${(avgOrderCents / 100).toFixed(2)}`,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_top_selling_items",
    "Get best-selling menu items by quantity or revenue over a period",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      topN: z.number().optional().default(10),
      sortBy: z.enum(["quantity", "revenue"]).optional().default("revenue"),
    },
    async ({ period, topN, sortBy }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
        expand: "lineItems",
        limit: 500,
      });

      const itemMap: Record<string, { name: string; qty: number; revenueCents: number }> = {};
      for (const order of orders.elements ?? []) {
        for (const li of order.lineItems?.elements ?? []) {
          const id = li.item?.id ?? li.name;
          if (!itemMap[id]) itemMap[id] = { name: li.name ?? id, qty: 0, revenueCents: 0 };
          itemMap[id].qty += li.unitQty ?? 1;
          itemMap[id].revenueCents += li.price ?? 0;
        }
      }

      const sorted = Object.values(itemMap)
        .sort((a, b) => sortBy === "quantity" ? b.qty - a.qty : b.revenueCents - a.revenueCents)
        .slice(0, topN)
        .map(v => ({ ...v, revenue: `$${(v.revenueCents / 100).toFixed(2)}` }));

      return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
    }
  );

  server.tool(
    "get_revenue_by_hour",
    "Hourly revenue breakdown — reveals peak and slow hours for staffing decisions",
    {
      date: z.string().optional().describe("ISO date string. Defaults to today."),
    },
    async ({ date }) => {
      const target = date ? new Date(date) : new Date();
      const start = new Date(target.setHours(0, 0, 0, 0));
      const end = new Date(target.setHours(23, 59, 59, 999));

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, `createdTime<=${end.getTime()}`, "paymentState=PAID"],
        limit: 500,
      });

      const byHour: Record<number, { orders: number; revenueCents: number }> = {};
      for (let h = 0; h < 24; h++) byHour[h] = { orders: 0, revenueCents: 0 };

      for (const order of orders.elements ?? []) {
        const hour = new Date(order.createdTime).getHours();
        byHour[hour].orders++;
        byHour[hour].revenueCents += order.total ?? 0;
      }

      const result = Object.entries(byHour)
        .filter(([, v]) => v.orders > 0)
        .map(([hour, v]) => ({
          hour: `${hour}:00`,
          orders: v.orders,
          revenue: `$${(v.revenueCents / 100).toFixed(2)}`,
        }));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
