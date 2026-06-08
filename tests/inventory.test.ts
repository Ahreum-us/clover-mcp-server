import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CloverClient } from "../src/clover-client.js";
import { registerInventoryTools } from "../src/tools/inventory.js";

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
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  getAll: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;

describe("adjust_inventory", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = makeServer();
    registerInventoryTools(server, mockClover);
  });

  test("dry run does not call post", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 10 });
    const result = await server.tools["adjust_inventory"]({ itemId: "item1", delta: -3, confirm: false });
    expect(mockClover.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/DRY RUN/);
    expect(result.content[0].text).toMatch(/10 → 7/);
  });

  test("with confirm=true, adjusts stock by delta", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 10 });
    (mockClover.post as jest.Mock).mockResolvedValue({});
    const result = await server.tools["adjust_inventory"]({
      itemId: "item1", delta: -3, reason: "waste", confirm: true,
    });
    expect(mockClover.post).toHaveBeenCalledWith(
      expect.stringContaining("item1"),
      { quantity: 7 }
    );
    expect(result.content[0].text).toContain("10 → 7");
  });

  test("rejects adjustment that would go negative", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 2 });
    await expect(
      server.tools["adjust_inventory"]({ itemId: "item1", delta: -5, confirm: true })
    ).rejects.toThrow(/negative stock/);
  });

  test("rejects item with no tracked quantity", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({});
    await expect(
      server.tools["adjust_inventory"]({ itemId: "item1", delta: 1, confirm: true })
    ).rejects.toThrow(/no tracked stock quantity/);
  });
});

describe("check_low_stock", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
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
