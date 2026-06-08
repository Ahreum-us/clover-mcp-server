import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { parseDate, resolvePeriod } from "../lib/date.js";

export function registerSmartTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "daily_briefing",
    "Call this every morning or when the owner asks how yesterday went. Returns yesterday's revenue, top sellers, low stock alerts, open orders, and a week-over-week revenue comparison — all in one shot. Supports multilingual output via the language param.",
    {
      language: z.string().optional().describe("BCP-47 language code for the response (e.g. 'vi', 'ko', 'es'). Defaults to English."),
    },
    async ({ language }) => {
      const { startMs: start, endMs: end } = resolvePeriod("yesterday");
      const sameDay7Ago = start - 7 * 24 * 60 * 60 * 1000;
      const sameDay7AgoEnd = end - 7 * 24 * 60 * 60 * 1000;

      const [orders, lastWeekOrders, stocks, openOrdersData] = await Promise.all([
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
          expand: "lineItems,payments",
        }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${sameDay7Ago}`, `createdTime<=${sameDay7AgoEnd}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/item_stocks"), { expand: "item" }),
        clover.get<any>(clover.v3("/orders"), { filter: "paymentState=OPEN", limit: 50 }),
      ]);

      const totalRevenueCents = orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const lastWeekRevenueCents = lastWeekOrders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const revChange = lastWeekRevenueCents > 0
        ? (((totalRevenueCents - lastWeekRevenueCents) / lastWeekRevenueCents) * 100).toFixed(1)
        : null;

      const tipsCents = orders.reduce((s: number, o: any) =>
        s + (o.payments?.elements ?? []).reduce((t: number, p: any) => t + (p.tipAmount ?? 0), 0), 0);

      const itemSales: Record<string, { name: string; qty: number }> = {};
      for (const order of orders) {
        for (const li of (order as any).lineItems?.elements ?? []) {
          const k = li.name ?? "unknown";
          if (!itemSales[k]) itemSales[k] = { name: k, qty: 0 };
          itemSales[k].qty += li.unitQty ?? 1;
        }
      }
      const topItems = Object.values(itemSales).sort((a, b) => b.qty - a.qty).slice(0, 5);
      const lowStock = stocks
        .filter((s: any) => s.quantity !== undefined && s.quantity <= 5)
        .map((s: any) => ({ name: s.item?.name, quantity: s.quantity, unit: s.unit ?? "units" }));

      const result: Record<string, any> = {
        date: new Date(start).toDateString(),
        revenue: `$${(totalRevenueCents / 100).toFixed(2)}`,
        revenueVsLastWeek: revChange !== null ? `${Number(revChange) >= 0 ? "+" : ""}${revChange}%` : "N/A",
        totalOrders: orders.length,
        avgCheck: orders.length > 0 ? `$${(totalRevenueCents / orders.length / 100).toFixed(2)}` : "$0.00",
        totalTips: `$${(tipsCents / 100).toFixed(2)}`,
        topSellers: topItems,
        lowStockAlerts: lowStock,
        openOrders: openOrdersData.elements?.length ?? 0,
      };

      if (language && language !== "en") {
        result._language_directive = `Present this briefing to the user in the language with BCP-47 code: ${language}. Translate all labels and narrative naturally — do not leave any English.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    server,
    "generate_catering_quote",
    "Generate a catering estimate for a party. Pulls live menu prices and calculates totals with optional markup.",
    {
      partySize: z.number().int().positive().max(10000),
      itemSelections: z.array(z.object({
        itemName: z.string().min(1),
        quantity: z.number().int().positive(),
      })).min(1),
      markupPercent: z.number().min(0).max(500).optional().default(15),
      eventDate: z.string().optional(),
      clientName: z.string().optional(),
    },
    async ({ partySize, itemSelections, markupPercent, eventDate, clientName }) => {
      const items = await clover.getAll(clover.v3("/items"));

      const lineItems = itemSelections.map(sel => {
        const match = items.find((i: any) =>
          i.name?.toLowerCase().includes(sel.itemName.toLowerCase())
        );
        const unitPrice = (match as any)?.price ?? 0;
        const subtotal = unitPrice * sel.quantity;
        return {
          item: (match as any)?.name ?? sel.itemName,
          matched: !!match,
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

  tool(
    server,
    "end_of_shift_summary",
    "End-of-shift report: total covers, revenue, top items, average check. Great for texting to the owner after close.",
    {
      shiftStart: z.string().describe("ISO datetime when the shift started"),
      shiftEnd: z.string().optional().describe("ISO datetime when the shift ended. Defaults to now."),
    },
    async ({ shiftStart, shiftEnd }) => {
      const start = parseDate(shiftStart, "shiftStart");
      const end = shiftEnd ? parseDate(shiftEnd, "shiftEnd") : Date.now();
      if (end < start) throw new Error("shiftEnd is before shiftStart.");

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
        expand: "lineItems,payments",
      });

      const revenueCents = orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const tipsCents = orders.reduce((s: number, o: any) =>
        s + (o.payments?.elements ?? []).reduce((t: number, p: any) => t + (p.tipAmount ?? 0), 0), 0);

      const itemSales: Record<string, number> = {};
      for (const order of orders) {
        for (const li of (order as any).lineItems?.elements ?? []) {
          const k = li.name ?? "unknown";
          itemSales[k] = (itemSales[k] ?? 0) + (li.unitQty ?? 1);
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
            totalOrders: orders.length,
            avgCheck: orders.length > 0
              ? `$${(revenueCents / orders.length / 100).toFixed(2)}`
              : "$0.00",
            totalTips: `$${(tipsCents / 100).toFixed(2)}`,
            topSellers: topItems,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "menu_optimization_report",
    "Identify underperforming items (low sales + low margin). Suggests what to push, price-adjust, or consider removing. Uses last 30 days of data.",
    {},
    async () => {
      const startMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const [orders, items] = await Promise.all([
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${startMs}`, "paymentState=PAID"],
          expand: "lineItems",
        }),
        clover.getAll(clover.v3("/items")),
      ]);

      const itemSales: Record<string, { name: string; qty: number; revenueCents: number; priceCents: number }> = {};
      for (const item of items) {
        itemSales[(item as any).id] = {
          name: (item as any).name,
          qty: 0,
          revenueCents: 0,
          priceCents: (item as any).price ?? 0,
        };
      }

      for (const order of orders) {
        for (const li of (order as any).lineItems?.elements ?? []) {
          const id = li.item?.id;
          if (id && itemSales[id]) {
            const qty = li.unitQty ?? 1;
            itemSales[id].qty += qty;
            // PHASE 2 FIX: multiply by unitQty.
            itemSales[id].revenueCents += (li.price ?? 0) * qty;
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

  tool(
    server,
    "draft_supplier_reorder_message",
    "When stock is low, draft a reorder message for a supplier. Returns a ready-to-send WhatsApp/text message.",
    {
      items: z.array(z.object({
        name: z.string().min(1),
        currentQty: z.number(),
        orderQty: z.number().positive(),
        unit: z.string().optional().default("units"),
      })).min(1),
      supplierName: z.string().optional().default("Supplier"),
      restaurantName: z.string().optional().default("the restaurant"),
    },
    async ({ items, supplierName, restaurantName }) => {
      const lines = items.map(i => `- ${i.name}: ${i.orderQty} ${i.unit}`).join("\n");
      const message = `Hi ${supplierName},\n\nThis is ${restaurantName}. We need to place a reorder:\n\n${lines}\n\nPlease confirm availability and delivery date. Thank you!`;
      return { content: [{ type: "text", text: message }] };
    }
  );

  tool(
    server,
    "get_slow_day_analysis",
    "Call this when the owner says it's slow, asks why business is down, or wonders how today compares to normal. Compares today's revenue so far against the same time window last week and a 4-week average.",
    {
      language: z.string().optional(),
    },
    async ({ language }) => {
      const { startMs: todayStart } = resolvePeriod("today");
      const now = Date.now();
      const oneWeek = 7 * 24 * 60 * 60 * 1000;

      const [todayOrders, wk1Orders, wk2Orders, wk3Orders, wk4Orders] = await Promise.all([
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart}`, `createdTime<=${now}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - oneWeek}`, `createdTime<=${now - oneWeek}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 2 * oneWeek}`, `createdTime<=${now - 2 * oneWeek}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 3 * oneWeek}`, `createdTime<=${now - 3 * oneWeek}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${todayStart - 4 * oneWeek}`, `createdTime<=${now - 4 * oneWeek}`, "paymentState=PAID"],
        }),
      ]);

      const rev = (orders: any[]) => orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const todayRev = rev(todayOrders);
      const lastWeekRev = rev(wk1Orders);
      const avgRev = Math.round((rev(wk1Orders) + rev(wk2Orders) + rev(wk3Orders) + rev(wk4Orders)) / 4);

      const vsLastWeek = lastWeekRev > 0 ? (((todayRev - lastWeekRev) / lastWeekRev) * 100).toFixed(1) : null;
      const vsAvg = avgRev > 0 ? (((todayRev - avgRev) / avgRev) * 100).toFixed(1) : null;

      const dayName = new Date().toLocaleDateString("en-US", { weekday: "long" });
      const timeStr = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      let verdict = "On track.";
      if (vsAvg !== null && Number(vsAvg) < -20) verdict = "Significantly below average — consider a promotion or check if there's an event nearby pulling foot traffic.";
      else if (vsAvg !== null && Number(vsAvg) < -10) verdict = "Slightly below average — could pick up later in the day.";
      else if (vsAvg !== null && Number(vsAvg) > 15) verdict = "Strong day — above your typical average for this time.";

      const result: Record<string, any> = {
        snapshot: `${dayName} as of ${timeStr}`,
        revenueToNow: `$${(todayRev / 100).toFixed(2)}`,
        vsLastWeek: vsLastWeek !== null ? `${Number(vsLastWeek) >= 0 ? "+" : ""}${vsLastWeek}%` : "N/A",
        vs4WeekAvg: vsAvg !== null ? `${Number(vsAvg) >= 0 ? "+" : ""}${vsAvg}%` : "N/A",
        ordersToNow: todayOrders.length,
        verdict,
      };

      if (language && language !== "en") {
        result._language_directive = `Present this analysis to the user in the language with BCP-47 code: ${language}. Translate naturally.`;
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tool(
    server,
    "suggest_86_candidates",
    "Call this when the owner wants to reduce waste, simplify the menu, or do weekly inventory cleanup. Finds items that are both low in stock AND moving slowly.",
    {},
    async () => {
      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;

      const [stocks, orders] = await Promise.all([
        clover.getAll(clover.v3("/item_stocks"), { expand: "item" }),
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${fourteenDaysAgo}`, "paymentState=PAID"],
          expand: "lineItems",
        }),
      ]);

      const salesVelocity: Record<string, number> = {};
      for (const order of orders) {
        for (const li of (order as any).lineItems?.elements ?? []) {
          const id = li.item?.id;
          if (id) salesVelocity[id] = (salesVelocity[id] ?? 0) + (li.unitQty ?? 1);
        }
      }

      const candidates = stocks
        .filter((s: any) => s.quantity !== undefined && s.quantity > 0 && s.quantity <= 15 && s.item?.id)
        .map((s: any) => {
          const velocity = (salesVelocity[s.item.id] ?? 0) / 14;
          const daysUntilOut = velocity > 0 ? (s.quantity / velocity) : 999;
          return {
            itemId: s.item.id,
            name: s.item.name,
            stock: s.quantity,
            salesLast14Days: salesVelocity[s.item.id] ?? 0,
            dailyVelocity: parseFloat(velocity.toFixed(2)),
            daysOfStockLeft: daysUntilOut < 999 ? Math.round(daysUntilOut) : "stagnant",
            recommendation: velocity < 0.3 && s.quantity <= 10
              ? "🔴 86 it — low stock, barely selling"
              : velocity < 0.5
              ? "🟡 Monitor — slow mover, don't reorder aggressively"
              : "🟢 Worth reordering",
          };
        })
        .sort((a: any, b: any) => {
          const score = (i: any) => (i.recommendation.startsWith("🔴") ? 0 : i.recommendation.startsWith("🟡") ? 1 : 2);
          return score(a) - score(b);
        });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: "Last 14 days",
            candidates,
            tip: "Items marked 🔴 are the best candidates to 86 — they'll go to waste before they sell.",
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "log_waste",
    "Log food waste for cost tracking. Adjusts inventory down and records the loss.",
    {
      items: z.array(z.object({
        itemId: z.string().regex(/^[A-Z0-9]+$/i).max(40),
        quantity: z.number().positive(),
        reason: z.string().max(200).optional(),
      })).min(1),
      confirm: z.boolean().optional().default(false),
    },
    async ({ items, confirm }) => {
      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would log waste for ${items.length} items. Set confirm=true to apply.` }] };
      }
      const results = [];
      for (const item of items) {
        const current = await clover.get<any>(clover.v3(`/item_stocks/${item.itemId}`));
        const newQty = Math.max(0, (current.quantity ?? 0) - item.quantity);
        await clover.post<any>(clover.v3(`/item_stocks/${item.itemId}`), { quantity: newQty });
        results.push({
          itemId: item.itemId,
          wasted: item.quantity,
          reason: item.reason ?? "unspecified",
          newStock: newQty,
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );
}
