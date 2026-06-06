import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerEmployeeTools(server: McpServer, clover: CloverClient) {
  server.tool(
    "get_employees",
    "Get all employees on this merchant account",
    {},
    async () => {
      const data = await clover.get<any>(clover.v3("/employees"), { limit: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data.elements, null, 2) }] };
    }
  );

  server.tool(
    "get_shift_summary",
    "Get clock-in/out records for a date range — useful for labor cost analysis",
    {
      startDate: z.string().describe("ISO date string"),
      endDate: z.string().optional().describe("ISO date string. Defaults to today."),
    },
    async ({ startDate, endDate }) => {
      const start = new Date(startDate).getTime();
      const end = endDate ? new Date(endDate).getTime() : Date.now();
      const data = await clover.get<any>(clover.v3("/shifts"), {
        filter: [`inTime>=${start}`, `inTime<=${end}`],
        expand: "employee",
        limit: 200,
      });

      const summary = (data.elements ?? []).map((s: any) => {
        const durationMs = (s.outTime ?? Date.now()) - s.inTime;
        const hours = (durationMs / 1000 / 60 / 60).toFixed(2);
        return {
          employee: `${s.employee?.name ?? s.employee?.id}`,
          clockIn: new Date(s.inTime).toISOString(),
          clockOut: s.outTime ? new Date(s.outTime).toISOString() : "Still clocked in",
          hours,
        };
      });

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    "get_employee_performance",
    "Compare sales performance across employees — average check size, total sales",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
        expand: "employee",
        limit: 500,
      });

      const empMap: Record<string, { name: string; orders: number; totalCents: number }> = {};
      for (const order of orders.elements ?? []) {
        const emp = order.employee;
        if (!emp?.id) continue;
        if (!empMap[emp.id]) empMap[emp.id] = { name: emp.name ?? emp.id, orders: 0, totalCents: 0 };
        empMap[emp.id].orders++;
        empMap[emp.id].totalCents += order.total ?? 0;
      }

      const result = Object.values(empMap)
        .sort((a, b) => b.totalCents - a.totalCents)
        .map(v => ({
          employee: v.name,
          orders: v.orders,
          totalSales: `$${(v.totalCents / 100).toFixed(2)}`,
          avgCheck: v.orders > 0 ? `$${(v.totalCents / v.orders / 100).toFixed(2)}` : "$0.00",
        }));

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
