import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { resolvePeriod } from "../lib/date.js";

export function registerAnalyticsTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_sales_summary",
    "Get a revenue summary for today, this week, or a custom date range.",
    {
      period: z.enum(["today", "yesterday", "week", "month", "custom"]).optional().default("today"),
      startDate: z.string().optional().describe("Required if period=custom. ISO date string."),
      endDate: z.string().optional().describe("Required if period=custom. ISO date string."),
    },
    async ({ period, startDate, endDate }) => {
      const { startMs, endMs, label } = resolvePeriod(period, startDate, endDate);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, `createdTime<=${endMs}`, "paymentState=PAID"],
        expand: "lineItems,payments",
      });

      const totalRevenueCents = orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const totalOrders = orders.length;
      const avgOrderCents = totalOrders > 0 ? Math.round(totalRevenueCents / totalOrders) : 0;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: label,
            from: new Date(startMs).toISOString(),
            to: new Date(endMs).toISOString(),
            totalRevenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
            totalOrders,
            averageOrderValue: `$${(avgOrderCents / 100).toFixed(2)}`,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_top_selling_items",
    "Get best-selling menu items by quantity or revenue over a period. Revenue is computed as price * unitQty per line item.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      topN: z.number().int().positive().max(100).optional().default(10),
      sortBy: z.enum(["quantity", "revenue"]).optional().default("revenue"),
    },
    async ({ period, topN, sortBy }) => {
      const { startMs } = resolvePeriod(period);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, "paymentState=PAID"],
        expand: "lineItems",
      });

      const itemMap: Record<string, { name: string; qty: number; revenueCents: number }> = {};
      for (const order of orders) {
        for (const li of (order as any).lineItems?.elements ?? []) {
          const id = li.item?.id ?? li.name;
          if (!itemMap[id]) itemMap[id] = { name: li.name ?? id, qty: 0, revenueCents: 0 };
          const qty = li.unitQty ?? 1;
          itemMap[id].qty += qty;
          // PHASE 2 FIX: was `li.price ?? 0`, which undercounted multi-unit lines.
          itemMap[id].revenueCents += (li.price ?? 0) * qty;
        }
      }

      const sorted = Object.values(itemMap)
        .sort((a, b) => sortBy === "quantity" ? b.qty - a.qty : b.revenueCents - a.revenueCents)
        .slice(0, topN)
        .map(v => ({ ...v, revenue: `$${(v.revenueCents / 100).toFixed(2)}` }));

      return { content: [{ type: "text", text: JSON.stringify(sorted, null, 2) }] };
    }
  );

  tool(
    server,
    "get_revenue_by_hour",
    "Hourly revenue breakdown — reveals peak and slow hours for staffing decisions. Hours are in the server's local timezone.",
    {
      date: z.string().optional().describe("ISO date string. Defaults to today."),
    },
    async ({ date }) => {
      const target = date ? new Date(date) : new Date();
      if (Number.isNaN(target.getTime())) {
        throw new Error(`date is not a parseable date: "${date}"`);
      }
      const start = new Date(target.getFullYear(), target.getMonth(), target.getDate());
      const end = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1, 0, 0, 0, -1);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, `createdTime<=${end.getTime()}`, "paymentState=PAID"],
      });

      const byHour: Record<number, { orders: number; revenueCents: number }> = {};
      for (let h = 0; h < 24; h++) byHour[h] = { orders: 0, revenueCents: 0 };

      for (const order of orders) {
        const hour = new Date((order as any).createdTime).getHours();
        byHour[hour].orders++;
        byHour[hour].revenueCents += (order as any).total ?? 0;
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
