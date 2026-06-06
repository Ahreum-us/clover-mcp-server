import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerOrderTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "get_recent_orders",
    "Get recent orders. Defaults to last 50.",
    {
      limit: z.number().optional().default(50).describe("Number of orders to return"),
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

  server.tool(
    "get_order",
    "Get full details for a single order by ID",
    { orderId: z.string() },
    async ({ orderId }) => {
      const data = await clover.get<any>(clover.v3(`/orders/${orderId}`), {
        expand: "lineItems,payments,customers,discounts",
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_orders_by_date",
    "Get orders within a date range",
    {
      startDate: z.string().describe("ISO date string e.g. 2026-06-01"),
      endDate: z.string().describe("ISO date string e.g. 2026-06-05"),
    },
    async ({ startDate, endDate }) => {
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      const data = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`],
        expand: "lineItems,payments",
        limit: 200,
        orderBy: "createdTime DESC",
      });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "get_open_orders",
    "Get all currently open (unpaid) orders — useful during service",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/orders"), {
        filter: "paymentState=OPEN",
        expand: "lineItems,customers",
        limit: 100,
        orderBy: "createdTime DESC",
      });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "get_delivery_orders",
    "Get orders from third-party delivery platforms (UberEats, DoorDash, GrubHub, Postmates, etc). Groups by service and shows revenue breakdown per platform.",
    {
      period: z.enum(["today", "yesterday", "week", "month"]).optional().default("week"),
      service: z.enum(["all", "ubereats", "doordash", "grubhub", "postmates", "unknown"]).optional().default("all").describe("Filter to a specific delivery service"),
    },
    async ({ period, service }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "yesterday") { const y = new Date(); y.setDate(y.getDate() - 1); start = new Date(y.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const data = await clover.get<any>(clover.v3("/orders"), {
        filter: `createdTime>=${start.getTime()}`,
        expand: "orderType,lineItems,payments,customers",
        limit: 500,
        orderBy: "createdTime DESC",
      });

      // Normalize delivery service name from orderType label or tender label
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

      for (const order of data.elements ?? []) {
        const svc = detectService(order);
        if (service !== "all" && svc !== service) continue;
        if (!groups[svc]) groups[svc] = { orders: 0, revenueCents: 0, items: [] };
        groups[svc].orders++;
        groups[svc].revenueCents += order.total ?? 0;
        groups[svc].items.push({
          id: order.id,
          total: `$${((order.total ?? 0) / 100).toFixed(2)}`,
          createdAt: new Date(order.createdTime).toISOString(),
          customer: order.customers?.elements?.[0]
            ? `${order.customers.elements[0].firstName ?? ""} ${order.customers.elements[0].lastName ?? ""}`.trim()
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

  server.tool(
    "create_refund",
    "Refund a payment on an order",
    {
      paymentId: z.string().describe("Payment ID to refund"),
      amountCents: z.number().optional().describe("Partial refund amount in cents. Omit for full refund."),
      reason: z.string().optional().describe("Reason for the refund"),
    },
    async ({ paymentId, amountCents, reason }) => {
      const body: Record<string, unknown> = { payment: { id: paymentId } };
      if (amountCents) body.amount = amountCents;
      if (reason) body.reason = reason;
      const data = await clover.post<any>(clover.v3("/refunds"), body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
