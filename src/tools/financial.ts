import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { resolvePeriod } from "../lib/date.js";

export function registerFinancialTools(server: McpServer, clover: CloverClient) {
  tool(
    server,
    "get_tips_report",
    "Tips breakdown by employee for a period. Essential for payroll and IRS reporting. Note: tips are attributed to the ORDER's employee; if a different employee closed the payment, attribution follows the order owner.",
    {
      period: z.enum(["today", "yesterday", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      // F1 fix: bound BOTH ends. "yesterday" previously included today's
      // orders because only the start bound was applied.
      const { startMs, endMs } = resolvePeriod(period);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, `createdTime<=${endMs}`, "paymentState=PAID"],
        expand: "payments,employee",
      });

      const empTips: Record<string, { name: string; tipsCents: number; orders: number }> = {};
      let totalTipsCents = 0;

      for (const order of orders) {
        const empName = (order as any).employee?.name ?? "Unknown";
        const empId = (order as any).employee?.id ?? "unknown";
        if (!empTips[empId]) empTips[empId] = { name: empName, tipsCents: 0, orders: 0 };
        for (const p of (order as any).payments?.elements ?? []) {
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

  tool(
    server,
    "get_tax_report",
    "Taxable sales summary for accounting. Breaks down gross sales, tax collected, and net.",
    {
      period: z.enum(["today", "week", "month", "custom"]).optional().default("month"),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
    async ({ period, startDate, endDate }) => {
      const { startMs, endMs, label } = resolvePeriod(period, startDate, endDate);

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${startMs}`, `createdTime<=${endMs}`, "paymentState=PAID"],
      });

      let grossCents = 0, taxCents = 0, netCents = 0;
      for (const order of orders) {
        grossCents += (order as any).total ?? 0;
        taxCents += (order as any).taxAmount ?? 0;
        netCents += ((order as any).total ?? 0) - ((order as any).taxAmount ?? 0);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            period: label,
            from: new Date(startMs).toDateString(),
            to: new Date(endMs).toDateString(),
            grossSales: `$${(grossCents / 100).toFixed(2)}`,
            taxCollected: `$${(taxCents / 100).toFixed(2)}`,
            netSales: `$${(netCents / 100).toFixed(2)}`,
            totalOrders: orders.length,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_discount_void_report",
    "Track discounts and voided orders. High numbers can indicate over-comping or potential internal theft.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
    },
    async ({ period }) => {
      const { startMs } = resolvePeriod(period);

      const [orders, refunds] = await Promise.all([
        clover.getAll(clover.v3("/orders"), {
          filter: `createdTime>=${startMs}`,
          expand: "discounts,lineItems,employee",
        }),
        clover.getAll(clover.v3("/refunds"), {
          filter: `createdTime>=${startMs}`,
          expand: "payment,employee",
        }),
      ]);

      let totalDiscountCents = 0;
      const discountsByEmployee: Record<string, { name: string; discountCents: number; count: number }> = {};
      const voidedOrders = [];

      for (const order of orders) {
        const discounts = (order as any).discounts?.elements ?? [];
        for (const d of discounts) {
          const amt = d.amount ?? 0;
          totalDiscountCents += amt;
          const empId = (order as any).employee?.id ?? "unknown";
          const empName = (order as any).employee?.name ?? "Unknown";
          if (!discountsByEmployee[empId]) discountsByEmployee[empId] = { name: empName, discountCents: 0, count: 0 };
          discountsByEmployee[empId].discountCents += amt;
          discountsByEmployee[empId].count++;
        }
        if ((order as any).state === "VOIDED") {
          voidedOrders.push({
            id: (order as any).id,
            total: `$${(((order as any).total ?? 0) / 100).toFixed(2)}`,
            employee: (order as any).employee?.name,
          });
        }
      }

      const refundList = refunds.map((r: any) => ({
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

  tool(
    server,
    "get_labor_vs_revenue",
    "Compare labor hours and estimated cost against revenue for a period. Key metric for restaurant profitability.",
    {
      period: z.enum(["today", "week", "month"]).optional().default("week"),
      avgHourlyWage: z.number().positive().max(500).optional().default(15).describe("Average hourly wage in dollars"),
    },
    async ({ period, avgHourlyWage }) => {
      const { startMs } = resolvePeriod(period);

      const [orders, shifts] = await Promise.all([
        clover.getAll(clover.v3("/orders"), {
          filter: [`createdTime>=${startMs}`, "paymentState=PAID"],
        }),
        clover.getAll(clover.v3("/shifts"), {
          filter: `inTime>=${startMs}`,
          expand: "employee",
        }),
      ]);

      const revenueCents = orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0);
      const totalHours = shifts.reduce((s: number, sh: any) => {
        const durationMs = (sh.outTime ?? Date.now()) - sh.inTime;
        return s + durationMs / (1000 * 60 * 60);
      }, 0);
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
            laborCostPercent: typeof laborPct === "string" ? `${laborPct}%` : laborPct,
          }, null, 2),
        }],
      };
    }
  );
}
