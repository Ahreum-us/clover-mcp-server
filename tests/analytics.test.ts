import { CloverClient } from "../src/clover-client.js";
import { registerAnalyticsTools } from "../src/tools/analytics.js";
import { resolvePeriod, parseDate, parseEndDate } from "../src/lib/date.js";

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
} as unknown as CloverClient;

describe("get_top_selling_items revenue math", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = makeServer();
    registerAnalyticsTools(server, mockClover);
  });

  test("multiplies price by unitQty (the Phase 2 bug fix)", async () => {
    // Two line items: one with unitQty=3 ($10 * 3 = $30), one default qty ($5).
    // Pre-fix, the first was credited $10 instead of $30.
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      {
        lineItems: {
          elements: [
            { item: { id: "x" }, name: "Pho",   price: 1000, unitQty: 3 },
            { item: { id: "y" }, name: "Spring Roll", price: 500 },
          ],
        },
      },
    ]);
    const result = await server.tools["get_top_selling_items"]({ period: "week", topN: 10, sortBy: "revenue" });
    const parsed = JSON.parse(result.content[0].text);
    const pho = parsed.find((p: any) => p.name === "Pho");
    const sr = parsed.find((p: any) => p.name === "Spring Roll");
    expect(pho.revenue).toBe("$30.00");
    expect(pho.qty).toBe(3);
    expect(sr.revenue).toBe("$5.00");
    expect(sr.qty).toBe(1);
  });

  test("ranks by revenue when sortBy=revenue", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      {
        lineItems: {
          elements: [
            { item: { id: "a" }, name: "Cheap",     price: 100, unitQty: 10 }, // $10 total
            { item: { id: "b" }, name: "Expensive", price: 2000 },              // $20 total
          ],
        },
      },
    ]);
    const result = await server.tools["get_top_selling_items"]({ period: "week", topN: 2, sortBy: "revenue" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0].name).toBe("Expensive");
    expect(parsed[1].name).toBe("Cheap");
  });
});

describe("resolvePeriod", () => {
  test("custom requires both dates", () => {
    expect(() => resolvePeriod("custom")).toThrow(/required when period=custom/);
    expect(() => resolvePeriod("custom", "2026-01-01")).toThrow(/required when period=custom/);
  });

  test("custom rejects end < start", () => {
    expect(() =>
      resolvePeriod("custom", "2026-06-10", "2026-06-01")
    ).toThrow(/before startDate/);
  });

  test("custom end date is inclusive of the whole end day (F2 fix)", () => {
    const r = resolvePeriod("custom", "2026-06-01", "2026-06-05");
    expect(r.startMs).toBe(Date.parse("2026-06-01"));
    // Pre-fix this was midnight STARTING June 5, silently excluding the
    // final day of the range from tax reports and order lookups.
    expect(r.endMs).toBe(Date.parse("2026-06-05") + 24 * 60 * 60 * 1000 - 1);
  });

  test("custom end with explicit timestamp is honored exactly", () => {
    const r = resolvePeriod("custom", "2026-06-01", "2026-06-05T14:30:00Z");
    expect(r.endMs).toBe(Date.parse("2026-06-05T14:30:00Z"));
  });

  test("today ends at now (within a few ms)", () => {
    const before = Date.now();
    const r = resolvePeriod("today");
    const after = Date.now();
    expect(r.endMs).toBeGreaterThanOrEqual(before);
    expect(r.endMs).toBeLessThanOrEqual(after);
  });

  test("week is exactly 7 days back", () => {
    const r = resolvePeriod("week");
    expect(r.endMs - r.startMs).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -3);
  });
});

describe("parseEndDate", () => {
  test("bare date extends to end of day", () => {
    expect(parseEndDate("2026-06-05", "f")).toBe(
      Date.parse("2026-06-05") + 24 * 60 * 60 * 1000 - 1
    );
  });

  test("explicit timestamp is unchanged", () => {
    expect(parseEndDate("2026-06-05T14:30:00Z", "f")).toBe(Date.parse("2026-06-05T14:30:00Z"));
  });

  test("rejects garbage with field name", () => {
    expect(() => parseEndDate("nope", "endDate")).toThrow(/endDate/);
  });
});

describe("parseDate", () => {
  test("accepts ISO date", () => {
    expect(parseDate("2026-06-01", "f")).toBe(Date.parse("2026-06-01"));
  });

  test("rejects garbage", () => {
    expect(() => parseDate("not a date", "myField")).toThrow(/myField/);
    expect(() => parseDate("not a date", "myField")).toThrow(/not a parseable date/);
  });

  test("rejects empty string", () => {
    expect(() => parseDate("", "f")).toThrow(/non-empty string/);
  });
});
