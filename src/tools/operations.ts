import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { resolvePeriod, parseDate } from "../lib/date.js";

const CLOVER_ID = z.string().regex(/^[A-Z0-9]+$/i, "must be alphanumeric").max(40);

export function registerOperationsTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "get_cash_drawer_report",
    "End-of-day cash summary: expected cash vs actual. Flags shortages or overages.",
    {
      date: z.string().max(20).optional().describe("ISO date string. Defaults to today."),
    },
    async ({ date }) => {
      const targetMs = date ? parseDate(date, "date") : Date.now();
      const target = new Date(targetMs);
      // PHASE 3: was `new Date(target.setHours(...))` which mutated `target`.
      // Use the year/month/date components instead — safer pattern.
      const start = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
      const end = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1, 0, 0, 0, -1).getTime();

      const elements = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${start}`, `createdTime<=${end}`, "paymentState=PAID"],
        expand: "payments",
      });

      let cashCents = 0, cardCents = 0, otherCents = 0;
      for (const order of elements) {
        for (const p of (order as any).payments?.elements ?? []) {
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

  tool(
    server,
    "bulk_update_prices",
    "Apply a percentage price increase or decrease to all items in a category at once.",
    {
      categoryId: CLOVER_ID.describe("Clover category ID"),
      changePercent: z.number().min(-95).max(500)
        .describe("Percentage to change prices. Positive = increase, negative = decrease. e.g. 5 = +5%"),
      roundToNearest: z.number().positive().max(100).optional().default(0.05)
        .describe("Round prices to nearest value e.g. 0.05 for nickel rounding"),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
    },
    async ({ categoryId, changePercent, roundToNearest, confirm }) => {
      const elements = await clover.getAll(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
      });

      if (!confirm) {
        const preview = elements.map((item: any) => {
          const oldPrice = item.price ?? 0;
          const rawNew = oldPrice * (1 + changePercent / 100);
          const roundedCents = Math.max(0, Math.round(rawNew / (roundToNearest * 100)) * (roundToNearest * 100));
          return { name: item.name, oldPrice: `$${(oldPrice / 100).toFixed(2)}`, newPrice: `$${(roundedCents / 100).toFixed(2)}` };
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "DRY_RUN",
              message: "Set confirm=true to apply these changes.",
              categoryId,
              changePercent,
              itemsToUpdate: preview.length,
              preview: preview.slice(0, 10),
            }, null, 2),
          }],
        };
      }

      const results = await Promise.all(
        elements.map(async (item: any) => {
          const oldPrice = item.price ?? 0;
          const rawNew = oldPrice * (1 + changePercent / 100);
          const roundedCents = Math.max(0, Math.round(rawNew / (roundToNearest * 100)) * (roundToNearest * 100));
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

  tool(
    server,
    "set_happy_hour_prices",
    "Temporarily reduce prices on a category for happy hour. Call again with restore=true to revert to original prices.",
    {
      categoryId: CLOVER_ID.describe("Category to discount"),
      discountPercent: z.number().min(1).max(99).describe("Discount percentage e.g. 20 = 20% off"),
      restore: z.boolean().optional().default(false).describe("Set true to restore original prices saved from the last activation"),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
    },
    async ({ categoryId, discountPercent, restore, confirm }) => {
      const backupFile = join(process.env.RESERVATIONS_PATH ?? ".", `happyhour_${categoryId}.json`);

      const elements = await clover.getAll(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
      });

      if (restore) {
        if (!existsSync(backupFile)) {
          return { content: [{ type: "text", text: JSON.stringify({ status: "error", message: "No backup found for this category. Happy hour may not have been activated." }, null, 2) }] };
        }
        const backup: Record<string, number> = JSON.parse(readFileSync(backupFile, "utf-8"));

        if (!confirm) {
          return { content: [{ type: "text", text: `DRY RUN: Would restore original prices for ${Object.keys(backup).length} items. Set confirm=true to apply.` }] };
        }

        await Promise.all(
          Object.entries(backup).map(([id, price]) =>
            clover.post<any>(clover.v3(`/items/${id}`), { price })
          )
        );
        unlinkSync(backupFile);
        return { content: [{ type: "text", text: JSON.stringify({ status: "restored", itemsRestored: Object.keys(backup).length }, null, 2) }] };
      }

      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would apply ${discountPercent}% happy hour discount to ${elements.length} items. Set confirm=true to apply.` }] };
      }

      const backup: Record<string, number> = {};
      for (const item of elements) backup[(item as any).id] = (item as any).price ?? 0;
      writeFileSync(backupFile, JSON.stringify(backup));

      const results = await Promise.all(
        elements.map(async (item: any) => {
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

  tool(
    server,
    "get_refund_risk_orders",
    "Flag orders with large or repeated refunds that may need review.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      minRefundCents: z.number().int().nonnegative().max(1_000_000_00).optional().default(1000)
        .describe("Flag refunds above this amount in cents (default $10)"),
    },
    async ({ period, minRefundCents }) => {
      const { startMs } = resolvePeriod(period);

      const elements = await clover.getAll(clover.v3("/refunds"), {
        filter: `createdTime>=${startMs}`,
        expand: "payment,employee",
      });

      const flagged = elements
        .filter((r: any) => (r.amount ?? 0) >= minRefundCents)
        .map((r: any) => ({
          refundId: r.id,
          amount: `$${((r.amount ?? 0) / 100).toFixed(2)}`,
          employee: r.employee?.name ?? "Unknown",
          reason: r.reason ?? "No reason given",
          date: new Date(r.createdTime).toISOString(),
        }))
        .sort((a: any, b: any) => parseFloat(b.amount.replace("$", "")) - parseFloat(a.amount.replace("$", "")));

      const totalRefundedCents = elements.reduce((s: number, r: any) => s + ((r as any).amount ?? 0), 0);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            totalRefunded: `$${(totalRefundedCents / 100).toFixed(2)}`,
            totalRefunds: elements.length,
            flaggedAbove: `$${(minRefundCents / 100).toFixed(2)}`,
            flaggedRefunds: flagged,
          }, null, 2),
        }],
      };
    }
  );
}
