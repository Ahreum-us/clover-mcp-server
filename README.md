# clover-mcp-server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [Clover POS](https://www.clover.com) platform, built for restaurant owners who want AI that actually understands their business.

This project was born out of a simple idea: restaurant owners — especially family-run, immigrant-owned restaurants — deserve the same kind of intelligent assistant that enterprise businesses take for granted. Not a chatbot. Not a dashboard. Something that watches your inventory, knows your regulars, and has your back during a dinner rush.

We built this as the data layer for an AI front-of-house system. It exposes Clover's REST API as a clean set of MCP tools that any LLM can call — so instead of logging into a dashboard to check stock levels or pull a sales report, you just ask.

We hope Clover sees this and runs with it.

---

## What It Does

This server wraps the Clover V3 API into **70+ LLM-callable tools** across every major area of restaurant operations:

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

The first pilot is a pho restaurant with two locations. The vision is a system that:

- Sends a morning briefing: overnight sales, what to prep, who's coming in
- Alerts the owner before they run out of something — not after
- Surfaces lapsed regulars and drafts win-back messages automatically
- Answers customer questions 24/7 over WhatsApp without the owner lifting a finger

This MCP server is the engine underneath all of that.

---

## Getting Started

### Prerequisites

- Node.js 20+
- A [Clover developer account](https://www.clover.com/developers) with an OAuth app
- A merchant API token (sandbox or production)

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

# Sandbox (test against Clover's sandbox environment)
CLOVER_ACCESS_TOKEN=your_sandbox_token CLOVER_MERCHANT_ID=your_sandbox_merchant_id CLOVER_SANDBOX=true npm start
```

### Inspect Tools Interactively

```bash
CLOVER_ACCESS_TOKEN=your_token CLOVER_MERCHANT_ID=your_merchant_id CLOVER_SANDBOX=true npm run inspector
```

Opens the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — a browser UI for calling tools and seeing live API responses.

---

## Two-Store Setup

Each Clover location has its own merchant ID and API token. Run one instance per store:

```json
"clover-store1": {
  "command": "node",
  "args": ["/path/to/dist/index.js"],
  "env": {
    "CLOVER_ACCESS_TOKEN": "token_for_store1",
    "CLOVER_MERCHANT_ID": "merchant_id_store1"
  }
},
"clover-store2": {
  "command": "node",
  "args": ["/path/to/dist/index.js"],
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

# Sandbox integration tests (requires sandbox credentials)
CLOVER_ACCESS_TOKEN=your_token CLOVER_MERCHANT_ID=your_merchant_id CLOVER_SANDBOX=true npm run test:sandbox
```

---

## Architecture

- **`src/clover-client.ts`** — Axios-based HTTP client with rate limiting (Bottleneck), automatic retry with exponential backoff (axios-retry), and structured error handling
- **`src/tools/`** — One file per domain, each exporting a `register*Tools` function
- **`src/index.ts`** — Wires everything together into an MCP server over stdio

Rate limiting is per-instance (per merchant), so multi-store deployments stay isolated.

---

## Built By

[Dokdo Solutions](https://github.com/dokdosolutions-us) — AI integration for independent restaurant owners.

---

## License

MIT
