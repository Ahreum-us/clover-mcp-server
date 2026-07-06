import { z } from "zod";

/**
 * Strict validator for Clover object IDs (item, order, payment, customer,
 * category, etc.).
 *
 * Why this exists: every tool that interpolates an ID into a request path —
 * e.g. clover.v3(`/items/${itemId}`) — is a path/query-injection surface if
 * the ID is an unconstrained string. A value like "X/../../<other>" or
 * "X?expand=secret" smuggles extra path or query structure into the Clover
 * request URL.
 *
 * This is NOT a cross-merchant IDOR: the access token scopes every call to a
 * single merchant, and clover.v3() pins the merchantId from env, so a caller
 * cannot reach another merchant's data. But within the merchant it IS a way to
 * reach unintended objects or inject parameters. Constraining IDs to
 * alphanumerics closes that surface.
 *
 * Several tool files previously declared this same regex inline (orders,
 * operations, menu-ops, reservations, retention, smart). Import from here so
 * there is one definition to reason about. Files that still hold a local copy
 * can be migrated to this import as trivial cleanup.
 */
export const CLOVER_ID = z
  .string()
  .regex(/^[A-Z0-9]+$/i, "must be alphanumeric (no slashes, spaces, or symbols)")
  .max(40);
