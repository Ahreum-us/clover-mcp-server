import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerMenuTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "get_menu_items",
    "Get all menu items with prices, categories, and availability",
    { category: z.string().optional().describe("Filter by category name") },
    async ({ category }) => {
      const data = await clover.get<any>(clover.v3("/items"), {
        expand: "categories,modifierGroups,tags",
        limit: 200,
      });
      let items = data.elements ?? [];
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

  server.tool(
    "get_menu_categories",
    "Get all menu categories",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/categories"), { limit: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "get_item_modifiers",
    "Get modifier groups for a menu item (e.g. broth type, spice level, toppings)",
    { itemId: z.string().describe("Clover item ID") },
    async ({ itemId }) => {
      const data = await clover.get<any>(clover.v3(`/items/${itemId}/modifier_groups`), {
        expand: "modifiers",
      });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "set_item_availability",
    "Mark a menu item as available or 86'd (unavailable). Use when an ingredient runs out.",
    {
      itemId: z.string().describe("Clover item ID"),
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

  server.tool(
    "update_item_price",
    "Update the price of a menu item",
    {
      itemId: z.string().describe("Clover item ID"),
      priceCents: z.number().describe("New price in cents (e.g. 1299 = $12.99)"),
    },
    async ({ itemId, priceCents }) => {
      await clover.post<any>(clover.v3(`/items/${itemId}`), { price: priceCents });
      return {
        content: [{
          type: "text",
          text: `Price updated to $${(priceCents / 100).toFixed(2)}.`,
        }],
      };
    }
  );
}
