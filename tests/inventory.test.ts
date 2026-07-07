import { CloverClient } from "../src/clover-client.js";
import { registerInventoryTools } from "../src/tools/inventory.js";
import { _resetConfirmations } from "../src/lib/confirm.js";

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

// Phase 2: mock now includes getAll, which check_low_stock and friends
// actually use. The previous test left getAll undefined, which crashed
// at runtime with a TypeError that the failing assertion was hiding.
const mockClover = {
  merchantId: "TEST",
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  getAll: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;


// Batch 4: mutations now use the two-call token gate. This helper runs the
// request call, extracts the token, and returns it for the confirm call.
async function getToken(fn: Function, args: Record<string, unknown>): Promise<string> {
  const first = await fn(args);
  const m = /confirmationToken="([^"]+)"/.exec(first.content[0].text);
  if (!m) throw new Error("no confirmation token in: " + first.content[0].text);
  return m[1];
}

describe("adjust_inventory", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerInventoryTools(server, mockClover);
  });

  test("first call (no token) does not call post and issues a confirmation", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 10 });
    const result = await server.tools["adjust_inventory"]({ itemId: "item1", delta: -3 });
    expect(mockClover.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/CONFIRMATION REQUIRED/);
    expect(result.content[0].text).toMatch(/10 → 7/);
    expect(result.content[0].text).toMatch(/confirmationToken="/);
  });

  test("with a valid token, adjusts stock by delta", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 10 });
    (mockClover.post as jest.Mock).mockResolvedValue({});
    const token = await getToken(server.tools["adjust_inventory"], { itemId: "item1", delta: -3, reason: "waste" });
    const result = await server.tools["adjust_inventory"]({
      itemId: "item1", delta: -3, reason: "waste", confirmationToken: token,
    });
    expect(mockClover.post).toHaveBeenCalledWith(
      expect.stringContaining("item1"),
      { quantity: 7 }
    );
    expect(result.content[0].text).toContain("10 → 7");
  });

  // F12: inventory tools now go through the tool() wrapper, which converts
  // thrown errors into isError results (preserving CloverApiError context).
  // These tests assert the wrapped shape instead of a raw throw.
  test("rejects adjustment that would go negative", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 2 });
    // Guards fire BEFORE the gate: an impossible adjustment is rejected on the
    // first call, with no confirmation round-trip to burn.
    const result = await server.tools["adjust_inventory"]({ itemId: "item1", delta: -5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/negative stock/);
    expect(mockClover.post).not.toHaveBeenCalled();
  });

  test("rejects item with no tracked quantity", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({});
    const result = await server.tools["adjust_inventory"]({ itemId: "item1", delta: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no tracked stock quantity/);
    expect(mockClover.post).not.toHaveBeenCalled();
  });
});

describe("check_low_stock", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerInventoryTools(server, mockClover);
  });

  test("returns items below threshold", async () => {
    // PHASE 2: implementation calls getAll, not get.
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { quantity: 3, item: { id: "a", name: "Galbi" }, unit: "lbs" },
      { quantity: 10, item: { id: "b", name: "Brisket" }, unit: "lbs" },
    ]);
    const result = await server.tools["check_low_stock"]({ threshold: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Galbi");
  });

  test("returns all-clear when nothing low", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { quantity: 20, item: { id: "a", name: "Brisket" } },
    ]);
    const result = await server.tools["check_low_stock"]({ threshold: 5 });
    expect(result.content[0].text).toContain("above the threshold");
  });

  test("handles items with undefined quantity (untracked)", async () => {
    (mockClover.getAll as jest.Mock).mockResolvedValue([
      { item: { id: "a", name: "Untracked" } },
      { quantity: 2, item: { id: "b", name: "Tofu" }, unit: "blocks" },
    ]);
    const result = await server.tools["check_low_stock"]({ threshold: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Tofu");
  });
});
