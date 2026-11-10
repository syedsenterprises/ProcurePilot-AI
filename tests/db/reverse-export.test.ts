if (!process.env.DATABASE_URL) {
  process.env.PGUSER = process.env.PGUSER || 'postgres';
  process.env.PGPASSWORD = process.env.PGPASSWORD || 'postgres';
  process.env.PGDATABASE = process.env.PGDATABASE || 'procurepilot';
}

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { Pool } from 'pg';
import { db } from '@/db/pool';
import { generateLegacyOrderNumber } from '@/db/legacy-migration';
import { parseExactDecimalToCents } from '@/db/legacy-preflight';
import {
  ReverseExporter,
  validateExportDestination,
  formatCentsToExactDecimalString,
  convertExactDecimalToLegacyNumber,
  formatCentsToLegacyNumber,
} from '@/db/export-pg-to-flatfiles';
import { validateExportStaging } from '@/db/validate-export';
import { verifySemanticRoundtrip } from '@/db/semantic-roundtrip-verifier';

/**
 * Creates a mock Pool for deterministic adversarial unit testing without mutating the database.
 */
function createMockPool(mockQuery: (sql: string, params?: any[]) => Promise<any>): Pool {
  const mockClient = {
    query: async (sql: string, params?: any[]) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (sql.includes('current_database()')) {
        return { rows: [{ dbname: 'procurepilot' }] };
      }
      return mockQuery(sql, params);
    },
    release: () => {},
  };
  return {
    connect: async () => mockClient as any,
  } as unknown as Pool;
}

export async function runReverseExportTests(): Promise<void> {
  console.log('\n================================================================');
  console.log('ProcurePilot AI — Reverse-Export & Rollback Recovery Tests');
  console.log('================================================================');

  const baseStagingDir = path.resolve(process.cwd(), 'scratch/rollback-export-staging');
  fs.mkdirSync(baseStagingDir, { recursive: true });

  const genuineOrderId = '8HX63874LW066860W';
  const sampleTicketId = 'appr_tk_1794007620021_1567915a512c835e';

  // Base standard dataset for mock testing
  const createBaseMockData = () => ({
    orders: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        external_order_id: genuineOrderId,
        order_number: generateLegacyOrderNumber(genuineOrderId),
        ticket_id: sampleTicketId,
        status: 'COMPLETED',
        authorized_total: '294.54',
        authorized_subtotal: '249.00',
        authorized_tax: '20.54',
        authorized_shipping: '25.00',
        currency: 'USD',
        approver_name: 'Alex Mercer',
        approver_department: 'Engineering DevOps',
        created_at: new Date('2026-11-06T23:27:02.745Z'),
        updated_at: new Date('2026-11-06T23:27:02.745Z'),
        is_simulated: false,
        source_origin: 'LEGACY_JSON_IMPORT',
      },
    ],
    orderItems: [
      {
        id: 1,
        order_id: '00000000-0000-0000-0000-000000000001',
        product_id: 'prod-logi-mx-bundle',
        product_name: 'Logitech MX Master 3S Mouse + MX Mechanical Keyboard Bundle',
        unit_price: '249.00',
        quantity: 1,
        line_total: '249.00',
      },
    ],
    tickets: [
      {
        ticket_id: sampleTicketId,
        nonce: '6db140aef8cfacc6d900da842dd9e176cda0995aa8cf3fc169072c785c0c83ae',
        cart_fingerprint: 'd82e47da93e0ffd724e40f61f0f2f24f7cf51235e3bdaa25e33ab5790817be73',
        status: 'CONSUMED',
        verified_total: '294.54',
        verified_subtotal: '249.00',
        verified_tax: '20.54',
        verified_shipping: '25.00',
        currency: 'USD',
        created_at: new Date('2026-11-06T23:27:00.000Z'),
        expires_at: new Date('2026-11-06T23:37:00.000Z'),
        source_origin: 'LEGACY_JSON_IMPORT',
        integrity_status: 'UNVERIFIABLE_LEGACY',
      },
    ],
    ticketItems: [
      {
        id: 1,
        ticket_id: sampleTicketId,
        product_id: 'prod-logi-mx-bundle',
        product_name: 'Logitech MX Master 3S Mouse + MX Mechanical Keyboard Bundle',
        unit_price: '249.00',
        quantity: 1,
        line_total: '249.00',
      },
    ],
    captures: [
      {
        id: 1,
        order_id: '00000000-0000-0000-0000-000000000001',
        external_capture_id: '3D2952419L1477011',
        captured_amount: '294.54',
        currency: 'USD',
        provider: 'PAYPAL',
        status: 'COMPLETED',
        captured_at: new Date('2026-11-06T23:28:35.245Z'),
        created_at: new Date('2026-11-06T23:28:35.245Z'),
      },
    ],
    attempts: [] as any[],
    refunds: [] as any[],
    events: [] as any[],
    audit: [] as any[],
  });

  // =========================================================================
  // Adversarial Scenarios 1 - 16
  // =========================================================================

  // Test 1: Duplicate export destination rejection
  console.log('Test 1: Duplicate export destination rejection');
  const dupTarget = path.resolve(baseStagingDir, `dup-target-${Date.now()}`);
  fs.mkdirSync(dupTarget, { recursive: true });
  fs.writeFileSync(path.resolve(dupTarget, 'pre-existing.txt'), 'occupied');
  assert.throws(
    () => validateExportDestination(dupTarget),
    /Duplicate export destination/i,
    'Should reject non-empty existing directory'
  );
  console.log('  ✓ Duplicate destination strictly rejected');

  // Test 2: Unknown or invalid destination path (.data protection)
  console.log('Test 2: Destination path inside .data rejection');
  assert.throws(
    () => validateExportDestination(path.resolve(process.cwd(), '.data/orders')),
    /Security Violation: Export destination .* resolves inside protected legacy data directory/i
  );
  assert.throws(
    () => validateExportDestination(path.resolve(process.cwd(), '.data/approvals')),
    /Security Violation/i
  );
  assert.throws(
    () => validateExportDestination(path.resolve(process.cwd(), '.data')),
    /Security Violation/i
  );
  console.log('  ✓ Protection of .data and subdirectories strictly enforced');

  // Test 3: Missing order items
  console.log('Test 3: Missing order items rejection');
  const mockDataMissingItems = createBaseMockData();
  mockDataMissingItems.orderItems = []; // No items!
  const poolMissingItems = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataMissingItems.orders };
    if (sql.includes('FROM order_items')) return { rows: [] };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataMissingItems.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataMissingItems.ticketItems };
    return { rows: [] };
  });
  const exporterMissingItems = new ReverseExporter({ pool: poolMissingItems });
  let t3Caught = false;
  try {
    await exporterMissingItems.runExport({ outputDir: path.resolve(baseStagingDir, `test3-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('has 0 order items')) t3Caught = true;
  }
  assert(t3Caught, 'Should reject order with 0 items');
  console.log('  ✓ Missing order items relationship strictly rejected');

  // Test 4: Invalid canonical order identity
  console.log('Test 4: Invalid canonical order identity rejection');
  const mockDataBadId = createBaseMockData();
  mockDataBadId.orders[0].order_number = 'CORRUPTED-ORD-NUMBER';
  const poolBadId = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataBadId.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataBadId.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataBadId.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataBadId.ticketItems };
    return { rows: [] };
  });
  const exporterBadId = new ReverseExporter({ pool: poolBadId });
  let t4Caught = false;
  try {
    await exporterBadId.runExport({ outputDir: path.resolve(baseStagingDir, `test4-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Invalid canonical order identity')) t4Caught = true;
  }
  assert(t4Caught, 'Should reject order with corrupted canonical order_number');
  console.log('  ✓ Invalid canonical order identity strictly rejected');

  // Test 5: Duplicate source identifiers
  console.log('Test 5: Duplicate source identifiers rejection');
  const mockDataDupSource = createBaseMockData();
  mockDataDupSource.orders.push({ ...mockDataDupSource.orders[0], id: '00000000-0000-0000-0000-000000000002' });
  const poolDupSource = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataDupSource.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataDupSource.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataDupSource.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataDupSource.ticketItems };
    return { rows: [] };
  });
  const exporterDupSource = new ReverseExporter({ pool: poolDupSource });
  let t5Caught = false;
  try {
    await exporterDupSource.runExport({ outputDir: path.resolve(baseStagingDir, `test5-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Duplicate source identifier in orders')) t5Caught = true;
  }
  assert(t5Caught, 'Should reject duplicate external_order_id in orders');
  console.log('  ✓ Duplicate source identifiers strictly rejected');

  // Test 6: Corrupted approval provenance
  console.log('Test 6: Corrupted approval provenance rejection');
  const mockDataCorruptProv = createBaseMockData();
  mockDataCorruptProv.tickets[0].source_origin = 'INVALID_ORIGIN_HACK';
  const poolCorruptProv = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataCorruptProv.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataCorruptProv.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataCorruptProv.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataCorruptProv.ticketItems };
    return { rows: [] };
  });
  const exporterCorruptProv = new ReverseExporter({ pool: poolCorruptProv });
  let t6Caught = false;
  try {
    await exporterCorruptProv.runExport({ outputDir: path.resolve(baseStagingDir, `test6-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Corrupted approval provenance')) t6Caught = true;
  }
  assert(t6Caught, 'Should reject corrupted approval provenance');
  console.log('  ✓ Corrupted approval provenance strictly rejected');

  // Test 7: Missing historical approval signature preservation
  console.log('Test 7: Missing historical approval signature preserved without fabrication');
  const mockDataHistSig = createBaseMockData();
  const poolHistSig = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataHistSig.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataHistSig.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataHistSig.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataHistSig.ticketItems };
    return { rows: [] };
  });
  const exporterHistSig = new ReverseExporter({ pool: poolHistSig });
  const histSigDir = path.resolve(baseStagingDir, `test7-${Date.now()}`);
  await exporterHistSig.runExport({ outputDir: histSigDir });
  const exportedApprJson = JSON.parse(fs.readFileSync(path.resolve(histSigDir, `approvals/${sampleTicketId}.json`), 'utf8'));
  assert.strictEqual(exportedApprJson.integrityStatus, 'UNVERIFIABLE_LEGACY');
  assert.strictEqual(exportedApprJson.signature, undefined, 'Must not manufacture signature for UNVERIFIABLE_LEGACY');
  console.log('  ✓ Historical approval signature not manufactured; unverifiable state preserved');

  // Test 8: Malformed monetary amount
  console.log('Test 8: Malformed monetary amount rejection');
  const mockDataBadAmount = createBaseMockData();
  mockDataBadAmount.orders[0].authorized_total = 'INVALID_DOLLARS';
  const poolBadAmount = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataBadAmount.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataBadAmount.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataBadAmount.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataBadAmount.ticketItems };
    return { rows: [] };
  });
  const exporterBadAmount = new ReverseExporter({ pool: poolBadAmount });
  let t8Caught = false;
  try {
    await exporterBadAmount.runExport({ outputDir: path.resolve(baseStagingDir, `test8-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Malformed monetary string')) t8Caught = true;
  }
  assert(t8Caught, 'Should reject malformed monetary string');
  console.log('  ✓ Malformed monetary amount strictly rejected');

  // Test 9: Excess monetary precision
  console.log('Test 9: Excess monetary precision rejection');
  const mockDataExcess = createBaseMockData();
  mockDataExcess.orders[0].authorized_total = '294.545'; // 3 decimal places
  const poolExcess = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataExcess.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataExcess.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataExcess.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataExcess.ticketItems };
    return { rows: [] };
  });
  const exporterExcess = new ReverseExporter({ pool: poolExcess });
  let t9Caught = false;
  try {
    await exporterExcess.runExport({ outputDir: path.resolve(baseStagingDir, `test9-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Excess monetary precision')) t9Caught = true;
  }
  assert(t9Caught, 'Should reject excess monetary precision');
  console.log('  ✓ Excess monetary precision strictly rejected');

  // Test 10: Missing genuine capture relationship / synthetic capture in payment_captures
  console.log('Test 10: Missing genuine capture relationship / synthetic contamination');
  const mockDataSyntheticInLedger = createBaseMockData();
  mockDataSyntheticInLedger.captures[0].external_capture_id = 'CAP_SANDBOX_STAGE2_99999';
  const poolSyntheticLedger = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataSyntheticInLedger.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataSyntheticInLedger.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataSyntheticInLedger.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataSyntheticInLedger.ticketItems };
    if (sql.includes('FROM payment_captures')) return { rows: mockDataSyntheticInLedger.captures };
    return { rows: [] };
  });
  const exporterSyntheticLedger = new ReverseExporter({ pool: poolSyntheticLedger });
  let t10Caught = false;
  try {
    await exporterSyntheticLedger.runExport({ outputDir: path.resolve(baseStagingDir, `test10-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Financial Ledger Contamination')) t10Caught = true;
  }
  assert(t10Caught, 'Should reject synthetic capture in payment_captures table');
  console.log('  ✓ Synthetic capture contamination in financial ledger strictly rejected');

  // Test 11: Synthetic capture correctly segregated from genuine ledger
  console.log('Test 11: Synthetic capture segregation verification');
  const mockDataSimSeg = createBaseMockData();
  mockDataSimSeg.orders[0].is_simulated = true;
  mockDataSimSeg.captures = []; // Zero genuine captures in ledger!
  const poolSimSeg = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataSimSeg.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataSimSeg.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataSimSeg.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataSimSeg.ticketItems };
    return { rows: [] };
  });
  const exporterSimSeg = new ReverseExporter({ pool: poolSimSeg });
  const simSegDir = path.resolve(baseStagingDir, `test11-${Date.now()}`);
  const simSegRes = await exporterSimSeg.runExport({ outputDir: simSegDir });
  assert.strictEqual(simSegRes.genuineCapturesCount, 0);
  assert.strictEqual(simSegRes.syntheticCapturesCount, 1);
  const exportedSimOrder = JSON.parse(fs.readFileSync(path.resolve(simSegDir, `orders/${genuineOrderId}.json`), 'utf8'));
  assert.strictEqual(exportedSimOrder.isSimulated, true);
  assert.strictEqual(exportedSimOrder.captureId, `CAP_${genuineOrderId}`);
  console.log('  ✓ Synthetic capture cleanly segregated into order metadata without ledger contamination');

  // Test 12: Invalid refund amount
  console.log('Test 12: Invalid refund precision rejection');
  const mockDataBadRefund = createBaseMockData();
  mockDataBadRefund.refunds = [
    {
      id: '00000000-0000-0000-0000-000000000001',
      order_id: '00000000-0000-0000-0000-000000000001',
      attempt_id: '00000000-0000-0000-0000-000000000001',
      refund_amount: '10.001', // Excess precision!
      currency: 'USD',
      status: 'SETTLED',
      reason: 'test',
    },
  ];
  const poolBadRefund = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataBadRefund.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataBadRefund.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataBadRefund.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataBadRefund.ticketItems };
    if (sql.includes('FROM payment_refunds')) return { rows: mockDataBadRefund.refunds };
    return { rows: [] };
  });
  const exporterBadRefund = new ReverseExporter({ pool: poolBadRefund });
  let t12Caught = false;
  try {
    await exporterBadRefund.runExport({ outputDir: path.resolve(baseStagingDir, `test12-${Date.now()}`) });
  } catch (err: any) {
    if (err.message.includes('Excess monetary precision')) t12Caught = true;
  }
  assert(t12Caught, 'Should reject invalid refund amount');
  console.log('  ✓ Invalid refund amount strictly rejected');

  // Test 13: Partial export failure marker
  console.log('Test 13: Partial export failure produces EXPORT_FAILED.json and no valid manifest');
  const partialFailDir = path.resolve(baseStagingDir, `test13-${Date.now()}`);
  const poolFailMidway = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataBadId.orders };
    throw new Error('Simulated crash midway through query execution');
  });
  const exporterFailMidway = new ReverseExporter({ pool: poolFailMidway });
  let t13Caught = false;
  try {
    await exporterFailMidway.runExport({ outputDir: partialFailDir });
  } catch {
    t13Caught = true;
  }
  assert(t13Caught, 'Export must fail');
  assert(fs.existsSync(path.resolve(partialFailDir, 'EXPORT_FAILED.json')), 'Must write EXPORT_FAILED.json marker');
  assert(!fs.existsSync(path.resolve(partialFailDir, 'export-manifest.json')), 'Must NOT create completion manifest');
  const valFail = validateExportStaging(partialFailDir);
  assert.strictEqual(valFail.valid, false);
  console.log('  ✓ Partial export failure safely quarantined with failure marker and invalid status');

  // Test 14: Checksum mismatch in validation harness
  console.log('Test 14: Tampered file checksum mismatch detection');
  const tamperedDir = path.resolve(baseStagingDir, `test14-${Date.now()}`);
  const exporterNormal = new ReverseExporter({ pool: poolHistSig });
  await exporterNormal.runExport({ outputDir: tamperedDir });
  // Tamper with order file
  const orderFilePath = path.resolve(tamperedDir, `orders/${genuineOrderId}.json`);
  fs.writeFileSync(orderFilePath, JSON.stringify({ ...JSON.parse(fs.readFileSync(orderFilePath, 'utf8')), unauthorizedTamper: true }));
  const valTamper = validateExportStaging(tamperedDir);
  assert.strictEqual(valTamper.valid, false);
  assert(valTamper.errors.some((e) => e.includes('Checksum mismatch')), 'Must detect checksum mismatch');
  console.log('  ✓ Tampered file checksum mismatch detected and rejected by validation harness');

  // Test 15: Invalid JSON schema in validation harness
  console.log('Test 15: Invalid JSON schema detection');
  const schemaFailDir = path.resolve(baseStagingDir, `test15-${Date.now()}`);
  await exporterNormal.runExport({ outputDir: schemaFailDir });
  // Overwrite an approval file with invalid content
  fs.writeFileSync(path.resolve(schemaFailDir, `approvals/${sampleTicketId}.json`), '{ "ticketId": 12345 }'); // Bad schema!
  const valSchemaFail = validateExportStaging(schemaFailDir);
  assert.strictEqual(valSchemaFail.valid, false);
  assert(valSchemaFail.errors.length > 0);
  console.log('  ✓ Corrupted schema detected and rejected by validation harness');

  // Test 16: Determinism & idempotent export reproducibility
  console.log('Test 16: Deterministic export reproducibility across independent runs');
  const fixedTimestamp = '2026-11-08T19:00:00.000Z';
  const run1Dir = path.resolve(baseStagingDir, `test16-run1-${Date.now()}`);
  const run2Dir = path.resolve(baseStagingDir, `test16-run2-${Date.now()}`);
  const res1 = await exporterNormal.runExport({ outputDir: run1Dir, runId: 'det-run', snapshotTimestamp: fixedTimestamp });
  const res2 = await exporterNormal.runExport({ outputDir: run2Dir, runId: 'det-run', snapshotTimestamp: fixedTimestamp });
  const manifest1 = JSON.parse(fs.readFileSync(res1.manifestPath, 'utf8'));
  const manifest2 = JSON.parse(fs.readFileSync(res2.manifestPath, 'utf8'));
  assert.strictEqual(manifest1.files.length, manifest2.files.length);
  for (let i = 0; i < manifest1.files.length; i++) {
    assert.strictEqual(manifest1.files[i].relativePath, manifest2.files[i].relativePath);
    assert.strictEqual(manifest1.files[i].sha256, manifest2.files[i].sha256, `File ${manifest1.files[i].relativePath} must have identical SHA-256`);
  }
  console.log('  ✓ Deterministic export confirmed: 100% byte-for-byte SHA-256 checksum equivalence');

  // =========================================================================
  // Non-Empty Financial Sidecar & Semantic Roundtrip Verification Tests
  // =========================================================================

  // Test 17: Non-empty financial sidecar verification with representative fixtures
  console.log('Test 17: Non-empty financial sidecar mapping and verification');
  const mockDataNonEmpty = createBaseMockData();
  const orderUuid = '00000000-0000-0000-0000-000000000001';
  const captureUuid = '00000000-0000-0000-0000-000000000002';
  const attemptUuid = '00000000-0000-0000-0000-000000000003';
  const refundUuid = '00000000-0000-0000-0000-000000000004';

  mockDataNonEmpty.attempts = [
    {
      id: attemptUuid,
      order_id: orderUuid,
      idempotency_key: 'idemp-attempt-001',
      action_type: 'CAPTURE',
      amount: '294.54',
      currency: 'USD',
      status: 'SETTLED',
      provider_lock_token: 'tok-lock-123',
      initiated_at: new Date('2026-11-06T23:28:00.000Z'),
      completed_at: new Date('2026-11-06T23:28:35.000Z'),
    },
  ];

  mockDataNonEmpty.refunds = [
    {
      id: refundUuid,
      order_id: orderUuid,
      capture_id: captureUuid,
      payment_attempt_id: attemptUuid,
      external_refund_id: 'REFUND-MOCK-999',
      refund_amount: '50.00',
      currency: 'USD',
      status: 'SETTLED',
      reason: 'Partial customer return',
      refunded_at: new Date('2026-11-07T10:00:00.000Z'),
      created_at: new Date('2026-11-07T10:00:00.000Z'),
    },
  ];

  mockDataNonEmpty.events = [
    {
      id: 1,
      order_id: orderUuid,
      event_type: 'PAYMENT_CAPTURED',
      previous_status: 'PENDING_PAYMENT_APPROVAL',
      new_status: 'COMPLETED',
      amount: '294.54',
      occurred_at: new Date('2026-11-06T23:28:35.245Z'),
    },
  ];

  mockDataNonEmpty.audit = [
    {
      id: 1,
      event_type: 'SECURITY_CHECK',
      severity: 'INFO',
      message: 'Checkout authorization verified',
      session_id: 'sess-abc-123',
      created_at: new Date('2026-11-06T23:27:00.000Z'),
    },
  ];

  const poolNonEmpty = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockDataNonEmpty.orders };
    if (sql.includes('FROM order_items')) return { rows: mockDataNonEmpty.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockDataNonEmpty.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockDataNonEmpty.ticketItems };
    if (sql.includes('FROM payment_captures')) return { rows: mockDataNonEmpty.captures };
    if (sql.includes('FROM payment_attempts')) return { rows: mockDataNonEmpty.attempts };
    if (sql.includes('FROM payment_refunds')) return { rows: mockDataNonEmpty.refunds };
    if (sql.includes('FROM payment_events')) return { rows: mockDataNonEmpty.events };
    if (sql.includes('FROM audit_events')) return { rows: mockDataNonEmpty.audit };
    return { rows: [] };
  });

  const exporterNonEmpty = new ReverseExporter({ pool: poolNonEmpty });
  const nonEmptyDir = path.resolve(baseStagingDir, `test17-${Date.now()}`);
  const nonEmptyRes = await exporterNonEmpty.runExport({ outputDir: nonEmptyDir });
  assert.strictEqual(nonEmptyRes.success, true);

  const valNonEmpty = validateExportStaging(nonEmptyDir);
  assert.strictEqual(valNonEmpty.valid, true, `Non-empty sidecar validation failed: ${valNonEmpty.errors.join(', ')}`);

  // Verify attempt sidecar contents
  const stagedAttempts = JSON.parse(fs.readFileSync(path.resolve(nonEmptyDir, 'recovery/recovery-payment-attempts.json'), 'utf8'));
  assert.strictEqual(stagedAttempts.length, 1);
  assert.strictEqual(stagedAttempts[0].amountCents, 29454);
  assert.strictEqual(stagedAttempts[0].status, 'SETTLED');

  // Verify refund sidecar contents
  const stagedRefunds = JSON.parse(fs.readFileSync(path.resolve(nonEmptyDir, 'recovery/recovery-payment-refunds.json'), 'utf8'));
  assert.strictEqual(stagedRefunds.length, 1);
  assert.strictEqual(stagedRefunds[0].refundAmountCents, 5000);
  assert.strictEqual(stagedRefunds[0].externalRefundId, 'REFUND-MOCK-999');

  console.log('  ✓ Non-empty financial sidecars mapped losslessly with exact cent accounting');

  // Test 18: Unmanifested extra file detection
  console.log('Test 18: Unmanifested extra file detection');
  const extraFileDir = path.resolve(baseStagingDir, `test18-${Date.now()}`);
  await exporterNormal.runExport({ outputDir: extraFileDir });
  fs.writeFileSync(path.resolve(extraFileDir, 'recovery/unmanifested-rogue.txt'), 'rogue');
  const valExtra = validateExportStaging(extraFileDir);
  assert.strictEqual(valExtra.valid, false);
  assert(valExtra.errors.some((e) => e.includes('Unmanifested extra file detected')), 'Must detect unmanifested file');
  console.log('  ✓ Unmanifested extra files strictly detected and rejected');

  // Test 19: Missing sidecar detection
  console.log('Test 19: Missing sidecar detection');
  const missingSidecarDir = path.resolve(baseStagingDir, `test19-${Date.now()}`);
  await exporterNormal.runExport({ outputDir: missingSidecarDir });
  fs.unlinkSync(path.resolve(missingSidecarDir, 'recovery/recovery-financial-captures.json'));
  const valMissingSidecar = validateExportStaging(missingSidecarDir);
  assert.strictEqual(valMissingSidecar.valid, false);
  assert(valMissingSidecar.errors.some((e) => e.includes('Missing manifest file on disk')));
  console.log('  ✓ Missing sidecar strictly detected and rejected');

  // =========================================================================
  // Live Integration Test: Export Persistent PostgreSQL Baseline Database
  // =========================================================================
  console.log('\n--- Running Live Integration Export against Persistent procurepilot DB ---');
  const liveTargetDir = path.resolve(baseStagingDir, `live-baseline-export-${Date.now()}`);
  const liveExporter = new ReverseExporter({ expectedDbName: 'procurepilot' });

  const liveRes = await liveExporter.runExport({ outputDir: liveTargetDir });
  assert.strictEqual(liveRes.success, true);
  assert.strictEqual(liveRes.ordersCount, 80, 'Must export exactly 80 orders');
  assert.strictEqual(liveRes.orderItemsCount, 80, 'Must export exactly 80 order items');
  assert.strictEqual(liveRes.approvalsCount, 219, 'Must export exactly 219 approval tickets');
  assert.strictEqual(liveRes.approvalItemsCount, 323, 'Must export exactly 323 approval items');
  assert.strictEqual(liveRes.genuineCapturesCount, 1, 'Must export exactly 1 genuine capture');

  // Validate live export staging
  const liveValidation = validateExportStaging(liveTargetDir);
  assert.strictEqual(liveValidation.valid, true, `Live export validation failed: ${liveValidation.errors.join(', ')}`);
  assert.strictEqual(liveValidation.reconciliationPassed, true, 'Financial reconciliation must pass');
  assert.strictEqual(liveValidation.aggregateAuthorizedCents, 10993260, 'Authorized total must be $109,932.60');
  assert.strictEqual(liveValidation.aggregateCapturedCents, 29454, 'Captured total must be $294.54');
  console.log(`  ✓ Live export staging verified: 80 orders, 219 tickets, 1 genuine capture reconciled to exact cents.`);

  // Test 20: Original legacy JSON semantic round-trip verification
  console.log('\nTest 20: Original legacy JSON semantic round-trip verification');
  const roundtripReport = verifySemanticRoundtrip(liveTargetDir);
  if (!roundtripReport.success) {
    console.error('Unexpected losses found:', JSON.stringify(roundtripReport.unexpectedLosses, null, 2));
  }
  assert.strictEqual(roundtripReport.success, true, 'Semantic roundtrip verification must succeed');
  assert.strictEqual(roundtripReport.totalOrdersCompared, 80, 'Must compare all 80 orders');
  assert.strictEqual(roundtripReport.totalApprovalsCompared, 219, 'Must compare all 219 approvals');
  assert.strictEqual(roundtripReport.unexpectedLossCount, 0, 'Must have zero unexpected losses');
  assert.strictEqual(roundtripReport.quarantinedOrphanVerified, true, 'Quarantined orphan must remain excluded');

  console.log(`  ✓ Semantic roundtrip passed: ${roundtripReport.totalFieldsCompared} fields compared.`);
  console.log(`    - Exact matches: ${roundtripReport.exactMatchesCount}`);
  console.log(`    - Lossless normalizations: ${roundtripReport.losslessNormalizationsCount}`);
  console.log(`    - Intentional semantic differences: ${roundtripReport.intentionalSemanticDifferencesCount}`);
  console.log(`    - Information not present in Postgres: ${roundtripReport.infoNotPresentInPostgresCount}`);
  console.log(`    - Unexpected data loss: ${roundtripReport.unexpectedLossCount}`);

  // Test 21: Quarantined record preservation and accounting
  console.log('\nTest 21: Quarantined record accounting and exclusion verification');
  const liveManifest = JSON.parse(fs.readFileSync(liveRes.manifestPath, 'utf8'));
  assert.strictEqual(liveManifest.quarantinedOrdersCount, 1);
  assert.strictEqual(liveManifest.ordersCount, 80);
  assert.strictEqual(liveManifest.totalScannedOrders, 81);
  assert.strictEqual(liveManifest.quarantinedOrders[0].orderId, 'TEST-ORDER-MUTATION-CHECK-01');
  assert(!fs.existsSync(path.resolve(liveTargetDir, 'orders/TEST-ORDER-MUTATION-CHECK-01.json')), 'Quarantined order must NOT exist in exported orders');
  console.log('  ✓ Quarantined record (TEST-ORDER-MUTATION-CHECK-01) properly accounted and excluded from orders/');

  // Test 22: Exact BigInt monetary serialization & boundary safety
  console.log('\nTest 22: Exact BigInt monetary serialization & boundary safety');
  // Required formatter test cases
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(29454)), '294.54');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(1)), '0.01');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(-25)), '-0.25');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(0)), '0.00');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt('9007199254740991')), '90071992547409.91');

  // Verify valid legacy number conversions
  assert.strictEqual(formatCentsToLegacyNumber(29454), 294.54);
  assert.strictEqual(formatCentsToLegacyNumber(1), 0.01);
  assert.strictEqual(formatCentsToLegacyNumber(0), 0);
  assert.strictEqual(formatCentsToLegacyNumber(129500), 1295);

  // Inexact conversion detection: values losing cent precision in IEEE-754 floats MUST throw
  assert.throws(
    () => {
      convertExactDecimalToLegacyNumber('90071992547409.01', BigInt('9007199254740901'));
    },
    /Inexact float conversion detected/,
    'Inexact float conversion must throw explicit error'
  );

  // Boundary check: values exceeding safe integer cents MUST throw
  assert.throws(
    () => {
      convertExactDecimalToLegacyNumber('9999999999999999.99', BigInt('999999999999999999'));
    },
    /exceeds JavaScript safe integer limit/,
    'Values exceeding safe integer limit must throw'
  );

  // Round-trip equality
  const roundtripCents = parseExactDecimalToCents(formatCentsToExactDecimalString(29454), 'testRoundtrip');
  assert.strictEqual(roundtripCents, 29454);
  console.log('  ✓ Exact BigInt monetary formatting and boundary conversion verified');

  // Test 23: Simulated capture timestamp provenance & non-conflation
  console.log('\nTest 23: Simulated capture timestamp provenance & non-conflation');
  const mockCaptureData = createBaseMockData();
  const mockSimOrderUuid = '00000000-0000-0000-0000-000000000099';
  const createdDate = new Date('2026-11-06T20:50:00.000Z');
  const updatedDate = new Date('2026-11-06T20:50:00.050Z'); // 50ms later

  mockCaptureData.orders.push({
    id: mockSimOrderUuid,
    external_order_id: 'SANDBOX_STAGE2_MOCK_TEST_01',
    order_number: generateLegacyOrderNumber('SANDBOX_STAGE2_MOCK_TEST_01'),
    ticket_id: sampleTicketId,
    status: 'COMPLETED',
    authorized_total: '100.00',
    authorized_subtotal: '100.00',
    authorized_tax: '0.00',
    authorized_shipping: '0.00',
    currency: 'USD',
    approver_name: 'Alex Mercer',
    approver_department: 'Engineering',
    created_at: createdDate,
    updated_at: updatedDate,
    is_simulated: true,
    source_origin: 'LEGACY_JSON_IMPORT',
    is_simulated_provenance: 'LOCAL_TEST_HARNESS',
  } as any);

  mockCaptureData.orderItems.push({
    id: 99,
    order_id: mockSimOrderUuid,
    product_id: 'prod-test-01',
    product_name: 'Test Item',
    unit_price: '100.00',
    quantity: 1,
    line_total: '100.00',
  });

  const poolSimTimestamp = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockCaptureData.orders };
    if (sql.includes('FROM order_items')) return { rows: mockCaptureData.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockCaptureData.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockCaptureData.ticketItems };
    if (sql.includes('FROM payment_captures')) return { rows: [] };
    return { rows: [] };
  });

  const exporterSimTimestamp = new ReverseExporter({ pool: poolSimTimestamp });
  const simTimestampDir = path.resolve(baseStagingDir, `test23-${Date.now()}`);
  await exporterSimTimestamp.runExport({ outputDir: simTimestampDir });

  const exportedSimOrder23 = JSON.parse(
    fs.readFileSync(path.resolve(simTimestampDir, 'orders/SANDBOX_STAGE2_MOCK_TEST_01.json'), 'utf8')
  );

  // Provenance verification: must use updated_at, NOT created_at
  assert.strictEqual(exportedSimOrder23.capturedAt, updatedDate.toISOString(), 'Must use updated_at');
  assert.notStrictEqual(exportedSimOrder23.capturedAt, createdDate.toISOString(), 'Must NOT use created_at');
  console.log('  ✓ Preserved update timestamp used for historical simulated capture; creation time strictly not conflated');

  // Ambiguous runtime simulated order omits capturedAt
  const mockAmbiguousData = createBaseMockData();
  mockAmbiguousData.orders.push({
    id: '00000000-0000-0000-0000-000000000098',
    external_order_id: 'SANDBOX_AMBIGUOUS_01',
    order_number: generateLegacyOrderNumber('SANDBOX_AMBIGUOUS_01'),
    ticket_id: sampleTicketId,
    status: 'COMPLETED',
    authorized_total: '100.00',
    authorized_subtotal: '100.00',
    authorized_tax: '0.00',
    authorized_shipping: '0.00',
    currency: 'USD',
    approver_name: 'Alex Mercer',
    approver_department: 'Engineering',
    created_at: createdDate,
    updated_at: updatedDate,
    is_simulated: true,
    source_origin: 'RUNTIME', // Runtime origin -> ambiguous!
  } as any);
  mockAmbiguousData.orderItems.push({
    id: 98,
    order_id: '00000000-0000-0000-0000-000000000098',
    product_id: 'prod-test-01',
    product_name: 'Test Item',
    unit_price: '100.00',
    quantity: 1,
    line_total: '100.00',
  });

  const poolAmbiguous = createMockPool(async (sql) => {
    if (sql.includes('FROM orders')) return { rows: mockAmbiguousData.orders };
    if (sql.includes('FROM order_items')) return { rows: mockAmbiguousData.orderItems };
    if (sql.includes('FROM approval_tickets')) return { rows: mockAmbiguousData.tickets };
    if (sql.includes('FROM approval_ticket_items')) return { rows: mockAmbiguousData.ticketItems };
    if (sql.includes('FROM payment_captures')) return { rows: [] };
    return { rows: [] };
  });
  const exporterAmbiguous = new ReverseExporter({ pool: poolAmbiguous });
  const ambiguousDir = path.resolve(baseStagingDir, `test23b-${Date.now()}`);
  await exporterAmbiguous.runExport({ outputDir: ambiguousDir });

  const exportedAmbiguous = JSON.parse(
    fs.readFileSync(path.resolve(ambiguousDir, 'orders/SANDBOX_AMBIGUOUS_01.json'), 'utf8')
  );
  assert.strictEqual(exportedAmbiguous.capturedAt, undefined, 'Ambiguous simulated order must omit capturedAt');
  console.log('  ✓ Ambiguous simulated order cleanly omits capturedAt');

  // Test 24: Reconcile all 78 historical simulated orders against source .data/orders
  console.log('\nTest 24: Reconcile all 78 historical simulated orders against source .data/orders');
  const simManifestEntries = JSON.parse(fs.readFileSync('migration-simulated-orders-manifest.json', 'utf8'));
  let simMatchCount = 0;
  for (const entry of simManifestEntries) {
    const exportedFile = path.resolve(liveTargetDir, `orders/${entry.orderId}.json`);
    const sourceFile = path.resolve('.data/orders', entry.fileName);
    assert(fs.existsSync(exportedFile), `Exported order ${entry.orderId} must exist`);
    assert(fs.existsSync(sourceFile), `Source order ${entry.fileName} must exist`);

    const expOrder = JSON.parse(fs.readFileSync(exportedFile, 'utf8'));
    const srcOrder = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

    assert.strictEqual(expOrder.capturedAt, srcOrder.capturedAt, `Timestamp mismatch for ${entry.orderId}`);
    simMatchCount++;
  }
  assert.strictEqual(simMatchCount, 78, 'All 78 simulated orders must match source capturedAt exactly');
  console.log('  ✓ All 78 historical simulated orders match original source capturedAt with 100% precision');

  // Test 25: Session security & credential sequestration verification
  console.log('\nTest 25: Session security & credential sequestration verification');
  // Check that all 219 exported approvals have sessionToken === undefined
  const approvalFiles = fs.readdirSync(path.resolve(liveTargetDir, 'approvals'));
  assert.strictEqual(approvalFiles.length, 219);
  for (const f of approvalFiles) {
    const appr = JSON.parse(fs.readFileSync(path.resolve(liveTargetDir, 'approvals', f), 'utf8'));
    assert.strictEqual(appr.sessionToken, undefined, `Approval ${f} must not have sessionToken`);
  }

  // Check that recovery-approval-credentials-metadata.json exists and has verifier metadata
  const credsSidecarPath = path.resolve(liveTargetDir, 'recovery/recovery-approval-credentials-metadata.json');
  assert(fs.existsSync(credsSidecarPath), 'recovery-approval-credentials-metadata.json must exist');
  const credsSidecar = JSON.parse(fs.readFileSync(credsSidecarPath, 'utf8'));
  assert.strictEqual(credsSidecar.classification, 'SENSITIVE_CREDENTIAL_VERIFIER_METADATA');
  assert.strictEqual(credsSidecar.credentials.length, 219);

  // Tamper test: SHA-256 hash placed in sessionToken must trigger validation error
  const tamperSessionDir = path.resolve(baseStagingDir, `test25-${Date.now()}`);
  await exporterNormal.runExport({ outputDir: tamperSessionDir });
  const sampleApprPath = path.resolve(tamperSessionDir, `approvals/${sampleTicketId}.json`);
  const sampleAppr = JSON.parse(fs.readFileSync(sampleApprPath, 'utf8'));
  sampleAppr.sessionToken = 'e'.repeat(64); // Inject 64-hex SHA-256 hash!
  fs.writeFileSync(sampleApprPath, JSON.stringify(sampleAppr));
  const valTamperSession = validateExportStaging(tamperSessionDir);
  assert.strictEqual(valTamperSession.valid, false);
  assert(
    valTamperSession.errors.some((e) => e.includes('contains a SHA-256 hash in plaintext sessionToken field')),
    'Must detect and reject SHA-256 hash in sessionToken'
  );
  console.log('  ✓ Plaintext session tokens omitted from approvals; SHA-256 verifier sequestered; hash injection rejected');

  console.log('\n================================================================');
  console.log('🎉 ALL REVERSE-EXPORT & RECOVERY TESTS PASSED (0 FAILURES)');
  console.log('================================================================\n');

  await db.getPool().end();
}

if (require.main === module) {
  runReverseExportTests().catch((err) => {
    console.error('❌ Reverse-export test suite failed:', err);
    process.exit(1);
  });
}
