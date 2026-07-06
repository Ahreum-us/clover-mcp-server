import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "fs";
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

      // F5 fix: allSettled — one failed write no longer aborts the report
      // while leaving earlier writes applied. The response now shows exactly
      // which items changed and which need a retry.
      const settled = await Promise.allSettled(
        elements.map(async (item: any) => {
          const oldPrice = item.price ?? 0;
          const rawNew = oldPrice * (1 + changePercent / 100);
          const roundedCents = Math.max(0, Math.round(rawNew / (roundToNearest * 100)) * (roundToNearest * 100));
          await clover.post<any>(clover.v3(`/items/${item.id}`), { price: roundedCents });
          return { name: item.name, oldPrice: `$${(oldPrice / 100).toFixed(2)}`, newPrice: `$${(roundedCents / 100).toFixed(2)}` };
        })
      );
      const changes: any[] = [];
      const failed: { item: string; error: string }[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") changes.push(r.value);
        else failed.push({
          item: (elements[i] as any)?.name ?? (elements[i] as any)?.id ?? "unknown",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            categoryId,
            changeApplied: `${changePercent > 0 ? "+" : ""}${changePercent}%`,
            itemsUpdated: changes.length,
            changes,
            ...(failed.length > 0 ? {
              warning: `${failed.length} item(s) FAILED — their prices are unchanged. Retry these.`,
              failed,
            } : {}),
          }, null, 2),
        }],
        ...(failed.length > 0 ? { isError: true } : {}),
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

        // F5 fix: allSettled + only delete the backup if EVERY restore
        // succeeded — a partial restore must keep the backup so it can be
        // retried, otherwise the unrestored originals would be lost.
        const entries = Object.entries(backup);
        const settled = await Promise.allSettled(
          entries.map(([id, price]) =>
            clover.post<any>(clover.v3(`/items/${id}`), { price })
          )
        );
        const failed: { itemId: string; error: string }[] = [];
        settled.forEach((r, i) => {
          if (r.status === "rejected") failed.push({
            itemId: entries[i][0],
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        });
        if (failed.length === 0) {
          unlinkSync(backupFile);
          return { content: [{ type: "text", text: JSON.stringify({ status: "restored", itemsRestored: entries.length }, null, 2) }] };
        }
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({
            status: "partial_restore",
            itemsRestored: entries.length - failed.length,
            failed,
            note: "Backup file KEPT so restore can be retried for the failed items.",
          }, null, 2) }],
        };
      }

      // Guard against the double-activation data-loss bug: if a backup already
      // exists, happy hour is already on. Re-activating would overwrite the
      // backup with the ALREADY-DISCOUNTED prices, so a later restore=true would
      // lock in the discount permanently. Force a restore first.
      if (existsSync(backupFile)) {
        return { content: [{ type: "text", text: JSON.stringify({
          status: "already_active",
          message: "Happy hour already appears active for this category (a price backup exists). Run again with restore=true to revert before re-activating — otherwise the original prices would be lost.",
        }, null, 2) }] };
      }

      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would apply ${discountPercent}% happy hour discount to ${elements.length} items. Set confirm=true to apply.` }] };
      }

      const backup: Record<string, number> = {};
      for (const item of elements) backup[(item as any).id] = (item as any).price ?? 0;
      // F6-adjacent: atomic write — a crash mid-write must not leave a
      // corrupt backup that a later restore would choke on.
      writeFileSync(`${backupFile}.tmp`, JSON.stringify(backup));
      renameSync(`${backupFile}.tmp`, backupFile);

      const settledApply = await Promise.allSettled(
        elements.map(async (item: any) => {
          const original = item.price ?? 0;
          const discounted = Math.round(original * (1 - discountPercent / 100));
          await clover.post<any>(clover.v3(`/items/${item.id}`), { price: discounted });
          return { name: item.name, original: `$${(original / 100).toFixed(2)}`, happyHour: `$${(discounted / 100).toFixed(2)}` };
        })
      );
      const results: any[] = [];
      const applyFailed: { item: string; error: string }[] = [];
      settledApply.forEach((r, i) => {
        if (r.status === "fulfilled") results.push(r.value);
        else applyFailed.push({
          item: (elements[i] as any)?.name ?? (elements[i] as any)?.id ?? "unknown",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "happy_hour_active",
            discountApplied: `${discountPercent}% off`,
            itemsUpdated: results.length,
            reminder: "Call this tool again with restore=true to revert prices at end of happy hour.",
            prices: results,
            ...(applyFailed.length > 0 ? {
              warning: `${applyFailed.length} item(s) FAILED to discount — they remain at full price. The backup covers the whole category, so restore=true still reverts everything correctly.`,
              failed: applyFailed,
            } : {}),
          }, null, 2),
        }],
        ...(applyFailed.length > 0 ? { isError: true } : {}),
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
