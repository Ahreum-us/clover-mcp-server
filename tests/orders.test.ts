import { CloverClient } from "../src/clover-client.js";
import { registerOrderTools } from "../src/tools/orders.js";
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

const mockClover = {
  merchantId: "TEST",
  v3: (path: string) => `/v3/merchants/TEST${path}`,
  get: jest.fn(),
  getAll: jest.fn(),
  post: jest.fn(),
} as unknown as CloverClient;

async function getToken(fn: Function, args: Record<string, unknown>): Promise<string> {
  const first = await fn(args);
  const m = /confirmationToken="([^"]+)"/.exec(first.content[0].text);
  if (!m) throw new Error("no confirmation token in: " + first.content[0].text);
  return m[1];
}

describe("create_refund (batch 4: pre-flight duplicate guard + token gate)", () => {
  let server: ReturnType<typeof makeServer>;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetConfirmations();
    server = makeServer();
    registerOrderTools(server, mockClover);
  });

  test("blocks a partial refund when the payment already has one for the same amount", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({
      refunds: { elements: [{ id: "R1", amount: 500 }] },
    });
    const result = await server.tools["create_refund"]({ paymentId: "PAY1", amountCents: 500 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refund BLOCKED/);
    expect(result.content[0].text).toMatch(/R1/);
    expect(mockClover.post).not.toHaveBeenCalled();
  });

  test("blocks a full refund when ANY prior refund exists (conservative)", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({
      refunds: { elements: [{ id: "R1", amount: 123 }] },
    });
    const result = await server.tools["create_refund"]({ paymentId: "PAY1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Refund BLOCKED/);
    expect(mockClover.post).not.toHaveBeenCalled();
  });

  test("allows a partial refund for a different amount than a prior partial", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({
      refunds: { elements: [{ id: "R1", amount: 123 }] },
    });
    (mockClover.post as jest.Mock).mockResolvedValue({ id: "R2", amount: 500 });
    const token = await getToken(server.tools["create_refund"], { paymentId: "PAY1", amountCents: 500 });
    const result = await server.tools["create_refund"]({
      paymentId: "PAY1", amountCents: 500, confirmationToken: token,
    });
    expect(result.isError).toBeUndefined();
    expect(mockClover.post).toHaveBeenCalledTimes(1);
  });

  test("clean payment: first call issues token without posting; confirm executes with retries disabled", async () => {
    (mockClover.get as jest.Mock).mockResolvedValue({ refunds: { elements: [] } });
    (mockClover.post as jest.Mock).mockResolvedValue({ id: "R9" });

    const first = await server.tools["create_refund"]({ paymentId: "PAY1", amountCents: 250, reason: "cold food" });
    expect(first.content[0].text).toMatch(/CONFIRMATION REQUIRED/);
    expect(first.content[0].text).toMatch(/\$2\.50/);
    expect(mockClover.post).not.toHaveBeenCalled();

    const token = /confirmationToken="([^"]+)"/.exec(first.content[0].text)![1];
    const result = await server.tools["create_refund"]({
      paymentId: "PAY1", amountCents: 250, reason: "cold food", confirmationToken: token,
    });
    expect(result.content[0].text).toMatch(/R9/);
    const [, body, config] = (mockClover.post as jest.Mock).mock.calls[0];
    expect(body).toMatchObject({ payment: { id: "PAY1" }, amount: 250, reason: "cold food" });
    expect(config).toMatchObject({ "axios-retry": { retries: 0 } });
  });

  test("a refund landing BETWEEN request and confirm is caught on the confirm call", async () => {
    (mockClover.get as jest.Mock).mockResolvedValueOnce({ refunds: { elements: [] } });
    const token = await getToken(server.tools["create_refund"], { paymentId: "PAY1", amountCents: 500 });
    (mockClover.get as jest.Mock).mockResolvedValueOnce({
      refunds: { elements: [{ id: "R_RACE", amount: 500 }] },
    });
    const result = await server.tools["create_refund"]({
      paymentId: "PAY1", amountCents: 500, confirmationToken: token,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/R_RACE/);
    expect(mockClover.post).not.toHaveBeenCalled();
  });
});
