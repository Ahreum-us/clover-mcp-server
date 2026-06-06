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

const accessToken = process.env.CLOVER_ACCESS_TOKEN;
const merchantId = process.env.CLOVER_MERCHANT_ID;
const sandbox = process.env.CLOVER_SANDBOX === "true";

if (!accessToken || !merchantId) {
  console.error("Missing CLOVER_ACCESS_TOKEN or CLOVER_MERCHANT_ID");
  process.exit(1);
}

const clover = new CloverClient({ accessToken, merchantId, sandbox });

const server = new McpServer({
  name: "clover-mcp-server",
  version: "0.1.0",
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
await server.connect(transport);
