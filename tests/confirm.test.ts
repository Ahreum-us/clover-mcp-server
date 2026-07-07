import {
  requestConfirmation,
  consumeConfirmation,
  _resetConfirmations,
} from "../src/lib/confirm.js";

function tokenFrom(res: { content: { text: string }[] }): string {
  return /confirmationToken="([^"]+)"/.exec(res.content[0].text)![1];
}

const ARGS = { itemId: "I1", quantity: 5 };

describe("confirmation gate (batch 4)", () => {
  beforeEach(() => _resetConfirmations());

  test("request issues a token and states nothing has changed", () => {
    const res = requestConfirmation("M1", "update_inventory", ARGS, "Update stock.");
    expect(res.content[0].text).toMatch(/CONFIRMATION REQUIRED/);
    expect(res.content[0].text).toMatch(/No changes have been made/);
    expect(tokenFrom(res)).toBeTruthy();
  });

  test("matching scope+action+args consumes exactly once", () => {
    const token = tokenFrom(requestConfirmation("M1", "update_inventory", ARGS, "x"));
    expect(consumeConfirmation("M1", "update_inventory", ARGS, token)).toEqual({ ok: true });
    const second = consumeConfirmation("M1", "update_inventory", ARGS, token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/not found/i);
  });

  test("a token cannot authorize a different merchant (scope binding)", () => {
    const token = tokenFrom(requestConfirmation("pho-vinh", "create_refund", ARGS, "x"));
    const out = consumeConfirmation("dal-pocha", "create_refund", ARGS, token);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/different merchant/i);
  });

  test("a token cannot authorize a different action", () => {
    const token = tokenFrom(requestConfirmation("M1", "update_inventory", ARGS, "x"));
    const out = consumeConfirmation("M1", "create_refund", ARGS, token);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/different action/i);
  });

  test("a token cannot authorize changed arguments ($5 -> $500 class)", () => {
    const token = tokenFrom(requestConfirmation("M1", "create_refund", { amountCents: 500 }, "x"));
    const out = consumeConfirmation("M1", "create_refund", { amountCents: 50000 }, token);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/arguments changed/i);
  });

  test("a mismatched consume burns the token — no second guess", () => {
    const token = tokenFrom(requestConfirmation("M1", "a", ARGS, "x"));
    consumeConfirmation("M1", "b", ARGS, token); // wrong action, burns it
    const retry = consumeConfirmation("M1", "a", ARGS, token);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.reason).toMatch(/not found/i);
  });

  test("tokens expire after the TTL", () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000_000);
      const token = tokenFrom(requestConfirmation("M1", "a", ARGS, "x"));
      jest.setSystemTime(1_000_000 + 5 * 60 * 1000 + 1);
      const out = consumeConfirmation("M1", "a", ARGS, token);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toMatch(/not found or expired|expired/i);
    } finally {
      jest.useRealTimers();
    }
  });
});
