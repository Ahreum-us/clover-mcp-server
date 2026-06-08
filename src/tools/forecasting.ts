import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CloverClient } from "../clover-client.js";
import { tool } from "../tool-wrapper.js";
import { parseDate } from "../lib/date.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function registerForecastingTools(server: McpServer, clover: CloverClient) {

  tool(
    server,
    "predict_busy_periods",
    "Analyze 90 days of historical data to predict busy days and peak hours for the coming week.",
    {},
    async () => {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

      // Migrated to getAll — 90 days of orders at a busy spot can easily
      // exceed 1000 records and the old get(limit:1000) silently truncated.
      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${ninetyDaysAgo}`, "paymentState=PAID"],
      });

      const byDow: Record<number, { orders: number; revenueCents: number; weeks: Set<string> }> = {};
      const byHour: Record<number, { orders: number; count: number }> = {};
      for (let i = 0; i < 7; i++) byDow[i] = { orders: 0, revenueCents: 0, weeks: new Set() };
      for (let i = 0; i < 24; i++) byHour[i] = { orders: 0, count: 0 };

      for (const order of orders) {
        const d = new Date((order as any).createdTime);
        const dow = d.getDay();
        const hour = d.getHours();
        const weekKey = `${Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000))}`;

        byDow[dow].orders++;
        byDow[dow].revenueCents += (order as any).total ?? 0;
        byDow[dow].weeks.add(weekKey);
        byHour[hour].orders++;
        byHour[hour].count++;
      }

      const dowAverages = Object.entries(byDow).map(([day, v]) => {
        const weeks = v.weeks.size || 1;
        return {
          day: DAY_NAMES[parseInt(day)],
          avgOrders: Math.round(v.orders / weeks),
          avgRevenue: `$${(v.revenueCents / weeks / 100).toFixed(2)}`,
          busyScore: v.orders,
        };
      }).sort((a, b) => b.busyScore - a.busyScore);

      const peakHours = Object.entries(byHour)
        .filter(([, v]) => v.orders > 0)
        .map(([hour, v]) => ({
          hour: `${hour}:00`,
          avgOrders: (v.orders / (v.count || 1)).toFixed(1),
          totalOrders: v.orders,
        }))
        .sort((a, b) => b.totalOrders - a.totalOrders)
        .slice(0, 6);

      const predictions = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const dow = d.getDay();
        const avg = byDow[dow];
        const weeks = avg.weeks.size || 1;
        predictions.push({
          date: d.toDateString(),
          day: DAY_NAMES[dow],
          predictedOrders: Math.round(avg.orders / weeks),
          predictedRevenue: `$${(avg.revenueCents / weeks / 100).toFixed(2)}`,
          busyness: avg.orders / weeks > 40 ? "🔴 Very busy" : avg.orders / weeks > 20 ? "🟡 Moderate" : "🟢 Quiet",
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            basedOn: "Last 90 days",
            busiestDays: dowAverages.slice(0, 3).map(d => d.day),
            quietestDays: dowAverages.slice(-2).map(d => d.day),
            peakHours,
            next7Days: predictions,
          }, null, 2),
        }],
      };
    }
  );

  tool(
    server,
    "get_staffing_recommendation",
    "Based on predicted order volume, recommend how many staff members to schedule.",
    {
      date: z.string().describe("ISO date string for the shift you're staffing"),
      ordersPerStaffPerHour: z.number().positive().max(100).optional().default(8)
        .describe("How many orders one staff member can handle per hour"),
    },
    async ({ date, ordersPerStaffPerHour }) => {
      const targetMs = parseDate(date, "date");
      const target = new Date(targetMs);
      const dow = target.getDay();
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

      const orders = await clover.getAll(clover.v3("/orders"), {
        filter: [`createdTime>=${ninetyDaysAgo}`, "paymentState=PAID"],
      });

      const weeklyOrders: Record<string, Record<number, number>> = {};
      for (const order of orders) {
        const d = new Date((order as any).createdTime);
        const dayOfWeek = d.getDay();
        const hour = d.getHours();
        const weekKey = `${d.getFullYear()}-${Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000))}`;
        if (!weeklyOrders[weekKey]) weeklyOrders[weekKey] = {};
        const key = dayOfWeek * 24 + hour;
        weeklyOrders[weekKey][key] = (weeklyOrders[weekKey][key] ?? 0) + 1;
      }

      const weekCount = Object.keys(weeklyOrders).length || 1;
      const hourlyAvg: Record<number, number> = {};
      for (const [, dayHours] of Object.entries(weeklyOrders)) {
        for (const [key, count] of Object.entries(dayHours)) {
          hourlyAvg[parseInt(key)] = (hourlyAvg[parseInt(key)] ?? 0) + count;
        }
      }

      const schedule = [];
      for (let h = 6; h <= 22; h++) {
        const key = dow * 24 + h;
        const avgOrders = (hourlyAvg[key] ?? 0) / weekCount;
        const staffNeeded = Math.max(1, Math.ceil(avgOrders / ordersPerStaffPerHour));
        if (avgOrders > 0) {
          schedule.push({
            hour: `${h}:00`,
            predictedOrders: Math.round(avgOrders),
            staffRecommended: staffNeeded,
            note: staffNeeded >= 3 ? "⚠️ Rush period" : "",
          });
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            date: target.toDateString(),
            day: DAY_NAMES[dow],
            assumedOrdersPerStaffPerHour: ordersPerStaffPerHour,
            hourlySchedule: schedule,
          }, null, 2),
        }],
      };
    }
  );
}
