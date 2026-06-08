import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z, ZodRawShape } from "zod";
import { CloverApiError } from "./errors.js";

/**
 * Cross-cutting wrapper around server.tool().
 *
 * Why: every tool handler that calls Clover can throw CloverApiError, plain
 * Error, or non-Error values. Without a wrapper, the SDK turns thrown values
 * into a generic isError response that drops the rich context we worked
 * to preserve in Phase 1.
 *
 * Type design: we accept a Zod raw shape (the object you'd pass to z.object)
 * and derive the handler arg type from it via z.objectOutputType. That lets
 * tool bodies destructure their args with full type inference — no more
 * `unknown` everywhere.
 *
 * Behavior:
 *   1. Calls server.tool(...) under the hood.
 *   2. Wraps the handler in try/catch.
 *   3. CloverApiError → isError with toClientString() (status, code, path).
 *   4. Generic Error  → isError with .message.
 *   5. Non-Error throw → isError with String(value).
 *   6. Logs tool name + elapsed ms to stderr.
 */

type Content = { type: "text"; text: string };
type ToolResult = {
  content: Content[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const log = (...args: unknown[]) =>
  console.error(`[${new Date().toISOString()}] [clover-mcp][tool]`, ...args);

export function tool<Shape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: Shape,
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<ToolResult>
): void {
  server.tool(name, description, schema as any, (async (args: any) => {
    const start = Date.now();
    try {
      const result = await handler(args);
      log(`${name} ok (${Date.now() - start}ms)`);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      let text: string;
      if (err instanceof CloverApiError) {
        text = err.toClientString();
      } else if (err instanceof Error) {
        text = err.message || err.name || "unknown error";
      } else {
        text = `non-error thrown: ${String(err)}`;
      }
      log(`${name} failed (${elapsed}ms): ${text}`);
      return {
        isError: true,
        content: [{ type: "text" as const, text }],
      };
    }
  }) as any);
}
