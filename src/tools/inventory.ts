import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { CLOVER_ID } from "../lib/ids.js";

export function registerInventoryTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_inventory_levels",
    "Get current stock levels for all tracked inventory items",
    {},
    async () => {
      const elements = await clover.getAll(clover.v3("/item_stocks"), {
        expand: "item",
      });
      return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
    }
  );

  tool(
    server,
    "check_low_stock",
    "Find items below a stock threshold. Returns items that need reordering.",
    {
      threshold: z.number().nonnegative().max(1_000_000).optional().default(5).describe("Warn when quantity is at or below this number"),
    },
    async ({ threshold }) => {
      const elements = await clover.getAll(clover.v3("/item_stocks"), {
        expand: "item",
      });

      const lowStock = elements.filter(
        (s: any) => s.quantity !== undefined && s.quantity <= threshold
      ).map((s: any) => ({
        itemId: s.item?.id,
        name: s.item?.name,
        quantity: s.quantity,
        unit: s.unit ?? "units",
      }));

      if (lowStock.length === 0) {
        return { content: [{ type: "text", text: "All items are above the threshold. No reordering needed." }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(lowStock, null, 2) }] };
    }
  );

  tool(
    server,
    "update_inventory",
    "Update stock quantity for an item (e.g. after receiving a delivery)",
    {
      itemId: CLOVER_ID.describe("Clover item ID"),
      quantity: z.number().int().nonnegative().max(1_000_000).describe("New stock quantity"),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
      note: z.string().optional().describe("e.g. 'Received delivery from supplier'"),
    },
    async ({ itemId, quantity, confirm }) => {
      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would update stock for item ${itemId} to ${quantity}. Set confirm=true to apply.` }] };
      }
      await clover.post<any>(clover.v3(`/item_stocks/${itemId}`), { quantity });
      return {
        content: [{ type: "text", text: `Stock for item ${itemId} updated to ${quantity}.` }],
      };
    }
  );

  tool(
    server,
    "adjust_inventory",
    "Adjust stock by a delta (positive = add, negative = remove). Use for waste tracking or corrections.",
    {
      itemId: CLOVER_ID.describe("Clover item ID"),
      delta: z.number().int().min(-1_000_000).max(1_000_000).describe("Amount to add (positive) or remove (negative)"),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
      reason: z.string().optional().describe("e.g. 'waste', 'spillage', 'delivery'"),
    },
    async ({ itemId, delta, confirm, reason }) => {
      const current = await clover.get<any>(clover.v3(`/item_stocks/${itemId}`));
      if (current.quantity === undefined || current.quantity === null) {
        throw new Error(`Item ${itemId} has no tracked stock quantity.`);
      }
      const newQty = current.quantity + delta;
      if (newQty < 0) {
        throw new Error(`Adjustment would result in negative stock (${current.quantity} + ${delta} = ${newQty}). Aborting.`);
      }

      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would adjust ${itemId}: ${current.quantity} → ${newQty}${reason ? ` (${reason})` : ""}. Set confirm=true to apply.` }] };
      }

      await clover.post<any>(clover.v3(`/item_stocks/${itemId}`), { quantity: newQty });
      return {
        content: [{
          type: "text",
          text: `Adjusted ${itemId}: ${current.quantity} → ${newQty}${reason ? ` (${reason})` : ""}.`,
        }],
      };
    }
  );

  tool(
    server,
    "auto_86_depleted_items",
    "Scan inventory and automatically hide any items with zero stock from the menu",
    {
      confirm: z.boolean().optional().default(false).describe("Must be true to apply changes"),
    },
    async ({ confirm }) => {
      const elements = await clover.getAll(clover.v3("/item_stocks"), {
        expand: "item",
      });

      const depleted = elements.filter(
        (s: any) => s.quantity !== undefined && s.quantity <= 0
      );

      if (depleted.length === 0) {
        return { content: [{ type: "text", text: "No depleted items found. Nothing to 86." }] };
      }

      const names: string[] = depleted.map((s: any) => s.item?.name ?? s.item?.id).filter(Boolean);

      if (!confirm) {
        return { content: [{ type: "text", text: `DRY RUN: Would auto-86 ${names.length} item(s): ${names.join(", ")}. Set confirm=true to apply.` }] };
      }

      // F5 fix: collect per-item failures instead of aborting mid-loop, so a
      // failed write can't leave some items hidden with no report of which.
      const hidden: string[] = [];
      const failed: { item: string; error: string }[] = [];
      for (const s of depleted) {
        const stock = s as any;
        const item = stock.item;
        // CodeRabbit (PR #35): a depleted row without an expanded item ID used
        // to be silently skipped — the tool could report success while that
        // item stayed visible with no retry target. Surface it as a failure.
        if (!item?.id) {
          failed.push({
            item: item?.name ?? stock.id ?? "unknown item stock",
            error: "Missing expanded item ID; cannot hide menu item.",
          });
          continue;
        }
        try {
          await clover.post<any>(clover.v3(`/items/${item.id}`), { hidden: true });
          hidden.push(item.name ?? item.id);
        } catch (err) {
          failed.push({
            item: item.name ?? item.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const summary: Record<string, unknown> = {
        autoEightySixed: hidden.length,
        items: hidden,
      };
      if (failed.length > 0) {
        summary.warning = `${failed.length} item(s) FAILED to hide — still visible on the menu. Retry these.`;
        summary.failed = failed;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        ...(failed.length > 0 ? { isError: true } : {}),
      };
    }
  );
}
