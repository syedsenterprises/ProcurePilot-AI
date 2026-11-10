import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseExactDecimalString, runPreflightInspection } from '../../src/db/legacy-preflight';
import { generateLegacyOrderNumber } from '../../src/db/legacy-migration';

export async function runLegacyPreflightTests() {
  console.log('--- Running Legacy Preflight & Exact Decimal Parser Tests ---');

  // Test 1: Exact Decimal String Parsing
  console.log('Test 1: Exact decimal string parsing without floating-point errors');
  assert.strictEqual(parseExactDecimalString(1401.84, 'testTotal'), '1401.84');
  assert.strictEqual(parseExactDecimalString('294.54', 'testTotal'), '294.54');
  assert.strictEqual(parseExactDecimalString(0, 'testSubtotal'), '0.00');
  assert.strictEqual(parseExactDecimalString('1295', 'testItemPrice'), '1295.00');
  console.log('  ✓ Standard monetary numbers parse losslessly to 2 decimal places');

  // Test 2: Excess precision rejection
  console.log('Test 2: Excess precision (> 2 decimal places) rejection');
  assert.throws(() => {
    parseExactDecimalString(12.345, 'excessField');
  }, /Excess monetary precision/);

  assert.throws(() => {
    parseExactDecimalString('99.999', 'excessFieldStr');
  }, /Malformed monetary string format/);
  console.log('  ✓ Excess decimal precision strictly rejected');

  // Test 3: Preflight inspection using reproducible public synthetic fixtures
  console.log('Test 3: Preflight inspection of synthetic legacy fixtures');
  const fixtureBase = path.resolve(__dirname, '..', 'fixtures', 'legacy-preflight');
  const fixtureOrdersDir = path.join(fixtureBase, 'orders');
  const fixtureApprovalsDir = path.join(fixtureBase, 'approvals');

  assert.ok(fs.existsSync(fixtureOrdersDir), `Fixture orders dir must exist at ${fixtureOrdersDir}`);
  assert.ok(fs.existsSync(fixtureApprovalsDir), `Fixture approvals dir must exist at ${fixtureApprovalsDir}`);

  // Stage synthetic fixtures into an isolated temporary directory
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procurepilot-preflight-fixture-'));
  const targetOrdersDir = path.join(isolatedDir, '.data', 'orders');
  const targetApprovalsDir = path.join(isolatedDir, '.data', 'approvals');
  fs.mkdirSync(targetOrdersDir, { recursive: true });
  fs.mkdirSync(targetApprovalsDir, { recursive: true });

  try {
    // Copy fixtures
    for (const f of fs.readdirSync(fixtureOrdersDir)) {
      fs.copyFileSync(path.join(fixtureOrdersDir, f), path.join(targetOrdersDir, f));
    }
    for (const f of fs.readdirSync(fixtureApprovalsDir)) {
      fs.copyFileSync(path.join(fixtureApprovalsDir, f), path.join(targetApprovalsDir, f));
    }

    // Execute preflight inspection against isolated synthetic environment
    const { manifest, quarantine, simulatedManifest } = runPreflightInspection(isolatedDir);

    // Verify order scanning and quarantine counts
    assert.strictEqual(manifest.totalOrdersScanned, 4, 'Expected exactly 4 order files scanned (3 valid + 1 quarantined)');
    assert.strictEqual(manifest.validOrdersCount, 3, 'Expected 3 valid order records');
    assert.strictEqual(manifest.quarantinedOrdersCount, 1, 'Expected exactly 1 quarantined order');
    assert.strictEqual(manifest.validGenuineOrdersCount, 2, 'Expected 2 genuine provider orders');
    assert.strictEqual(manifest.validSimulationOrdersCount, 1, 'Expected 1 simulated test order');
    assert.strictEqual(manifest.aggregateGenuineTotal, '589.08', 'Sum of 2 genuine orders ($294.54 * 2) must equal $589.08');
    assert.strictEqual(manifest.aggregateAuthorizedTotal, '1990.92', 'Aggregate total must equal sum of all valid orders ($589.08 + $1401.84)');

    // Verify genuine order mapped statuses
    const orderGenuine1 = manifest.orders.find((o) => o.orderId === 'ORD-SYNTH-GENUINE-01');
    const orderGenuine2 = manifest.orders.find((o) => o.orderId === 'ORD-SYNTH-GENUINE-02');
    assert.ok(orderGenuine1, 'ORD-SYNTH-GENUINE-01 must be present');
    assert.ok(orderGenuine2, 'ORD-SYNTH-GENUINE-02 must be present');
    assert.strictEqual(
      orderGenuine1.dbStatus,
      'PENDING_PAYMENT_APPROVAL',
      'CREATED genuine order must map to PENDING_PAYMENT_APPROVAL'
    );
    assert.strictEqual(orderGenuine2.dbStatus, 'COMPLETED', 'CAPTURED genuine order must map to COMPLETED');
    console.log('  ✓ Genuine orders verified: status mapping to PENDING_PAYMENT_APPROVAL and COMPLETED');

    // Verify approvals scanning
    assert.strictEqual(manifest.totalApprovalsScanned, 3, 'Expected 3 approval files scanned');
    assert.strictEqual(manifest.validApprovalsCount, 3, 'Expected 3 valid approval records');
    assert.strictEqual(manifest.quarantinedApprovalsCount, 0, 'Expected 0 quarantined approvals');
    console.log('  ✓ Approvals scanned and validated (3 valid, 0 quarantined)');

    // Verify quarantine classification (orphaned approval reference)
    const orphan = quarantine.find((q) => q.fileName === 'TEST-ORDER-MUTATION-CHECK-01.json');
    assert.ok(orphan, 'TEST-ORDER-MUTATION-CHECK-01.json must be in quarantine');
    assert.strictEqual(orphan?.category, 'ORPHANED_APPROVAL_REFERENCE');
    assert.strictEqual(orphan?.authorizedTotal, '500.00');
    console.log('  ✓ Quarantined orphaned order (TEST-ORDER-MUTATION-CHECK-01, $500.00) verified');

    // Verify capture origin separation
    assert.strictEqual(manifest.paypalRealCapturesCount, 1, 'Expected 1 real PayPal capture');
    assert.strictEqual(manifest.localSyntheticCapturesCount, 1, 'Expected 1 synthetic local test stub');
    assert.strictEqual(simulatedManifest.length, 1, 'Simulated manifest must isolate synthetic test captures');
    console.log('  ✓ Capture origin separation: 1 real PayPal vs 1 synthetic local test stub');

    // Test 4: Legacy Order Number Generation & Uniqueness
    console.log('Test 4: Legacy order number generation, length, and uniqueness constraints');
    const seenOrderNumbers = new Set<string>();
    for (const order of manifest.orders) {
      const orderNum = generateLegacyOrderNumber(order.orderId);
      assert.ok(orderNum.length <= 32, `Order number ${orderNum} exceeds VARCHAR(32) limit (length: ${orderNum.length})`);
      assert.ok(!seenOrderNumbers.has(orderNum), `Duplicate order number generated: ${orderNum}`);
      seenOrderNumbers.add(orderNum);
    }
    console.log(`  ✓ All ${seenOrderNumbers.size} legacy order numbers fit within VARCHAR(32) and are 100% unique`);
  } finally {
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }

  // Test 5 (Conditional / Historical Baseline):
  // Private historical .data records are confidential developer artifacts excluded from public releases.
  // In the standard public test suite, full legacy logic is verified against synthetic fixtures above.
  // When the historical baseline records are present (e.g. in local development or migration rehearsals),
  // this test verifies exact inventory constraints.
  const historicalOrdersDir = path.resolve(process.cwd(), '.data', 'orders');
  const hasHistoricalBaseline =
    fs.existsSync(historicalOrdersDir) &&
    fs.readdirSync(historicalOrdersDir).filter((f) => f.endsWith('.json')).length >= 67;

  if (process.env.TEST_HISTORICAL_BASELINE === 'true' || process.env.TEST_HISTORICAL_BASELINE === '1') {
    assert.ok(
      hasHistoricalBaseline,
      'TEST_HISTORICAL_BASELINE requested, but private historical records are not present in .data/orders. Prerequisite: Historical records required.'
    );
  }

  if (hasHistoricalBaseline) {
    console.log('Test 5: Preflight inspection of local developer historical .data baseline');
    const { manifest, quarantine, simulatedManifest } = runPreflightInspection();

    assert.ok(manifest.totalOrdersScanned >= 67, `Expected at least 67 order files scanned, got ${manifest.totalOrdersScanned}`);
    assert.ok(manifest.validOrdersCount >= 66, `Expected at least 66 valid orders, got ${manifest.validOrdersCount}`);
    assert.ok(manifest.quarantinedOrdersCount >= 1, `Expected at least 1 quarantined order, got ${manifest.quarantinedOrdersCount}`);
    assert.strictEqual(manifest.validGenuineOrdersCount, 2, 'Must isolate exactly 2 genuine PayPal Orders v2 records');
    assert.strictEqual(manifest.aggregateGenuineTotal, '589.08', 'Sum of 2 genuine orders ($294.54 * 2) must equal $589.08');

    const order71F = manifest.orders.find((o) => o.orderId === '71F126573R549662J');
    const order8HX = manifest.orders.find((o) => o.orderId === '8HX63874LW066860W');
    assert.ok(order71F, 'Order 71F126573R549662J must be present');
    assert.ok(order8HX, 'Order 8HX63874LW066860W must be present');
    assert.strictEqual(order71F.dbStatus, 'PENDING_PAYMENT_APPROVAL', '71F126573R549662J must map to PENDING_PAYMENT_APPROVAL');
    assert.strictEqual(order8HX.dbStatus, 'COMPLETED', '8HX63874LW066860W must map to COMPLETED');

    assert.ok(manifest.totalApprovalsScanned >= 186, `Expected at least 186 approval files scanned, got ${manifest.totalApprovalsScanned}`);
    assert.ok(manifest.validApprovalsCount >= 186, `Expected at least 186 valid approvals, got ${manifest.validApprovalsCount}`);
    assert.strictEqual(manifest.quarantinedApprovalsCount, 0, 'Expected 0 quarantined approvals');

    const orphan = quarantine.find((q) => q.fileName === 'TEST-ORDER-MUTATION-CHECK-01.json');
    assert.ok(orphan, 'TEST-ORDER-MUTATION-CHECK-01.json must be in quarantine');
    assert.strictEqual(orphan?.category, 'ORPHANED_APPROVAL_REFERENCE');
    assert.strictEqual(orphan?.authorizedTotal, '500.00');

    assert.strictEqual(manifest.paypalRealCapturesCount, 1, 'Expected exactly 1 real PayPal capture');
    assert.ok(manifest.localSyntheticCapturesCount >= 64, 'Expected at least 64 synthetic local sandbox captures');
    assert.ok(simulatedManifest.length >= 64, 'Simulated manifest must isolate synthetic test captures');
    console.log('  ✓ Local developer historical .data baseline validated successfully');
  } else {
    console.log('Test 5: [PREFLIGHT] Public clone mode: private historical .data/ records not present (full validation verified via public synthetic fixtures)');
  }
}

if (require.main === module) {
  runLegacyPreflightTests().catch((err) => {
    console.error('Legacy preflight tests failed:', err);
    process.exit(1);
  });
}
