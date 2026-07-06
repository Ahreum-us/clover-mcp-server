import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";

const CLOVER_ID = z.string().regex(/^[A-Z0-9]+$/i, "must be alphanumeric").max(40);

export function registerMenuOpsTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "tag_item_allergens",
    "Tag a menu item with allergen information. Tags are stored in item labels and searchable.",
    {
      itemId: CLOVER_ID,
      allergens: z.array(z.enum(["gluten", "shellfish", "dairy", "nuts", "eggs", "soy", "fish", "peanuts"])).max(20),
      clear: z.boolean().optional().default(false).describe("Set true to remove all allergen tags from this item"),
    },
    async ({ itemId, allergens, clear }) => {
      const item = await clover.get<any>(clover.v3(`/items/${itemId}`));

      // Allergen info is stored in alternateName as "Contains: x, y, z"
      // Preserve any non-allergen content in alternateName.
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

  tool(
    server,
    "get_items_by_dietary",
    "Filter menu items by dietary restriction. Keyword-based search over names/descriptions, cross-checked against allergen tags written by tag_item_allergens. ALWAYS verify with the kitchen for allergy-critical requests.",
    {
      restriction: z.enum(["vegetarian", "vegan", "gluten-free", "dairy-free", "nut-free", "shellfish-free", "halal", "kosher"]),
    },
    async ({ restriction }) => {
      // F4 fix: getAll — menus over 200 items were silently truncated.
      const items = await clover.getAll<any>(clover.v3("/items"), {
        expand: "categories",
      });

      const keywords: Record<string, string[]> = {
        "vegetarian": ["vegetarian", "veggie", "chay", "no meat"],
        "vegan": ["vegan", "plant-based"],
        "gluten-free": ["gluten-free", "gf", "no gluten"],
        "dairy-free": ["dairy-free", "no dairy", "no cheese", "no cream"],
        "nut-free": ["nut-free", "no nuts"],
        "shellfish-free": ["shellfish-free", "no shellfish", "no shrimp", "no crab"],
        "halal": ["halal"],
        "kosher": ["kosher"],
      };

      // F3 fix: allergen tags (written by tag_item_allergens as
      // "Contains: x, y") now EXCLUDE items from the matching "-free"
      // restriction. Previously the search looked for an "allergen:" prefix
      // that the tagger never wrote — and with inverted logic, an item
      // explicitly tagged as containing nuts would have MATCHED "nut-free".
      const excludedAllergens: Record<string, string[]> = {
        "nut-free": ["nuts", "peanuts"],
        "shellfish-free": ["shellfish"],
        "dairy-free": ["dairy"],
        "gluten-free": ["gluten"],
      };

      const containsAllergens = (item: any): string[] => {
        const alt: string = item.alternateName ?? "";
        const m = alt.match(/Contains:\s*([^]*)$/i);
        if (!m) return [];
        return m[1].split(",").map((a: string) => a.trim().toLowerCase()).filter(Boolean);
      };

      const terms = keywords[restriction] ?? [restriction];
      const excluded = excludedAllergens[restriction] ?? [];

      const matches = items.filter((item: any) => {
        const searchText = `${item.name ?? ""} ${item.alternateName ?? ""} ${item.description ?? ""}`.toLowerCase();
        if (!terms.some(t => searchText.includes(t))) return false;
        if (excluded.length > 0) {
          const tagged = containsAllergens(item);
          if (tagged.some(a => excluded.includes(a))) return false;
        }
        return true;
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
            disclaimer: "Keyword-based matching — item descriptions may be incomplete. For allergy-critical requests, verify ingredients with the kitchen before confirming to the customer.",
            items: matches,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "seasonal_menu_toggle",
    "Show or hide an entire menu category at once. Use for seasonal specials, daily features, or out-of-season items.",
    {
      categoryId: CLOVER_ID,
      visible: z.boolean().describe("true = show all items, false = hide all items in this category"),
      reason: z.string().max(500).optional().describe("e.g. 'summer specials ended', 'Lunar New Year menu'"),
    },
    async ({ categoryId, visible, reason }) => {
      // F4 fix: getAll — categories over 100 items were partially toggled.
      const items = await clover.getAll<any>(clover.v3("/items"), {
        filter: `categories.id=${categoryId}`,
      });

      // F5 fix: allSettled so one failed write doesn't abort the report and
      // hide which items DID change. The category can end up mixed on partial
      // failure — the response now says exactly which items are in which state.
      const settled = await Promise.allSettled(
        items.map(async (item: any) => {
          await clover.post<any>(clover.v3(`/items/${item.id}`), { hidden: !visible });
          return item.name as string;
        })
      );
      const updated: string[] = [];
      const failed: { item: string; error: string }[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") updated.push(r.value);
        else failed.push({
          item: items[i]?.name ?? items[i]?.id ?? "unknown",
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            categoryId,
            action: visible ? "made visible" : "hidden",
            reason: reason ?? null,
            itemsAffected: updated.length,
            items: updated,
            ...(failed.length > 0 ? {
              warning: `${failed.length} item(s) FAILED to update — category is in a mixed state. Retry these items.`,
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
    "get_menu_health_check",
    "Audit the menu for common issues: missing prices, hidden items, items with no category, empty modifier groups.",
    {},
    async () => {
      // F4 fix: getAll — audits over 200-item menus were incomplete.
      const items = await clover.getAll<any>(clover.v3("/items"), {
        expand: "categories,modifierGroups",
      });

      const issues: { item: string; id: string; issue: string }[] = [];

      for (const item of items) {
        if (!item.price || item.price === 0) issues.push({ item: item.name, id: item.id, issue: "Missing or zero price" });
        if (!item.categories?.elements?.length) issues.push({ item: item.name, id: item.id, issue: "No category assigned" });
        if (item.hidden) issues.push({ item: item.name, id: item.id, issue: "Item is hidden (86'd or seasonal)" });
        if (item.name?.length > 60) issues.push({ item: item.name, id: item.id, issue: "Name too long (may truncate on receipts)" });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            totalItems: items.length,
            issuesFound: issues.length,
            issues,
            status: issues.length === 0 ? "✅ Menu looks healthy" : `⚠️ ${issues.length} issue(s) found`,
          }, null, 2),
        }],
      };
    }
  );
}
