import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { parseDate, parseEndDate, resolvePeriod } from "../lib/date.js";

export function registerOrderTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_recent_orders",
    "Get recent orders. Defaults to last 50.",
    {
      limit: z.number().int().positive().max(500).optional().default(50),
      status: z.enum(["open", "closed", "all"]).optional().default("all"),
    },
    async ({ limit, status }) => {
      const params: Record<string, unknown> = {
        limit,
        expand: "lineItems,payments,customers",
        orderBy: "createdTime DESC",
      };
      if (status !== "all") params["filter"] = `state=${status.toUpperCase()}`;
      const data = await clover.get<any>(clover.v3("/orders"), params);
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  tool(
    server,
    "get_order",
    "Get full details for a single order by ID.",
    { orderId: z.string().regex(/^[A-Z0-9]+$/i, "orderId must be alphanumeric").max(40) },
    async ({ orderId }) => {
      const data = await clover.get<any>(clover.v3(`/orders/${orderId}`), {
        expand: "lineItems,payments,customers,discounts",
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  tool(
    server,
    "get_orders_by_date",
    "Get orders within a date range.",
    {
      startDate: z.string().describe("ISO date string e.g. 2026-06-01"),
      endDate: z.string().describe("ISO date string e.g. 2026-06-05"),
    },
    async ({ startDate, endDate }) => {
      const start = parseDate(startDate, "startDate");
      // F2 fix: bare end dates are inclusive of that whole day.
      const end = parseEndDate(endDate, "endDate");
      if (end < start) throw new Error(`endDate (${endDate}) is before startDate (${startDate}).`);
      const elements = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`],
        expand: "lineItems,payments",
        orderBy: "createdTime DESC",
      });
      return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
    }
  );

  tool(
    server,
    "get_open_orders",
    "Get all currently open (unpaid) orders — useful during service.",
    {},
    async () => {
      const elements = await clover.getAll(clover.v3("/orders"), {
        filter: "paymentState=OPEN",
        expand: "lineItems,customers",
        orderBy: "createdTime DESC",
      });
      return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
    }
  );

  tool(
    server,
    "get_delivery_orders",
    "Get orders from third-party delivery platforms (UberEats, DoorDash, GrubHub, Postmates, etc). Groups by service and shows revenue breakdown per platform.",
    {
      period: z.enum(["today", "yesterday", "week", "month"]).optional().default("week"),
      service: z.enum(["all", "ubereats", "doordash", "grubhub", "postmates", "unknown"]).optional().default("all"),
    },
    async ({ period, service }) => {
      // F1 fix: bound both ends so "yesterday" excludes today.
      const { startMs, endMs } = resolvePeriod(period);

      const elements = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, `createdTime<=${endMs}`],
        expand: "orderType,lineItems,payments,customers",
        orderBy: "createdTime DESC",
      });

      const detectService = (order: any): string => {
        const sources = [
          order.orderType?.label,
          order.title,
          order.note,
          ...(order.payments?.elements ?? []).map((p: any) => p.tender?.label),
        ].filter(Boolean).map((s: string) => s.toLowerCase());

        for (const src of sources) {
          if (/uber/.test(src)) return "ubereats";
          if (/door\s?dash/.test(src)) return "doordash";
          if (/grub\s?hub/.test(src)) return "grubhub";
          if (/postmates/.test(src)) return "postmates";
          if (/seamless/.test(src)) return "seamless";
          if (/chowly/.test(src)) return "chowly";
          if (/checkmate/.test(src)) return "checkmate";
          if (/olo/.test(src)) return "olo";
          if (/delivery|takeout|online/.test(src)) return "online";
        }
        return "in-house";
      };

      const groups: Record<string, { orders: number; revenueCents: number; items: any[] }> = {};
      for (const order of elements) {
        const svc = detectService(order);
        if (service !== "all" && svc !== service) continue;
        if (!groups[svc]) groups[svc] = { orders: 0, revenueCents: 0, items: [] };
        groups[svc].orders++;
        groups[svc].revenueCents += (order as any).total ?? 0;
        groups[svc].items.push({
          id: (order as any).id,
          total: `$${(((order as any).total ?? 0) / 100).toFixed(2)}`,
          createdAt: new Date((order as any).createdTime).toISOString(),
          customer: (order as any).customers?.elements?.[0]
            ? `${(order as any).customers.elements[0].firstName ?? ""} ${(order as any).customers.elements[0].lastName ?? ""}`.trim()
            : null,
        });
      }

      const deliveryServices = ["ubereats", "doordash", "grubhub", "postmates", "seamless", "chowly", "checkmate", "olo", "online"];
      const deliveryGroups = Object.fromEntries(
        Object.entries(groups).filter(([k]) => deliveryServices.includes(k))
      );
      const inHouseCount = groups["in-house"]?.orders ?? 0;

      const summary = Object.entries(deliveryGroups).map(([svc, v]) => ({
        service: svc,
        orders: v.orders,
        revenue: `$${(v.revenueCents / 100).toFixed(2)}`,
        avgOrder: v.orders > 0 ? `$${(v.revenueCents / v.orders / 100).toFixed(2)}` : "$0.00",
        recentOrders: v.items.slice(0, 5),
      }));

      if (summary.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "No delivery orders found for this period. Connect UberEats, DoorDash, or GrubHub through the Clover App Market to start seeing delivery orders here.",
              period,
              inHouseOrders: inHouseCount,
            }, null, 2),
          }],
        };
      }

      const totalDeliveryRevenue = Object.values(deliveryGroups).reduce((s, v) => s + v.revenueCents, 0);
      const totalDeliveryOrders = Object.values(deliveryGroups).reduce((s, v) => s + v.orders, 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            totalDeliveryRevenue: `$${(totalDeliveryRevenue / 100).toFixed(2)}`,
            totalDeliveryOrders,
            inHouseOrders: inHouseCount,
            byService: summary,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "create_refund",
    "Refund a payment on an order.",
    {
      paymentId: z.string().regex(/^[A-Z0-9]+$/i, "paymentId must be alphanumeric").max(40),
      amountCents: z.number().int().positive().optional().describe("Partial refund amount in cents. Omit for full refund."),
      reason: z.string().max(500).optional(),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
    },
    async ({ paymentId, amountCents, reason, confirm }) => {
      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would refund ${amountCents ? `${amountCents} cents` : "full amount"} for payment ${paymentId}. Set confirm=true to apply.` }] };
      }
      const body: Record<string, unknown> = { payment: { id: paymentId } };
      if (amountCents) body.amount = amountCents;
      if (reason) body.reason = reason;
      const data = await clover.post<any>(clover.v3("/refunds"), body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
