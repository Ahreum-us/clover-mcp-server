#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CloverClient } from "./clover-client.js";
import { registerMenuTools } from "./tools/menu.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerSmartTools } from "./tools/smart.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerFinancialTools } from "./tools/financial.js";
import { registerRetentionTools } from "./tools/retention.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerForecastingTools } from "./tools/forecasting.js";
import { registerReservationTools } from "./tools/reservations.js";
import { registerMenuOpsTools } from "./tools/menu-ops.js";

const SERVER_NAME = "clover-mcp";
const SERVER_VERSION = "1.0.4";
const SHUTDOWN_TIMEOUT_MS = 5_000;

const log = {
  info: (...args: unknown[]) =>
    console.error(`[${new Date().toISOString()}] [${SERVER_NAME}]`, ...args),
  error: (...args: unknown[]) =>
    console.error(`[${new Date().toISOString()}] [${SERVER_NAME}][error]`, ...args),
};

function formatThrown(value: unknown): unknown {
  if (value instanceof Error) return value;
  if (value === undefined) return { thrown: "undefined" };
  if (value === null) return { thrown: "null" };
  return { thrown: value };
}

const accessToken = process.env.CLOVER_ACCESS_TOKEN;
const merchantId = process.env.CLOVER_MERCHANT_ID;
const sandbox = process.env.CLOVER_SANDBOX === "true";

if (!accessToken || !merchantId) {
  log.error(
    "Missing required environment variables. Need CLOVER_ACCESS_TOKEN and CLOVER_MERCHANT_ID."
  );
  process.exit(1);
}

const clover = new CloverClient({ accessToken, merchantId, sandbox });

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

registerMenuTools(server, clover);
registerOrderTools(server, clover);
registerCustomerTools(server, clover);
registerInventoryTools(server, clover);
registerAnalyticsTools(server, clover);
registerSmartTools(server, clover);
registerEmployeeTools(server, clover);
registerFinancialTools(server, clover);
registerRetentionTools(server, clover);
registerOperationsTools(server, clover);
registerForecastingTools(server, clover);
registerReservationTools(server, clover);
registerMenuOpsTools(server, clover);

const transport = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down: ${reason}`);

  const forceExit = setTimeout(() => {
    log.error(`shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await server.close();
  } catch (err) {
    log.error("error during server.close():", formatThrown(err));
    exitCode = exitCode || 1;
  }
  clearTimeout(forceExit);
  process.exit(exitCode);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void shutdown(`received ${sig}`);
  });
}

process.on("uncaughtException", (err) => {
  log.error("uncaughtException:", formatThrown(err));
  void shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection:", formatThrown(reason));
  void shutdown("unhandledRejection", 1);
});

try {
  await server.connect(transport);
  log.info(
    `ready on stdio. sandbox=${sandbox} merchant=${merchantId} version=${SERVER_VERSION}`
  );
} catch (err) {
  log.error("failed to connect transport:", formatThrown(err));
  process.exit(1);
}
