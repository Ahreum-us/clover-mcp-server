import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";

export function registerFinancialTools(server: McpServer, clover: CloverClient) {

  server.tool(
    "get_tips_report",
    "Tips breakdown by employee for a period. Essential for payroll and IRS reporting.",
    {
      period: z.enum(["today", "yesterday", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "yesterday") { const y = new Date(); y.setDate(y.getDate() - 1); start = new Date(y.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
        expand: "payments,employee",
        limit: 500,
      });

      const empTips: Record<string, { name: string; tipsCents: number; orders: number }> = {};
      let totalTipsCents = 0;

      for (const order of orders.elements ?? []) {
        const empName = order.employee?.name ?? "Unknown";
        const empId = order.employee?.id ?? "unknown";
        if (!empTips[empId]) empTips[empId] = { name: empName, tipsCents: 0, orders: 0 };

        for (const p of order.payments?.elements ?? []) {
          const tip = p.tipAmount ?? 0;
          empTips[empId].tipsCents += tip;
          totalTipsCents += tip;
        }
        empTips[empId].orders++;
      }

      const breakdown = Object.values(empTips)
        .sort((a, b) => b.tipsCents - a.tipsCents)
        .map(e => ({
          employee: e.name,
          orders: e.orders,
          totalTips: `$${(e.tipsCents / 100).toFixed(2)}`,
          avgTipPerOrder: e.orders > 0 ? `$${(e.tipsCents / e.orders / 100).toFixed(2)}` : "$0.00",
        }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            totalTips: `$${(totalTipsCents / 100).toFixed(2)}`,
            byEmployee: breakdown,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_tax_report",
    "Taxable sales summary for accounting. Breaks down gross sales, tax collected, and net by tax rate.",
    {
      period: z.enum(["today", "week", "month", "custom"]).optional().default("month"),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
    async ({ period, startDate, endDate }) => {
      if (period === "custom" && (!startDate || !endDate)) {
        return { isError: true, content: [{ type: "text" as const, text: "startDate and endDate are required when period=custom" }] };
      }

      const now = new Date();
      let start: Date, end: Date = new Date();
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else if (period === "month") { start = new Date(now.getFullYear(), now.getMonth(), 1); }
      else { start = new Date(startDate!); end = new Date(endDate!); }

      const orders = await clover.get<any>(clover.v3("/orders"), {
        filter: [`createdTime>=${start.getTime()}`, `createdTime<=${end.getTime()}`, "paymentState=PAID"],
        expand: "lineItems",
        limit: 500,
      });

      let grossCents = 0, taxCents = 0, netCents = 0;
      for (const order of orders.elements ?? []) {
        grossCents += order.total ?? 0;
        taxCents += order.taxAmount ?? 0;
        netCents += (order.total ?? 0) - (order.taxAmount ?? 0);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            from: start.toDateString(),
            to: end.toDateString(),
            grossSales: `$${(grossCents / 100).toFixed(2)}`,
            taxCollected: `$${(taxCents / 100).toFixed(2)}`,
            netSales: `$${(netCents / 100).toFixed(2)}`,
            totalOrders: orders.elements?.length ?? 0,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_discount_void_report",
    "Track discounts and voided orders. High numbers can indicate over-comping or potential internal theft.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const [orders, refunds] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: `createdTime>=${start.getTime()}`,
          expand: "discounts,lineItems,employee",
          limit: 500,
        }),
        clover.get<any>(clover.v3("/refunds"), {
          filter: `createdTime>=${start.getTime()}`,
          expand: "payment,employee",
          limit: 200,
        }),
      ]);

      let totalDiscountCents = 0;
      const discountsByEmployee: Record<string, { name: string; discountCents: number; count: number }> = {};
      const voidedOrders = [];

      for (const order of orders.elements ?? []) {
        const discounts = order.discounts?.elements ?? [];
        for (const d of discounts) {
          const amt = d.amount ?? 0;
          totalDiscountCents += amt;
          const empId = order.employee?.id ?? "unknown";
          const empName = order.employee?.name ?? "Unknown";
          if (!discountsByEmployee[empId]) discountsByEmployee[empId] = { name: empName, discountCents: 0, count: 0 };
          discountsByEmployee[empId].discountCents += amt;
          discountsByEmployee[empId].count++;
        }
        if (order.state === "VOIDED") {
          voidedOrders.push({ id: order.id, total: `$${((order.total ?? 0) / 100).toFixed(2)}`, employee: order.employee?.name });
        }
      }

      const refundList = (refunds.elements ?? []).map((r: any) => ({
        amount: `$${((r.amount ?? 0) / 100).toFixed(2)}`,
        employee: r.employee?.name ?? "Unknown",
        reason: r.reason ?? "No reason given",
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            totalDiscounts: `$${(totalDiscountCents / 100).toFixed(2)}`,
            discountsByEmployee: Object.values(discountsByEmployee).sort((a, b) => b.discountCents - a.discountCents),
            voidedOrders: voidedOrders.length,
            voidDetails: voidedOrders,
            refunds: refundList.length,
            refundDetails: refundList,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_labor_vs_revenue",
    "Compare labor hours and estimated cost against revenue for a period. Key metric for restaurant profitability.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      avgHourlyWage: z.number().optional().default(15).describe("Average hourly wage in dollars for labor cost estimate"),
    },
    async ({ period, avgHourlyWage }) => {
      const now = new Date();
      let start: Date;
      if (period === "today") { start = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { start = new Date(now); start.setDate(now.getDate() - 7); }
      else { start = new Date(now.getFullYear(), now.getMonth(), 1); }

      const [orders, shifts] = await Promise.all([
        clover.get<any>(clover.v3("/orders"), {
          filter: [`createdTime>=${start.getTime()}`, "paymentState=PAID"],
          limit: 500,
        }),
        clover.get<any>(clover.v3("/shifts"), {
          filter: `inTime>=${start.getTime()}`,
          expand: "employee",
          limit: 200,
        }),
      ]);

      const revenueCents = (orders.elements ?? []).reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      let totalHours = 0;
      for (const s of shifts.elements ?? []) {
        const ms = (s.outTime ?? Date.now()) - s.inTime;
        totalHours += ms / 1000 / 60 / 60;
      }

      const laborCostCents = Math.round(totalHours * avgHourlyWage * 100);
      const laborPct = revenueCents > 0 ? ((laborCostCents / revenueCents) * 100).toFixed(1) : "N/A";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period,
            revenue: `$${(revenueCents / 100).toFixed(2)}`,
            laborHours: totalHours.toFixed(1),
            estimatedLaborCost: `$${(laborCostCents / 100).toFixed(2)}`,
            laborCostPercentage: `${laborPct}%`,
            benchmark: "Healthy restaurant labor cost: 25-35% of revenue",
          }, null, 2),
        }],
      };
    }
  );
}
