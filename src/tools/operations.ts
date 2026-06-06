import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { CloverClient } from "../clover-client.js";

export function registerOperationsTools(server: McpServer, clover: CloverClient) {

  server.tool(
    "get_cash_drawer_report",
    "End-of-day cash summary: expected cash vs actual. Flags shortages or overages.",
    {
      date: z.string().optional().describe("ISO date string. Defaults to today."),
    },
    async ({ date }) => {
      const target = date ? new Date(date) : new Date();
      const start = new Date(target.setHours(0, 0, 0, 0)).getTime();
      const end = new Date(target.setHours(23, 59, 59, 999)).getTime();

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
        expand: "payments",
        limit: 500,
      });

      let cashCents = 0, cardCents = 0, otherCents = 0;
      for (const order of orders.elements ?? []) {
        for (const p of order.payments?.elements ?? []) {
          const tenderLabel = p.tender?.label?.toLowerCase() ?? "";
          if (tenderLabel.includes("cash")) cashCents += p.amount ?? 0;
          else if (tenderLabel.includes("card") || tenderLabel.includes("credit") || tenderLabel.includes("debit")) cardCents += p.amount ?? 0;
          else otherCents += p.amount ?? 0;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: new Date(start).toDateString(),
            cashSales: `$${(cashCents / 100).toFixed(2)}`,
            cardSales: `$${(cardCents / 100).toFixed(2)}`,
            otherSales: `$${(otherCents / 100).toFixed(2)}`,
            totalSales: `$${((cashCents + cardCents + otherCents) / 100).toFixed(2)}`,
            expectedCashInDrawer: `$${(cashCents / 100).toFixed(2)}`,
            note: "Compare expected cash to actual drawer count at close. Discrepancy > $5 warrants investigation.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "bulk_update_prices",
    "Apply a percentage price increase or decrease to all items in a category at once.",
    {
      categoryId: z.string().describe("Clover category ID"),
      changePercent: z.number().describe("Percentage to change prices. Positive = increase, negative = decrease. e.g. 5 = +5%"),
      roundToNearest: z.number().optional().default(0.05).describe("Round prices to nearest value e.g. 0.05 for nickel rounding"),
    },
    async ({ categoryId, changePercent, roundToNearest }) => {
      const data = await clover.get<any>(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
        limit: 100,
      });

      const results = await Promise.all(
        (data.elements ?? []).map(async (item: any) => {
          const oldPrice = item.price ?? 0;
          const rawNew = oldPrice * (1 + changePercent / 100);
          const roundedCents = Math.round(rawNew / (roundToNearest * 100)) * (roundToNearest * 100);
          await clover.post<any>(clover.v3(`/items/${item.id}`), { price: roundedCents });
          return { name: item.name, oldPrice: `$${(oldPrice / 100).toFixed(2)}`, newPrice: `$${(roundedCents / 100).toFixed(2)}` };
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            categoryId,
            changeApplied: `${changePercent > 0 ? "+" : ""}${changePercent}%`,
            itemsUpdated: results.length,
            changes: results,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "set_happy_hour_prices",
    "Temporarily reduce prices on a category for happy hour. Call again with restore=true to revert to original prices.",
    {
      categoryId: z.string().describe("Category to discount"),
      discountPercent: z.number().describe("Discount percentage e.g. 20 = 20% off"),
      restore: z.boolean().optional().default(false).describe("Set true to restore original prices saved from the last activation"),
    },
    async ({ categoryId, discountPercent, restore }) => {
      const backupFile = join(process.env.RESERVATIONS_PATH ?? ".", `happyhour_${categoryId}.json`);

      const data = await clover.get<any>(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
        limit: 100,
      });

      if (restore) {
        if (!existsSync(backupFile)) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "No backup found for this category. Happy hour may not have been activated." }, null, 2) }] };
        }
        const backup: Record<string, number> = JSON.parse(readFileSync(backupFile, "utf-8"));
        await Promise.all(
          Object.entries(backup).map(([id, price]) =>
            clover.post<any>(clover.v3(`/items/${id}`), { price })
          )
        );
        unlinkSync(backupFile);
        return { content: [{ type: "text", text: JSON.stringify({ status: "restored", itemsRestored: Object.keys(backup).length }, null, 2) }] };
      }

      // Save originals to backup file before discounting
      const backup: Record<string, number> = {};
      for (const item of data.elements ?? []) backup[item.id] = item.price ?? 0;
      writeFileSync(backupFile, JSON.stringify(backup));

      const results = await Promise.all(
        (data.elements ?? []).map(async (item: any) => {
          const original = item.price ?? 0;
          const discounted = Math.round(original * (1 - discountPercent / 100));
          await clover.post<any>(clover.v3(`/items/${item.id}`), { price: discounted });
          return { name: item.name, original: `$${(original / 100).toFixed(2)}`, happyHour: `$${(discounted / 100).toFixed(2)}` };
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "happy_hour_active",
            discountApplied: `${discountPercent}% off`,
            itemsUpdated: results.length,
            reminder: "Call this tool again with restore=true to revert prices at end of happy hour.",
            prices: results,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_refund_risk_orders",
    "Flag orders with large or repeated refunds that may need review.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      minRefundCents: z.number().optional().default(1000).describe("Flag refunds above this amount in cents (default $10)"),
    },
    async ({ period, minRefundCents }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const refunds = await clover.get<any>(clover.v3("/refunds"), {
        filter: `createdTime>=${start.getTime()}`,
        expand: "payment,employee",
        limit: 200,
      });

      const flagged = (refunds.elements ?? [])
        .filter((r: any) => (r.amount ?? 0) >= minRefundCents)
        .map((r: any) => ({
          refundId: r.id,
          amount: `$${((r.amount ?? 0) / 100).toFixed(2)}`,
          employee: r.employee?.name ?? "Unknown",
          reason: r.reason ?? "No reason given",
          date: new Date(r.createdTime).toISOString(),
        }))
        .sort((a: any, b: any) => parseFloat(b.amount.replace("$", "")) - parseFloat(a.amount.replace("$", "")));

      const totalRefundedCents = (refunds.elements ?? []).reduce((s: number, r: any) => s + (r.amount ?? 0), 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            totalRefunded: `$${(totalRefundedCents / 100).toFixed(2)}`,
            totalRefunds: refunds.elements?.length ?? 0,
            flaggedAbove: `$${(minRefundCents / 100).toFixed(2)}`,
            flaggedRefunds: flagged,
          }, null, 2),
        }],
      };
    }
  );
}
