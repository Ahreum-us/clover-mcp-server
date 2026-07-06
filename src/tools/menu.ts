import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { CLOVER_ID } from "../lib/ids.js";

// $100,000.00 ceiling — far above any real menu item, but blocks an agent from
// fat-fingering a price into the millions, or sending a negative/float/NaN.
const PRICE_CENTS = z
  .number()
  .int("priceCents must be a whole number of cents")
  .nonnegative("priceCents cannot be negative")
  .max(10_000_000, "priceCents exceeds the $100,000 sanity ceiling");

export function registerMenuTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_menu_items",
    "Get all menu items with prices, categories, and availability",
    { category: z.string().max(100).optional().describe("Filter by category name") },
    async ({ category }) => {
      // F4 fix: getAll — menus over 200 items were silently truncated.
      let items = await clover.getAll<any>(clover.v3("/items"), {
        expand: "categories,modifierGroups,tags",
      });
      if (category) {
        items = items.filter((i: any) =>
          i.categories?.elements?.some((c: any) =>
            c.name.toLowerCase().includes(category.toLowerCase())
          )
        );
      }
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  tool(
    server,
    "get_menu_categories",
    "Get all menu categories",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/categories"), { limit: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  tool(
    server,
    "get_item_modifiers",
    "Get modifier groups for a menu item (e.g. broth type, spice level, toppings)",
    { itemId: CLOVER_ID.describe("Clover item ID") },
    async ({ itemId }) => {
      const data = await clover.get<any>(clover.v3(`/items/${itemId}/modifier_groups`), {
        expand: "modifiers",
      });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  tool(
    server,
    "set_item_availability",
    "Mark a menu item as available or 86'd (unavailable). Use when an ingredient runs out.",
    {
      itemId: CLOVER_ID.describe("Clover item ID"),
      available: z.boolean().describe("true = available, false = 86'd"),
    },
    async ({ itemId, available }) => {
      await clover.post<any>(clover.v3(`/items/${itemId}`), { hidden: !available });
      return {
        content: [{
          type: "text",
          text: `Item ${itemId} is now ${available ? "available" : "86'd (hidden from menu)"}.`,
        }],
      };
    }
  );

  tool(
    server,
    "update_item_price",
    "Update the price of a menu item. Returns a dry-run preview unless confirm=true.",
    {
      itemId: CLOVER_ID.describe("Clover item ID"),
      priceCents: PRICE_CENTS.describe("New price in cents (e.g. 1299 = $12.99)"),
      confirm: z.boolean().optional().default(false).describe("Must be true to apply the change"),
    },
    async ({ itemId, priceCents, confirm }) => {
      if (!confirm) {
        // Fetch current price so the preview shows a real before/after.
        const current = await clover.get<any>(clover.v3(`/items/${itemId}`));
        const oldPrice = current?.price ?? null;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "DRY_RUN",
              itemId,
              itemName: current?.name ?? null,
              currentPrice: oldPrice === null ? "unknown" : `$${(oldPrice / 100).toFixed(2)}`,
              newPrice: `$${(priceCents / 100).toFixed(2)}`,
              message: "Set confirm=true to apply this price change.",
            }, null, 2),
          }],
        };
      }
      await clover.post<any>(clover.v3(`/items/${itemId}`), { price: priceCents });
      return {
        content: [{
          type: "text",
          text: `Price for item ${itemId} updated to $${(priceCents / 100).toFixed(2)}.`,
        }],
      };
    }
  );
}
