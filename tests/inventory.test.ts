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

const mockClover = {
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;

describe("adjust_inventory", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    server = makeServer();
    registerInventoryTools(server, mockClover);
  });

  test("adjusts stock by delta", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 10 });
    (mockClover.post as jest.Mock).mockResolvedValue({});

    const result = await server.tools["adjust_inventory"]({ itemId: "item1", delta: -3, reason: "waste" });
    expect(mockClover.post).toHaveBeenCalledWith(
      expect.stringContaining("item1"),
      { quantity: 7 }
    );
    expect(result.content[0].text).toContain("10 → 7");
  });

  test("rejects adjustment that would go negative", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ quantity: 2 });

    await expect(
      server.tools["adjust_inventory"]({ itemId: "item1", delta: -5 })
    ).rejects.toThrow("negative stock");
  });

  test("rejects item with no tracked quantity", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({});

    await expect(
      server.tools["adjust_inventory"]({ itemId: "item1", delta: 1 })
    ).rejects.toThrow("no tracked stock quantity");
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
    (mockClover.get as jest.Mock).mockResolvedValue({
      elements: [
        { quantity: 3, item: { id: "a", name: "Galbi" }, unit: "lbs" },
        { quantity: 10, item: { id: "b", name: "Brisket" }, unit: "lbs" },
      ],
    });

    const result = await server.tools["check_low_stock"]({ threshold: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Galbi");
  });

  test("returns all-clear message when nothing is low", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({
      elements: [{ quantity: 20, item: { id: "a", name: "Brisket" } }],
    });

    const result = await server.tools["check_low_stock"]({ threshold: 5 });
    expect(result.content[0].text).toContain("above the threshold");
  });
});
