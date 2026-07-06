import { CloverClient } from "../src/clover-client.js";
import { registerFinancialTools } from "../src/tools/financial.js";
import { registerSmartTools } from "../src/tools/smart.js";
import { registerMenuOpsTools } from "../src/tools/menu-ops.js";

jest.mock("../src/clover-client.js");

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
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  getAll: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;

describe("F1: 'yesterday' periods are bounded on BOTH ends", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
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
