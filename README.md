# Lucky – Clover MCP Server 🍀✨

**A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [🍀 Clover POS](https://www.clover.com) — giving AI agents direct access to restaurant operations: menu management, orders, inventory, analytics, customer retention, financial reporting, and more.**

Connect any MCP-compatible AI (Claude, GPT-4, Cursor, Continue, and others) to your Clover merchant account and turn natural language into real POS actions — no dashboard, no manual lookups, no custom integration code.

This project was born out of a simple idea: restaurant owners — especially family-run, immigrant-owned restaurants — deserve the same kind of intelligent assistant that enterprise businesses take for granted. Not a chatbot. Not a dashboard. Something that watches your inventory, knows your regulars, and has your back during a dinner rush.

We built this as the data layer for an AI front-of-house system. It exposes the 🍀 Clover V3 REST API as a clean set of MCP tools that any LLM can call — so instead of logging into a dashboard to check stock levels or pull a sales report, you just ask.

We hope 🍀 Clover sees this and runs with it.

---

## What It Does

This server wraps the 🍀 Clover V3 API into **70+ LLM-callable tools** across every major area of restaurant operations:

| Module | Tools |
|---|---|
| **Menu** | Browse items, categories, modifiers, and pricing |
| **Orders** | Query orders, filter by date/status, inspect line items |
| **Customers** | Search, create, and profile customers with lifetime spend |
| **Inventory** | Stock levels, low-stock alerts, adjustments, auto-86 depleted items |
| **Analytics** | Revenue by period, peak hours, best-selling items, category breakdown |
| **Employees** | Shift activity, hours worked, clock-in/out visibility |
| **Financials** | Daily/weekly/monthly summaries, tender breakdowns, tax reporting |
| **Retention** | Lapsed customers, win-back message drafting, birthday outreach, first-time visitors |
| **Operations** | Refund rates, open orders, void detection, table turn analysis |
| **Forecasting** | Week-over-week trends, seasonal patterns, staffing demand signals |
| **Reservations** | Booking management with conflict detection |
| **Smart Queries** | Cross-module insights — happy hour analysis, upsell opportunities, slow day detection |
| **Menu Ops** | Bulk pricing updates, happy hour scheduling, allergen tagging |

---

## Inspiration

The Model Context Protocol, open-sourced by Anthropic, makes it possible to give AI assistants structured, reliable access to external systems. We saw an opportunity to apply this to the restaurant industry — a space full of hardworking owners who are data-rich but time-poor.

Independent restaurants don't have engineering teams. They have POS data they never look at, regulars they forget to reach out to, and inventory that runs out at the worst possible time.

A disproportionate number of independent restaurants in the US are owned by immigrant families — Vietnamese, Korean, Chinese, Mexican, Ethiopian, and countless others — where English may be a second language and the margin for error is razor-thin. These owners work harder than anyone, yet they're the last to benefit from technology that could actually lighten the load.

This project is built with them in mind. An AI that can answer customer questions in any language, surface the right data at the right time, and handle the operational noise — so the people who built something from nothing can focus on what they do best; provide and spend time with their family and loved ones.

This MCP server is the foundation for that.

---

## How This Differs From Other Clover MCP Servers

There are other MCP servers that wrap the 🍀 Clover API — and they're well built. But most of them are designed for **developers**: raw CRUD tools that expose every API endpoint so engineers can build on top of them.

This one is designed for **restaurant owners**.

The difference is in what the tools actually do. Instead of `clover_update_item_stock`, you get `adjust_inventory` — which validates your adjustment, guards against negative stock, and tells you what changed in plain language. Instead of a generic orders list, you get `get_lapsed_customers` — which surfaces your regulars who haven't been back in 30 days and drafts a win-back message for them.

Other servers give an AI the ability to talk to 🍀 Clover. This one gives an AI the ability to help run a restaurant.

That's the Ahreum + 🍀 Clover difference.

---

## Getting Started

### Prerequisites

- Node.js 24+
- A [🍀 Clover developer account](https://www.clover.com/developers) with an OAuth app
- A 🍀 Clover merchant API token (sandbox or production)

### Install

```bash
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
# Fill in your CLOVER_ACCESS_TOKEN and CLOVER_MERCHANT_ID
```

### Run

```bash
# Production
CLOVER_ACCESS_TOKEN=your_token CLOVER_MERCHANT_ID=your_merchant_id npm start

# Sandbox (test against 🍀 Clover's sandbox environment)
CLOVER_ACCESS_TOKEN=your_sandbox_token CLOVER_MERCHANT_ID=your_sandbox_merchant_id CLOVER_SANDBOX=true npm start
```

### Inspect Tools Interactively

```bash
CLOVER_ACCESS_TOKEN=your_token CLOVER_MERCHANT_ID=your_merchant_id CLOVER_SANDBOX=true npm run inspector
```

Opens the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — a browser UI for calling tools and seeing live 🍀 Clover API responses.

---

## Multi-Store Setup

Each 🍀 Clover location has its own merchant ID and API token. Run one instance per store:

```json
"clover-store1": {
  "command": "node",
  "args": ["/absolute/path/to/clover-mcp-server/dist/index.js"],
  "env": {
    "CLOVER_ACCESS_TOKEN": "token_for_store1",
    "CLOVER_MERCHANT_ID": "merchant_id_store1"
  }
},
"clover-store2": {
  "command": "node",
  "args": ["/absolute/path/to/clover-mcp-server/dist/index.js"],
  "env": {
    "CLOVER_ACCESS_TOKEN": "token_for_store2",
    "CLOVER_MERCHANT_ID": "merchant_id_store2"
  }
}
```

Each instance gets its own rate limiter and retry budget — no cross-store interference.

---

## Testing

```bash
# Unit tests (no credentials needed)
npm test

# Sandbox integration tests (requires 🍀 Clover sandbox credentials)
CLOVER_ACCESS_TOKEN=your_token CLOVER_MERCHANT_ID=your_merchant_id CLOVER_SANDBOX=true npm run test:sandbox
```

---

## Architecture

- **`src/clover-client.ts`** — Axios-based HTTP client wrapping the 🍀 Clover V3 API, with rate limiting (Bottleneck), automatic retry with exponential backoff (axios-retry), and structured error handling
- **`src/tools/`** — One file per domain, each exporting a `register*Tools` function
- **`src/index.ts`** — Wires everything together into an MCP server over stdio

Rate limiting is per-instance (per 🍀 Clover merchant), so multi-store deployments stay isolated.

---

## Built By

[Ahreum](https://github.com/Ahreum-us) — AI integration for independent restaurant owners.

---

## License

MIT
