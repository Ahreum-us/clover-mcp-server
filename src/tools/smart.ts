import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerSmartTools(server: McpServer, clover: CloverClient) {

  // ── DAILY BRIEFING ──────────────────────────────────────────────────────────
  server.tool(
    "daily_briefing",
    "Morning or end-of-day summary: yesterday's revenue, top sellers, low stock alerts, and open orders. One command to start or end the day.",
    {},
    async () => {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const start = new Date(yesterday.setHours(0, 0, 0, 0)).getTime();
      const end = new Date(yesterday.setHours(23, 59, 59, 999)).getTime();

      const [orders, stocks, openOrders] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
          expand: "lineItems",
          limit: 500,
        }),
        clover.get<any>(clover.v3("/item_stocks"), { expand: "item", limit: 200 }),
        clover.get<any>(clover.v3("/orders"), {
          filter: "paymentState=OPEN",
          limit: 20,
        }),
      ]);

      const elements = orders.elements ?? [];
      const totalRevenueCents = elements.reduce((s: number, o: any) => s + (o.total ?? 0), 0);

      const itemSales: Record<string, { name: string; qty: number }> = {};
      for (const order of elements) {
        for (const li of order.lineItems?.elements ?? []) {
          const k = li.name ?? li.item?.id ?? "unknown";
          if (!itemSales[k]) itemSales[k] = { name: k, qty: 0 };
          itemSales[k].qty++;
        }
      }
      const topItems = Object.values(itemSales)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);

      const lowStock = (stocks.elements ?? []).filter(
        (s: any) => s.quantity !== undefined && s.quantity <= 5
      ).map((s: any) => ({ name: s.item?.name, quantity: s.quantity }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: new Date(start).toDateString(),
            revenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
            totalOrders: elements.length,
            avgCheck: elements.length > 0
              ? `$${(totalRevenueCents / elements.length / 100).toFixed(2)}`
              : "$0.00",
            topSellers: topItems,
            lowStockAlerts: lowStock,
            openOrders: openOrders.elements?.length ?? 0,
          }, null, 2),
        }],
      };
    }
  );

  // ── CATERING QUOTE ──────────────────────────────────────────────────────────
  server.tool(
    "generate_catering_quote",
    "Generate a catering estimate for a party. Pulls live menu prices and calculates totals with optional markup.",
    {
      partySize: z.number().describe("Number of guests"),
      itemSelections: z.array(z.object({
        itemName: z.string().describe("Menu item name (partial match ok)"),
        quantity: z.number().describe("Number of orders"),
      })).describe("List of items and quantities"),
      markupPercent: z.number().optional().default(15).describe("Catering markup percentage"),
      eventDate: z.string().optional().describe("Event date for the quote header"),
      clientName: z.string().optional().describe("Client name for the quote"),
    },
    async ({ partySize, itemSelections, markupPercent, eventDate, clientName }) => {
      const menu = await clover.get<any>(clover.v3("/items"), { limit: 200 });
      const items = menu.elements ?? [];

      const lineItems = itemSelections.map(sel => {
        const match = items.find((i: any) =>
          i.name?.toLowerCase().includes(sel.itemName.toLowerCase())
        );
        const unitPrice = match?.price ?? 0;
        const subtotal = unitPrice * sel.quantity;
        return {
          item: match?.name ?? sel.itemName,
          unitPrice: `$${(unitPrice / 100).toFixed(2)}`,
          quantity: sel.quantity,
          subtotal: `$${(subtotal / 100).toFixed(2)}`,
          subtotalCents: subtotal,
        };
      });

      const subtotalCents = lineItems.reduce((s, l) => s + l.subtotalCents, 0);
      const markupCents = Math.round(subtotalCents * markupPercent / 100);
      const totalCents = subtotalCents + markupCents;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            quote: {
              client: clientName ?? "TBD",
              eventDate: eventDate ?? "TBD",
              partySize,
              lineItems,
              subtotal: `$${(subtotalCents / 100).toFixed(2)}`,
              cateringMarkup: `${markupPercent}% — $${(markupCents / 100).toFixed(2)}`,
              total: `$${(totalCents / 100).toFixed(2)}`,
              perPerson: `$${(totalCents / partySize / 100).toFixed(2)}`,
            },
          }, null, 2),
        }],
      };
    }
  );

  // ── SHIFT SUMMARY ───────────────────────────────────────────────────────────
  server.tool(
    "end_of_shift_summary",
    "End-of-shift report: total covers, revenue, top items, average check. Great for texting to the owner after close.",
    {
      shiftStart: z.string().describe("ISO datetime when the shift started"),
      shiftEnd: z.string().optional().describe("ISO datetime when the shift ended. Defaults to now."),
    },
    async ({ shiftStart, shiftEnd }) => {
      const start = new Date(shiftStart).getTime();
      const end = shiftEnd ? new Date(shiftEnd).getTime() : Date.now();

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
        expand: "lineItems,payments",
        limit: 300,
      });

      const elements = orders.elements ?? [];
      const revenueCents = elements.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const tipsCents = elements.reduce((s: number, o: any) => {
        return s + (o.payments?.elements ?? []).reduce((t: number, p: any) => t + (p.tipAmount ?? 0), 0);
      }, 0);

      const itemSales: Record<string, number> = {};
      for (const order of elements) {
        for (const li of order.lineItems?.elements ?? []) {
          const k = li.name ?? "unknown";
          itemSales[k] = (itemSales[k] ?? 0) + 1;
        }
      }
      const topItems = Object.entries(itemSales)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name, qty]) => ({ name, qty }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            shiftRevenue: `$${(revenueCents / 100).toFixed(2)}`,
            totalOrders: elements.length,
            avgCheck: elements.length > 0
              ? `$${(revenueCents / elements.length / 100).toFixed(2)}`
              : "$0.00",
            totalTips: `$${(tipsCents / 100).toFixed(2)}`,
            topSellers: topItems,
          }, null, 2),
        }],
      };
    }
  );

  // ── MENU OPTIMIZATION ───────────────────────────────────────────────────────
  server.tool(
    "menu_optimization_report",
    "Identify underperforming items (low sales + low margin). Suggests what to push, price-adjust, or consider removing. Uses last 30 days of data.",
    {},
    async () => {
      const start = new Date(); start.setDate(start.getDate() - 30);

      const [orders, menu] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
          expand: "lineItems",
          limit: 500,
        }),
        clover.get<any>(clover.v3("/items"), { limit: 200 }),
      ]);

      const itemSales: Record<string, { name: string; qty: number; revenueCents: number; priceCents: number }> = {};
      for (const item of menu.elements ?? []) {
        itemSales[item.id] = { name: item.name, qty: 0, revenueCents: 0, priceCents: item.price ?? 0 };
      }

      for (const order of orders.elements ?? []) {
        for (const li of order.lineItems?.elements ?? []) {
          const id = li.item?.id;
          if (id && itemSales[id]) {
            itemSales[id].qty++;
            itemSales[id].revenueCents += li.price ?? 0;
          }
        }
      }

      const all = Object.values(itemSales);
      const avgQty = all.reduce((s, i) => s + i.qty, 0) / (all.length || 1);

      const stars = all.filter(i => i.qty > avgQty * 1.5).map(i => ({ name: i.name, tag: "⭐ Push harder", qty: i.qty }));
      const sleepers = all.filter(i => i.qty < avgQty * 0.3 && i.qty > 0).map(i => ({ name: i.name, tag: "😴 Consider repricing or removing", qty: i.qty }));
      const ghosts = all.filter(i => i.qty === 0).map(i => ({ name: i.name, tag: "👻 Zero sales — consider removing" }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ period: "Last 30 days", stars, sleepers, ghosts }, null, 2),
        }],
      };
    }
  );

  // ── DRAFT SUPPLIER MESSAGE ───────────────────────────────────────────────────
  server.tool(
    "draft_supplier_reorder_message",
    "When stock is low, draft a reorder message for a supplier. Returns a ready-to-send WhatsApp/text message.",
    {
      items: z.array(z.object({
        name: z.string(),
        currentQty: z.number(),
        orderQty: z.number().describe("Suggested order quantity"),
        unit: z.string().optional().default("units"),
      })),
      supplierName: z.string().optional().default("Supplier"),
      restaurantName: z.string().optional().default("the restaurant"),
    },
    async ({ items, supplierName, restaurantName }) => {
      const lines = items.map(i => `- ${i.name}: ${i.orderQty} ${i.unit}`).join("\n");
      const message = `Hi ${supplierName},\n\nThis is ${restaurantName}. We need to place a reorder:\n\n${lines}\n\nPlease confirm availability and delivery date. Thank you!`;
      return { content: [{ type: "text", text: message }] };
    }
  );

  // ── WASTE LOG ───────────────────────────────────────────────────────────────
  server.tool(
    "log_waste",
    "Log food waste for cost tracking. Adjusts inventory down and records the loss.",
    {
      items: z.array(z.object({
        itemId: z.string(),
        quantity: z.number(),
        reason: z.string().optional().describe("e.g. 'expired', 'dropped', 'overcooked'"),
      })),
    },
    async ({ items }) => {
      const results = await Promise.all(
        items.map(async (item) => {
          const current = await clover.get<any>(clover.v3(`/item_stocks/${item.itemId}`));
          const newQty = Math.max(0, (current.quantity ?? 0) - item.quantity);
          await clover.post<any>(clover.v3(`/item_stocks/${item.itemId}`), { quantity: newQty });
          return { itemId: item.itemId, wasted: item.quantity, reason: item.reason ?? "unspecified", newStock: newQty };
        })
      );
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );
}
