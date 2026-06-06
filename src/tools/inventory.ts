import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerInventoryTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "get_inventory_levels",
    "Get current stock levels for all tracked inventory items",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/item_stocks"), {
        expand: "item",
        limit: 200,
      });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "check_low_stock",
    "Find items below a stock threshold. Returns items that need reordering.",
    {
      threshold: z.number().optional().default(5).describe("Warn when quantity is at or below this number"),
    },
    async ({ threshold }) => {
      const data = await clover.get<any>(clover.v3("/item_stocks"), {
        expand: "item",
        limit: 200,
      });

      const lowStock = (data.elements ?? []).filter(
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

  server.tool(
    "update_inventory",
    "Update stock quantity for an item (e.g. after receiving a delivery)",
    {
      itemId: z.string().describe("Clover item ID"),
      quantity: z.number().describe("New stock quantity"),
      note: z.string().optional().describe("e.g. 'Received delivery from supplier'"),
    },
    async ({ itemId, quantity }) => {
      await clover.post<any>(clover.v3(`/item_stocks/${itemId}`), { quantity });
      return {
        content: [{ type: "text", text: `Stock for item ${itemId} updated to ${quantity}.` }],
      };
    }
  );

  server.tool(
    "adjust_inventory",
    "Adjust stock by a delta (positive = add, negative = remove). Use for waste tracking or corrections.",
    {
      itemId: z.string().describe("Clover item ID"),
      delta: z.number().describe("Amount to add (positive) or remove (negative)"),
      reason: z.string().optional().describe("e.g. 'waste', 'spillage', 'delivery'"),
    },
    async ({ itemId, delta, reason }) => {
      const current = await clover.get<any>(clover.v3(`/item_stocks/${itemId}`));
      if (current.quantity === undefined || current.quantity === null) {
        throw new Error(`Item ${itemId} has no tracked stock quantity.`);
      }
      const newQty = current.quantity + delta;
      if (newQty < 0) {
        throw new Error(`Adjustment would result in negative stock (${current.quantity} + ${delta} = ${newQty}). Aborting.`);
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

  server.tool(
    "auto_86_depleted_items",
    "Scan inventory and automatically hide any items with zero stock from the menu",
    {},
    async () => {
      const stocks = await clover.get<any>(clover.v3("/item_stocks"), {
        expand: "item",
        limit: 200,
      });

      const depleted = (stocks.elements ?? []).filter(
        (s: any) => s.quantity !== undefined && s.quantity <= 0
      );

      if (depleted.length === 0) {
        return { content: [{ type: "text", text: "No depleted items found. Nothing to 86." }] };
      }

      const results: string[] = [];
      for (const s of depleted) {
        if (!s.item?.id) continue;
        await clover.post<any>(clover.v3(`/items/${s.item.id}`), { hidden: true });
        results.push(s.item.name ?? s.item.id);
      }

      return {
        content: [{
          type: "text",
          text: `Auto-86'd ${results.length} item(s): ${results.join(", ")}`,
        }],
      };
    }
  );
}
