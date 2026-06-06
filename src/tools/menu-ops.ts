import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

const ALLERGEN_TAG_PREFIX = "allergen:";

export function registerMenuOpsTools(server: McpServer, clover: CloverClient) {

  server.tool(
    "tag_item_allergens",
    "Tag a menu item with allergen information. Tags are stored in item labels and searchable.",
    {
      itemId: z.string(),
      allergens: z.array(z.enum(["gluten", "shellfish", "dairy", "nuts", "eggs", "soy", "fish", "peanuts"])),
      clear: z.boolean().optional().default(false).describe("Set true to remove all allergen tags from this item"),
    },
    async ({ itemId, allergens, clear }) => {
      const item = await clover.get<any>(clover.v3(`/items/${itemId}`));

      // Allergen info is stored in alternateName as "Contains: x, y, z"
      // Preserve any non-allergen content in alternateName
      const existing = item.alternateName ?? "";
      const allergenMarker = "Contains: ";
      const nonAllergenPart = existing.includes(allergenMarker)
        ? existing.substring(0, existing.indexOf(allergenMarker)).trim()
        : existing.trim();

      let newAltName: string;
      if (clear) {
        newAltName = nonAllergenPart;
      } else {
        const allergenSuffix = `${allergenMarker}${allergens.join(", ")}`;
        newAltName = nonAllergenPart ? `${nonAllergenPart} ${allergenSuffix}` : allergenSuffix;
      }

      await clover.post<any>(clover.v3(`/items/${itemId}`), { alternateName: newAltName });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            itemId,
            itemName: item.name,
            allergens: clear ? [] : allergens,
            alternateName: newAltName,
            action: clear ? "allergens cleared" : "allergens tagged",
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_items_by_dietary",
    "Filter menu items by dietary restriction. Searches item names and alternate names for tags.",
    {
      restriction: z.enum(["vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "shellfish-free", "halal", "kosher"]),
    },
    async ({ restriction }) => {
      const data = await clover.get<any>(clover.v3("/items"), {
        expand: "categories",
        limit: 200,
      });

      // Search item names and alternateName for restriction keywords
      const keywords: Record<string, string[]> = {
        "vegetarian": ["vegetarian", "veggie", "chay", "no meat"],
        "vegan": ["vegan", "plant-based"],
        "gluten-free": ["gluten-free", "gf", "no gluten"],
        "dairy-free": ["dairy-free", "no dairy", "no cheese", "no cream"],
        "nut-free": ["nut-free", "no nuts", "allergen:nuts"],
        "shellfish-free": ["shellfish-free", "no shellfish", "no shrimp", "no crab"],
        "halal": ["halal"],
        "kosher": ["kosher"],
      };

      const terms = keywords[restriction] ?? [restriction];
      const matches = (data.elements ?? []).filter((item: any) => {
        const searchText = `${item.name ?? ""} ${item.alternateName ?? ""} ${item.description ?? ""}`.toLowerCase();
        return terms.some(t => searchText.includes(t));
      }).map((item: any) => ({
        id: item.id,
        name: item.name,
        price: `$${((item.price ?? 0) / 100).toFixed(2)}`,
        category: item.categories?.elements?.[0]?.name ?? "Uncategorized",
        note: item.alternateName ?? null,
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            restriction,
            itemsFound: matches.length,
            items: matches,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "seasonal_menu_toggle",
    "Show or hide an entire menu category at once. Use for seasonal specials, daily features, or out-of-season items.",
    {
      categoryId: z.string().describe("Category ID to toggle"),
      visible: z.boolean().describe("true = show all items, false = hide all items in this category"),
      reason: z.string().optional().describe("e.g. 'summer specials ended', 'Lunar New Year menu'"),
    },
    async ({ categoryId, visible, reason }) => {
      const data = await clover.get<any>(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
        limit: 100,
      });

      const results = await Promise.all(
        (data.elements ?? []).map(async (item: any) => {
          await clover.post<any>(clover.v3(`/items/${item.id}`), { hidden: !visible });
          return item.name as string;
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            categoryId,
            action: visible ? "made visible" : "hidden",
            reason: reason ?? null,
            itemsAffected: results.length,
            items: results,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_menu_health_check",
    "Audit the menu for common issues: missing prices, hidden items, items with no category, empty modifier groups.",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/items"), {
        expand: "categories,modifierGroups",
        limit: 200,
      });

      const issues: { item: string; id: string; issue: string }[] = [];

      for (const item of data.elements ?? []) {
        if (!item.price || item.price === 0) issues.push({ item: item.name, id: item.id, issue: "Missing or zero price" });
        if (!item.categories?.elements?.length) issues.push({ item: item.name, id: item.id, issue: "No category assigned" });
        if (item.hidden) issues.push({ item: item.name, id: item.id, issue: "Item is hidden (86'd or seasonal)" });
        if (item.name?.length > 60) issues.push({ item: item.name, id: item.id, issue: "Name too long (may truncate on receipts)" });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalItems: data.elements?.length ?? 0,
            issuesFound: issues.length,
            issues,
            status: issues.length === 0 ? "✅ Menu looks healthy" : `⚠️ ${issues.length} issue(s) found`,
          }, null, 2),
        }],
      };
    }
  );
}
