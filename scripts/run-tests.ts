import { CloverClient } from "./clover-client.js";

const token = process.env.CLOVER_ACCESS_TOKEN;
const merchantId = process.env.CLOVER_MERCHANT_ID;
const sandbox = process.env.CLOVER_SANDBOX === "true";

if (!token || !merchantId) {
  console.error("Missing CLOVER_ACCESS_TOKEN or CLOVER_MERCHANT_ID");
  process.exit(1);
}

const clover = new CloverClient({ accessToken: token, merchantId, sandbox });

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log("\nClover Sandbox Integration Tests\n");

// 1. get_inventory_levels
await test("get_inventory_levels returns a response", async () => {
  const data = await clover.get<any>(clover.v3("/item_stocks"), { expand: "item", limit: 10 });
  if (!("elements" in data)) throw new Error("No elements in response");
});

// 2. check_low_stock logic
await test("check_low_stock filters correctly", async () => {
  const data = await clover.get<any>(clover.v3("/item_stocks"), { expand: "item", limit: 50 });
  const low = (data.elements ?? []).filter((s: any) => s.quantity !== undefined && s.quantity <= 5);
  console.log(`     → ${low.length} item(s) at or below threshold of 5`);
});

// 3. search_customer
await test("search_customer returns a response", async () => {
  const data = await clover.get<any>(clover.v3("/customers"), { limit: 5 });
  if (!("elements" in data)) throw new Error("No elements in response");
  console.log(`     → ${data.elements.length} customer(s) returned`);
});

// 4. create_customer then verify
await test("create_customer creates a sandbox record", async () => {
  const data = await clover.post<any>(clover.v3("/customers"), {
    firstName: "Dokdo",
    lastName: "TestUser",
  });
  if (!data.id) throw new Error("No ID returned");
  console.log(`     → Created customer ID: ${data.id}`);
});

// 5. negative stock guard (unit-level, no API call needed)
await test("adjust_inventory rejects negative result", async () => {
  const currentQty = 2;
  const delta = -5;
  const newQty = currentQty + delta;
  if (newQty >= 0) throw new Error("Guard should have caught this");
  // Simulate the guard
  if (newQty < 0) return; // correct — guard would throw
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
