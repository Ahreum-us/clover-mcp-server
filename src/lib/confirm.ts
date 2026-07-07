/**
 * Single-use confirmation gate for mutating tools (platform standard — ported
 * from Jam/toast in fable batch 4, replacing the previous `confirm: boolean`
 * dry-run flags, which an agent could set on the FIRST call and skip the
 * human entirely).
 *
 * First call (no token): registers a pending action and returns a token +
 * human-readable description of exactly what will happen. Nothing executes.
 * Second call (with token): executes only if the token matches the same
 * scope, the same action, identical operative arguments, is unexpired, and
 * has never been used.
 *
 * `scope` binds the token to the merchant it was issued under. Lucky runs
 * one merchant per process today (merchantId resolved once at boot), so the
 * scope is process-constant — but binding it now means a future
 * multi-merchant deployment inherits cross-tenant replay protection instead
 * of rediscovering the stripe/core F1 bug.
 */
import { randomUUID, createHash } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;

interface Pending {
  scope: string;
  actionKey: string;
  argsHash: string;
  expiresAt: number;
}

const pending = new Map<string, Pending>();

function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex");
}

function sweep(now: number): void {
  for (const [token, p] of pending) {
    if (p.expiresAt <= now) pending.delete(token);
  }
}

export function requestConfirmation(
  scope: string,
  actionKey: string,
  args: unknown,
  description: string
): { content: { type: "text"; text: string }[] } {
  const now = Date.now();
  sweep(now);
  const token = randomUUID();
  pending.set(token, {
    scope,
    actionKey,
    argsHash: hashArgs(args),
    expiresAt: now + TTL_MS,
  });
  return {
    content: [
      {
        type: "text" as const,
        text:
          `CONFIRMATION REQUIRED: ${description}\n` +
          `No changes have been made. To proceed, call this tool again with the exact same ` +
          `arguments plus confirmationToken="${token}". The token is single-use and expires in 5 minutes.`,
      },
    ],
  };
}

export function consumeConfirmation(
  scope: string,
  actionKey: string,
  args: unknown,
  token: string
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  sweep(now);
  const p = pending.get(token);
  if (!p) {
    return { ok: false, reason: "confirmation token not found or expired; call again without confirmationToken to get a new one" };
  }
  pending.delete(token); // single-use regardless of outcome
  if (p.scope !== scope) {
    return { ok: false, reason: "confirmation token was issued for a different merchant" };
  }
  if (p.actionKey !== actionKey) {
    return { ok: false, reason: "confirmation token was issued for a different action" };
  }
  if (p.argsHash !== hashArgs(args)) {
    return { ok: false, reason: "arguments changed since the confirmation was issued; call again without confirmationToken" };
  }
  if (p.expiresAt <= now) {
    return { ok: false, reason: "confirmation token expired; call again without confirmationToken" };
  }
  return { ok: true };
}

/** Test hook: clear all pending confirmations. */
export function _resetConfirmations(): void {
  pending.clear();
}
