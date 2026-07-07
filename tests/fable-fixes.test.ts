import { CloverClient } from "../src/clover-client.js";
import { registerFinancialTools } from "../src/tools/financial.js";
import { registerSmartTools } from "../src/tools/smart.js";
import { registerMenuOpsTools } from "../src/tools/menu-ops.js";
import { registerOrderTools } from "../src/tools/orders.js";
import { registerInventoryTools } from "../src/tools/inventory.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerOperationsTools } from "../src/tools/operations.js";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

jest.mock("../src/clover-client.js");
import { _resetConfirmations } from "../src/lib/confirm.js";

// Batch 4: mutations now use the two-call token gate. This helper runs the
// request call, extracts the token, and returns it for the confirm call.
async function getToken(fn: Function, args: Record<string, unknown>): Promise<string> {
  const first = await fn(args);
  const m = /confirmationToken="([^"]+)"/.exec(first.content[0].text);
  if (!m) throw new Error("no confirmation token in: " + first.content[0].text);
  return m[1];
}


function makeServer() {
  const tools: Record<string, Function> = {};
  return {
    tool: (name: string, _desc: string, _schema: any, handler: Function) => {
      tools[name] = handler;
    },
    tools,
  } as any;
}

const mockClover = {
  merchantId: "TEST",
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  getAll: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;

describe("F1: 'yesterday' periods are bounded on BOTH ends", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerFinancialTools(server, mockClover);
  });

  test("get_tips_report(yesterday) filter includes an upper createdTime bound", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([]);
    await server.tools["get_tips_report"]({ period: "yesterday" });
    const [, params] = (mockClover.getAll as jest.Mock).mock.calls[0];
    const filters: string[] = params.filter;
    // Pre-fix, only createdTime>= was sent, so "yesterday" included today.
    expect(filters.some((f) => f.startsWith("createdTime>="))).toBe(true);
    expect(filters.some((f) => f.startsWith("createdTime<="))).toBe(true);
    // And the upper bound must be BEFORE now (yesterday ends at midnight).
    const upper = Number(filters.find((f) => f.startsWith("createdTime<="))!.slice("createdTime<=".length));
    expect(upper).toBeLessThan(Date.now());
  });
});

describe("F3: allergen tags exclude items from '-free' dietary searches", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerMenuOpsTools(server, mockClover);
  });

  test("item tagged 'Contains: nuts' is EXCLUDED from nut-free results", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      // Keyword-matches "nut-free" via its description, but is tagged as
      // containing nuts — must be excluded. Pre-fix, the inverted
      // "allergen:nuts" search term could have INCLUDED such an item.
      { id: "A1", name: "Satay Skewers", alternateName: "Contains: nuts, soy", description: "nut-free option available on request" },
      // Genuinely nut-free keyword match, no allergen tag.
      { id: "B2", name: "Garden Salad", alternateName: "", description: "nut-free and vegan" },
    ]);
    const result = await server.tools["get_items_by_dietary"]({ restriction: "nut-free" });
    const parsed = JSON.parse(result.content[0].text);
    const names = parsed.items.map((i: any) => i.name);
    expect(names).toContain("Garden Salad");
    expect(names).not.toContain("Satay Skewers");
    expect(parsed.disclaimer).toMatch(/verify/i);
  });
});

describe("F7: catering quote does not guess between ambiguous items", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerSmartTools(server, mockClover);
  });

  test("multiple substring matches without an exact match → ambiguous, $0, warning", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "P1", name: "Pho Ga", price: 1200 },
      { id: "P2", name: "Pho Bo", price: 1400 },
    ]);
    const result = await server.tools["generate_catering_quote"]({
      partySize: 20,
      itemSelections: [{ itemName: "Pho", quantity: 20 }],
      markupPercent: 15,
    });
    const parsed = JSON.parse(result.content[0].text);
    const line = parsed.quote.lineItems[0];
    expect(line.matched).toBe(false);
    expect(line.ambiguous).toBe(true);
    expect(line.candidates).toEqual(expect.arrayContaining(["Pho Ga", "Pho Bo"]));
    expect(parsed.warning).toMatch(/INCOMPLETE/);
  });

  test("exact name match wins over substring ambiguity", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "P1", name: "Pho Ga", price: 1200 },
      { id: "P2", name: "Pho", price: 1000 },
    ]);
    const result = await server.tools["generate_catering_quote"]({
      partySize: 10,
      itemSelections: [{ itemName: "Pho", quantity: 10 }],
      markupPercent: 0,
    });
    const parsed = JSON.parse(result.content[0].text);
    const line = parsed.quote.lineItems[0];
    expect(line.matched).toBe(true);
    expect(line.item).toBe("Pho");
    expect(parsed.quote.subtotal).toBe("$100.00");
    expect(parsed.warning).toBeUndefined();
  });
});

describe("F1 (extended per CodeRabbit): delivery orders bounded on both ends", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerOrderTools(server, mockClover);
  });

  test("get_delivery_orders(yesterday) sends an upper createdTime bound", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([]);
    await server.tools["get_delivery_orders"]({ period: "yesterday", service: "all" });
    const [, params] = (mockClover.getAll as jest.Mock).mock.calls[0];
    const filters: string[] = params.filter;
    expect(filters.some((f) => f.startsWith("createdTime>="))).toBe(true);
    expect(filters.some((f) => f.startsWith("createdTime<="))).toBe(true);
    const upper = Number(filters.find((f) => f.startsWith("createdTime<="))!.slice("createdTime<=".length));
    expect(upper).toBeLessThan(Date.now());
  });
});

describe("CodeRabbit follow-up: auto_86 surfaces rows with missing item IDs", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerInventoryTools(server, mockClover);
  });

  test("depleted row without item.id is reported as failed, not silently skipped", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { quantity: 0, item: { name: "Mystery Stock" } },            // no id
      { quantity: 0, item: { id: "OK1", name: "Hidden Fine" } },   // hides OK
    ]);
    (mockClover.post as jest.Mock).mockResolvedValue({});
    const token = await getToken(server.tools["auto_86_depleted_items"], {});
    const result = await server.tools["auto_86_depleted_items"]({ confirmationToken: token });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed.autoEightySixed).toBe(1);
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].error).toMatch(/Missing expanded item ID/);
    expect(mockClover.post).toHaveBeenCalledTimes(1);
  });
});

describe("CodeRabbit follow-up: customer search surfaces truncation", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerCustomerTools(server, mockClover);
  });

  test("more than 20 matches reports matchCount and a truncation note", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `C${i}`, firstName: "Nguyen", lastName: `Test${i}`,
    }));
    (mockClover.getAll as jest.Mock).mockResolvedValue(many);
    const result = await server.tools["search_customer"]({ query: "nguyen" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matchCount).toBe(25);
    expect(parsed.results).toHaveLength(20);
    expect(parsed.note).toMatch(/first 20 of 25/);
  });

  test("20 or fewer matches has no truncation note", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "C1", firstName: "Kim", lastName: "V" },
    ]);
    const result = await server.tools["search_customer"]({ query: "kim" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matchCount).toBe(1);
    expect(parsed.note).toBeUndefined();
  });
});

describe("CodeRabbit #37: unified { itemId, itemName, error } failure shape", () => {
  let server: ReturnType<typeof makeServer>;
  let tmp: string;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerMenuOpsTools(server, mockClover);
    registerOperationsTools(server, mockClover);
    // Happy hour writes its price backup under RESERVATIONS_PATH — point it
    // at a throwaway dir so tests never litter the repo.
    tmp = mkdtempSync(join(tmpdir(), "clover-test-"));
    process.env.RESERVATIONS_PATH = tmp;
  });

  afterEach(() => {
    delete process.env.RESERVATIONS_PATH;
    rmSync(tmp, { recursive: true, force: true });
  });

  const expectFailureShape = (failed: any[]) => {
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      itemId: "BAD1",
      itemName: "Broken Item",
      error: expect.stringMatching(/nope/),
    });
  };

  test("seasonal_menu_toggle reports failures with itemId + itemName", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "OK1", name: "Fine Item", price: 100 },
      { id: "BAD1", name: "Broken Item", price: 200 },
    ]);
    (mockClover.post as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("nope"));
    const result = await server.tools["seasonal_menu_toggle"]({ categoryId: "CAT1", visible: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expectFailureShape(parsed.failed);
  });

  test("bulk_update_prices reports failures with itemId + itemName", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "OK1", name: "Fine Item", price: 100 },
      { id: "BAD1", name: "Broken Item", price: 200 },
    ]);
    (mockClover.post as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("nope"));
    const result = await server.tools["bulk_update_prices"]({
      categoryId: "CAT1", changePercent: 10, roundToNearest: 0.05,
      confirmationToken: await getToken(server.tools["bulk_update_prices"], { categoryId: "CAT1", changePercent: 10, roundToNearest: 0.05 }),
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expectFailureShape(parsed.failed);
  });

  test("set_happy_hour_prices reports failures with itemId + itemName", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { id: "OK1", name: "Fine Item", price: 100 },
      { id: "BAD1", name: "Broken Item", price: 200 },
    ]);
    (mockClover.post as jest.Mock)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("nope"));
    const result = await server.tools["set_happy_hour_prices"]({
      categoryId: "CAT2", discountPercent: 20, restore: false,
      confirmationToken: await getToken(server.tools["set_happy_hour_prices"], { categoryId: "CAT2", discountPercent: 20, restore: false }),
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expectFailureShape(parsed.failed);
  });
});
