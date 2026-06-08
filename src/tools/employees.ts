import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { parseDate, resolvePeriod } from "../lib/date.js";

export function registerEmployeeTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_employees",
    "Get all employees on this merchant account.",
    {},
    async () => {
      const elements = await clover.getAll(clover.v3("/employees"));
      return { content: [{ type: "text", text: JSON.stringify(elements, null, 2) }] };
    }
  );

  tool(
    server,
    "get_shift_summary",
    "Get clock-in/out records for a date range — useful for labor cost analysis.",
    {
      startDate: z.string().describe("ISO date string"),
      endDate: z.string().optional().describe("ISO date string. Defaults to now."),
    },
    async ({ startDate, endDate }) => {
      const start = parseDate(startDate, "startDate");
      const end = endDate ? parseDate(endDate, "endDate") : Date.now();
      if (end < start) throw new Error(`endDate is before startDate.`);

      const shifts = await clover.getAll(clover.v3("/shifts"), {
        filter: [`inTime>=${start}`, `inTime<=${end}`],
        expand: "employee",
      });

      const summary = shifts.map((s: any) => {
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

  tool(
    server,
    "get_employee_performance",
    "Compare sales performance across employees — average check size, total sales.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      const { startMs } = resolvePeriod(period);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, "paymentState=PAID"],
        expand: "employee",
      });

      const empMap: Record<string, { name: string; orders: number; totalCents: number }> = {};
      for (const order of orders) {
        const emp = (order as any).employee;
        if (!emp?.id) continue;
        if (!empMap[emp.id]) empMap[emp.id] = { name: emp.name ?? emp.id, orders: 0, totalCents: 0 };
        empMap[emp.id].orders++;
        empMap[emp.id].totalCents += (order as any).total ?? 0;
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
