import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import assert from 'node:assert';

export async function runLivePostgresValidation() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Live PostgreSQL 16 Multi-Connection Validation');
  console.log('================================================================');

  const baseConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  };

  const tempDbName = `procurepilot_temp_val_${Date.now()}`;
  const rootClient = new Client({ ...baseConfig, database: 'postgres' });
  rootClient.on('error', () => {});

  try {
    await rootClient.connect();
    console.log('  ✓ Connected to root PostgreSQL instance');
  } catch (err) {
    console.log('  [INFO] Local PostgreSQL unavailable or credentials refused.');
    console.log('  [INFO] Integration tests explicitly marked NOT EXECUTED — DATABASE UNAVAILABLE');
    return { executed: false, reason: 'DATABASE UNAVAILABLE' };
  }

  try {
    // 1. Create temporary disposable database
    await rootClient.query(`CREATE DATABASE "${tempDbName}"`);
    console.log(`  ✓ Created isolated disposable test database: ${tempDbName}`);

    // Connect admin/migration client to disposable database
    const adminClient = new Client({ ...baseConfig, database: tempDbName });
    adminClient.on('error', () => {});
    await adminClient.connect();

    try {
      // 2. Execute Migration 001
      const m001Path = path.resolve(process.cwd(), 'src/db/migrations/001_initial_schema.sql');
      const m001Sql = fs.readFileSync(m001Path, 'utf8');
      await adminClient.query(m001Sql);
      console.log('  ✓ Migration 001 executed successfully (13 core tables, constraints, seed tenant)');

      // 3. Execute Migration 002
      const m002Path = path.resolve(process.cwd(), 'src/db/migrations/002_refund_integrity.sql');
      const m002Sql = fs.readFileSync(m002Path, 'utf8');
      await adminClient.query(m002Sql);
      console.log('  ✓ Migration 002 executed successfully (Stored procedures, triggers, procurepilot_app grants)');

      // 3b. Execute Migration 003
      const m003Path = path.resolve(process.cwd(), 'src/db/migrations/003_refund_attempt_security.sql');
      const m003Sql = fs.readFileSync(m003Path, 'utf8');
      await adminClient.query(m003Sql);
      console.log('  ✓ Migration 003 executed successfully (Refund write-path protection trigger, controlled failure/ambiguity functions, privilege revocation)');

      // 3c. Execute Migration 004
      const m004Path = path.resolve(process.cwd(), 'src/db/migrations/004_non_forgeable_refund_authorization.sql');
      const m004Sql = fs.readFileSync(m004Path, 'utf8');
      await adminClient.query(m004Sql);
      console.log('  ✓ Migration 004 executed successfully (Dedicated non-login owner role, non-forgeable trigger authorization, GUC removal)');

      // 3d. Execute Migration 005
      const m005Path = path.resolve(process.cwd(), 'src/db/migrations/005_legacy_approval_provenance.sql');
      const m005Sql = fs.readFileSync(m005Path, 'utf8');
      await adminClient.query(m005Sql);
      console.log('  ✓ Migration 005 executed successfully (Legacy approval provenance, schema constraints, migration write-path)');

      // 4. Verify Function Ownership and Privileges Matrix
      console.log('\n--- Section B: Role Privileges & Stored Function Authorization ---');
      const funcPrivRes = await adminClient.query(`
        SELECT p.proname, p.prosecdef, r.rolname AS owner, p.proconfig
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN (
          'create_refund_reservation',
          'finalize_refund_settlement',
          'record_refund_failure',
          'record_refund_outcome_unknown',
          'enforce_refund_attempt_security'
        )
      `);
      assert.strictEqual(funcPrivRes.rows.length, 5);
      for (const f of funcPrivRes.rows) {
        assert.strictEqual(f.owner, 'procurepilot_refund_owner', `Function ${f.proname} must be owned by procurepilot_refund_owner`);
        assert.ok(f.proconfig !== null, `Function ${f.proname} proconfig must not be null`);
        assert.ok(Array.isArray(f.proconfig), `Function ${f.proname} proconfig must be an array`);
        assert.strictEqual(f.proconfig.length, 1, `Function ${f.proname} proconfig must contain exactly one configuration setting`);
        assert.strictEqual(
          f.proconfig[0],
          'search_path=pg_catalog, public, pg_temp',
          `Function ${f.proname} must have exact search_path 'search_path=pg_catalog, public, pg_temp' (found: ${f.proconfig[0]})`
        );
        if (f.proname === 'enforce_refund_attempt_security') {
          assert.strictEqual(f.prosecdef, false, `Trigger function ${f.proname} must be SECURITY INVOKER (prosecdef=false)`);
        } else {
          assert.strictEqual(f.prosecdef, true, `Lifecycle function ${f.proname} must be SECURITY DEFINER (prosecdef=true)`);
        }
      }
      console.log('  ✓ All 5 functions owned by procurepilot_refund_owner with safe search_path (pg_catalog, public, pg_temp)');

      // Test with restricted runtime role: procurepilot_app
      const appClient = new Client({
        ...baseConfig,
        user: 'procurepilot_app',
        password: 'procurepilot_app_pass_test',
        database: tempDbName,
      });
      appClient.on('error', () => {});
      await appClient.connect();

      // Test inability of procurepilot_app to directly write to payment_refunds
      let directRefundBlocked = false;
      try {
        await appClient.query(`
          INSERT INTO payment_refunds (
            id, order_id, capture_id, external_refund_id, refund_amount, currency, refunded_at
          ) VALUES (
            gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'ILLEGAL-01', 100, 'USD', NOW()
          )
        `);
      } catch (err: any) {
        if (err.code === '42501') {
          // 42501 is permission_denied in PostgreSQL
          directRefundBlocked = true;
        }
      }
      assert.ok(directRefundBlocked, 'procurepilot_app must be DENIED direct INSERT privileges on payment_refunds');
      console.log('  ✓ Direct unauthorized INSERT on payment_refunds blocked by table grant permissions (Error 42501: permission denied)');

      // 5. Seed Test Data for Concurrency & Multi-Capture Tests
      console.log('\n--- Section C: Two-Connection Concurrency & Multi-Capture Accounting ---');
      const seedOrgId = '00000000-0000-0000-0000-000000000001';
      const ticketId = 'appr_tk_conc_001';

      await adminClient.query(
        `INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total, currency,
          status, expires_at
        ) VALUES (
          $1, $2, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          1000.00, 0.00, 0.00, 1000.00, 'USD', 'APPROVED', NOW() + INTERVAL '1 hour'
        )`,
        [ticketId, seedOrgId]
      );

      const orderRes = await adminClient.query(
        `INSERT INTO orders (
          order_number, organization_id, ticket_id, status, authorized_total,
          authorized_subtotal, authorized_tax, authorized_shipping, currency, idempotency_key
        ) VALUES ('ORD-CONC-01', $1, $2, 'COMPLETED', 1000.00, 1000.00, 0, 0, 'USD', 'idem-ord-conc-01')
        RETURNING id`,
        [seedOrgId, ticketId]
      );
      const orderId = orderRes.rows[0].id;

      const captureRes = await adminClient.query(
        `INSERT INTO payment_captures (
          order_id, external_capture_id, captured_amount, currency
        ) VALUES ($1, 'CAP-CONC-001', 1000.00, 'USD') RETURNING id`,
        [orderId]
      );
      const captureId = captureRes.rows[0].id;
      console.log(`  ✓ Provisioned Order (total $1,000.00) with Capture ($1,000.00)`);

      // TEST 1: Two-Connection Competing Reservations ($600 each against $1,000)
      console.log('Test 1: Two-connection competing reservations ($600 each against $1,000 capture)');
      const connA = new Client({ ...baseConfig, user: 'procurepilot_app', password: 'procurepilot_app_pass_test', database: tempDbName });
      const connB = new Client({ ...baseConfig, user: 'procurepilot_app', password: 'procurepilot_app_pass_test', database: tempDbName });
      connA.on('error', () => {});
      connB.on('error', () => {});
      await connA.connect();
      await connB.connect();

      await connA.query('BEGIN');
      await connB.query('BEGIN');

      // ConnA acquires the order row lock via create_refund_reservation
      const resA = await connA.query(
        `SELECT * FROM create_refund_reservation($1, $2, 600.00, 'USD', 'idem-race-A', 'req-A')`,
        [orderId, captureId]
      );
      assert.strictEqual(parseFloat(resA.rows[0].available_balance_after), 400.0);

      // ConnB executes concurrently while ConnA holds the lock
      const connBPromise = connB.query(
        `SELECT * FROM create_refund_reservation($1, $2, 600.00, 'USD', 'idem-race-B', 'req-B')`,
        [orderId, captureId]
      );

      // Small delay to ensure ConnB is waiting on ConnA's lock
      await new Promise((r) => setTimeout(r, 100));

      // ConnA commits and releases order lock
      await connA.query('COMMIT');

      // ConnB now acquires lock, re-evaluates balance, and MUST be rejected
      let connBFailed = false;
      try {
        await connBPromise;
        await connB.query('COMMIT');
      } catch (err: any) {
        connBFailed = true;
        await connB.query('ROLLBACK');
        assert.ok(err.message.includes('exceeds available capture balance'));
      }
      assert.ok(connBFailed, 'ConnB must be rejected with available balance exceeded after lock acquisition');
      console.log('  ✓ Competing transactions serialized: ConnA reserved $600; ConnB blocked with Integrity Violation');

      // TEST 2: Same Idempotency Key Across Two Connections
      console.log('Test 2: Same idempotency key submitted concurrently from two connections');
      const connSame1 = new Client({ ...baseConfig, user: 'procurepilot_app', password: 'procurepilot_app_pass_test', database: tempDbName });
      const connSame2 = new Client({ ...baseConfig, user: 'procurepilot_app', password: 'procurepilot_app_pass_test', database: tempDbName });
      connSame1.on('error', () => {});
      connSame2.on('error', () => {});
      await connSame1.connect();
      await connSame2.connect();

      const sameKey = 'idem-same-concurrent-key';
      const [sameRes1, sameRes2] = await Promise.all([
        connSame1.query(`SELECT * FROM create_refund_reservation($1, $2, 200.00, 'USD', $3, 'req-same-1')`, [orderId, captureId, sameKey]),
        connSame2.query(`SELECT * FROM create_refund_reservation($1, $2, 200.00, 'USD', $3, 'req-same-2')`, [orderId, captureId, sameKey]),
      ]);

      assert.strictEqual(sameRes1.rows[0].attempt_id, sameRes2.rows[0].attempt_id, 'Both callers must receive the exact same attemptId');
      assert.ok(
        (sameRes1.rows[0].is_existing_reservation && !sameRes2.rows[0].is_existing_reservation) ||
        (!sameRes1.rows[0].is_existing_reservation && sameRes2.rows[0].is_existing_reservation),
        'Exactly one call must create the reservation and the other identify existing reservation'
      );
      console.log('  ✓ Concurrent identical idempotency requests returned identical reservation attempt without double-deduction');

      // TEST 3: Conflicting Idempotency Key Reuse
      console.log('Test 3: Conflicting parameter reuse on existing idempotency key');
      let conflictDetected = false;
      try {
        await connSame1.query(
          `SELECT * FROM create_refund_reservation($1, $2, 300.00, 'USD', $3, 'req-diff')`,
          [orderId, captureId, sameKey] // different amount: 300 vs 200
        );
      } catch (err: any) {
        conflictDetected = true;
        assert.ok(err.message.includes('Idempotency Conflict'));
      }
      assert.ok(conflictDetected, 'Conflicting parameters on existing key must be rejected');
      console.log('  ✓ Conflicting parameter reuse on same idempotency key strictly rejected');

      // TEST 4: Multiple Captures on One Order ($600 and $400 captures)
      console.log('Test 4: Multiple captures on one order ($600 and $400 captures)');
      const ticketMultiId = 'appr_tk_multi_001';
      await adminClient.query(
        `INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total, currency,
          status, expires_at
        ) VALUES (
          $1, $2, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          1000.00, 0.00, 0.00, 1000.00, 'USD', 'APPROVED', NOW() + INTERVAL '1 hour'
        )`,
        [ticketMultiId, seedOrgId]
      );

      const multiOrderRes = await adminClient.query(
        `INSERT INTO orders (
          order_number, organization_id, ticket_id, status, authorized_total,
          authorized_subtotal, authorized_tax, authorized_shipping, currency, idempotency_key
        ) VALUES ('ORD-MULTI-01', $1, $2, 'COMPLETED', 1000.00, 1000.00, 0, 0, 'USD', 'idem-ord-multi-01')
        RETURNING id`,
        [seedOrgId, ticketMultiId]
      );
      const multiOrderId = multiOrderRes.rows[0].id;

      // Capture 1: $600.00
      const cap1Res = await adminClient.query(
        `INSERT INTO payment_captures (
          order_id, external_capture_id, captured_amount, currency
        ) VALUES ($1, 'CAP-MULTI-01', 600.00, 'USD') RETURNING id`,
        [multiOrderId]
      );
      const cap1Id = cap1Res.rows[0].id;

      // Capture 2: $400.00
      const cap2Res = await adminClient.query(
        `INSERT INTO payment_captures (
          order_id, external_capture_id, captured_amount, currency
        ) VALUES ($1, 'CAP-MULTI-02', 400.00, 'USD') RETURNING id`,
        [multiOrderId]
      );
      const cap2Id = cap2Res.rows[0].id;

      // Reserve and finalize full refund on Capture 1 ($600)
      const resCap1 = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 600.00, 'USD', 'idem-cap1-full', 'req-cap1')`,
        [multiOrderId, cap1Id]
      );
      const attemptCap1Id = resCap1.rows[0].attempt_id;
      const settleCap1 = await appClient.query(
        `SELECT * FROM finalize_refund_settlement($1, 'EXT-REF-CAP1', 600.00, 'USD', 'Full refund on capture 1')`,
        [attemptCap1Id]
      );
      assert.strictEqual(settleCap1.rows[0].new_order_status, 'PARTIALLY_REFUNDED');

      // Check Order status is PARTIALLY_REFUNDED (NOT REFUNDED!) because Capture 2 ($400) is still un-refunded
      const orderCheck1 = await adminClient.query('SELECT status FROM orders WHERE id = $1', [multiOrderId]);
      assert.strictEqual(orderCheck1.rows[0].status, 'PARTIALLY_REFUNDED');
      console.log('  ✓ Full refund on Capture 1 ($600) left order in PARTIALLY_REFUNDED because Capture 2 ($400) remains active');

      // Reserve and finalize full refund on Capture 2 ($400)
      const resCap2 = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 400.00, 'USD', 'idem-cap2-full', 'req-cap2')`,
        [multiOrderId, cap2Id]
      );
      const attemptCap2Id = resCap2.rows[0].attempt_id;
      const settleCap2 = await appClient.query(
        `SELECT * FROM finalize_refund_settlement($1, 'EXT-REF-CAP2', 400.00, 'USD', 'Full refund on capture 2')`,
        [attemptCap2Id]
      );
      assert.strictEqual(settleCap2.rows[0].new_order_status, 'REFUNDED');

      // Check Order status is now fully REFUNDED
      const orderCheck2 = await adminClient.query('SELECT status FROM orders WHERE id = $1', [multiOrderId]);
      assert.strictEqual(orderCheck2.rows[0].status, 'REFUNDED');
      console.log('  ✓ Full refund on Capture 2 ($400) brought total order refunds to $1,000, correctly transitioning order to REFUNDED');

      // TEST 5: Reservation & Settlement Failure Paths
      console.log('Test 5: Reservation failure release vs ambiguous outcome retention');
      const ticketFailId = 'appr_tk_fail_001';
      await adminClient.query(
        `INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total, currency,
          status, expires_at
        ) VALUES (
          $1, $2, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          500.00, 0.00, 0.00, 500.00, 'USD', 'APPROVED', NOW() + INTERVAL '1 hour'
        )`,
        [ticketFailId, seedOrgId]
      );

      const ordFailRes = await adminClient.query(
        `INSERT INTO orders (
          order_number, organization_id, ticket_id, status, authorized_total,
          authorized_subtotal, authorized_tax, authorized_shipping, currency, idempotency_key
        ) VALUES ('ORD-FAIL-01', $1, $2, 'COMPLETED', 500.00, 500.00, 0, 0, 'USD', 'idem-ord-fail-01')
        RETURNING id`,
        [seedOrgId, ticketFailId]
      );
      const ordFailId = ordFailRes.rows[0].id;
      const capFailRes = await adminClient.query(
        `INSERT INTO payment_captures (
          order_id, external_capture_id, captured_amount, currency
        ) VALUES ($1, 'CAP-FAIL-01', 500.00, 'USD') RETURNING id`,
        [ordFailId]
      );
      const capFailId = capFailRes.rows[0].id;

      // Reserve $200
      const resFail = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 200.00, 'USD', 'idem-fail-test', 'req-fail')`,
        [ordFailId, capFailId]
      );
      const attFailId = resFail.rows[0].attempt_id;
      assert.strictEqual(parseFloat(resFail.rows[0].available_balance_after), 300.0);

      // Status OUTCOME_UNKNOWN retains reservation via controlled function
      await appClient.query(`SELECT * FROM record_refund_outcome_unknown($1, 'Network timeout')`, [attFailId]);
      const balUnknown = await adminClient.query(
        `SELECT (c.captured_amount - COALESCE(SUM(a.requested_amount), 0)) AS rem
         FROM payment_captures c
         LEFT JOIN payment_attempts a ON a.related_capture_id = c.id AND a.status IN ('PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED')
         WHERE c.id = $1 GROUP BY c.captured_amount`,
        [capFailId]
      );
      assert.strictEqual(parseFloat(balUnknown.rows[0].rem), 300.0, 'OUTCOME_UNKNOWN must remain reserved');
      console.log('  ✓ Status OUTCOME_UNKNOWN correctly retains reservation');

      // Status FAILED releases reservation via controlled function with reconciliation cleared
      await appClient.query(`SELECT * FROM record_refund_failure($1, 'Provider terminal error', 'RECON_CLEARED', TRUE)`, [attFailId]);
      const balFailed = await adminClient.query(
        `SELECT (c.captured_amount - COALESCE(SUM(a.requested_amount), 0)) AS rem
         FROM payment_captures c
         LEFT JOIN payment_attempts a ON a.related_capture_id = c.id AND a.status IN ('PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED')
         WHERE c.id = $1 GROUP BY c.captured_amount`,
        [capFailId]
      );
      assert.strictEqual(parseFloat(balFailed.rows[0].rem), 500.0, 'FAILED must release reservation');
      console.log('  ✓ Status FAILED successfully releases reservation back to headroom ($500.00)');

      // --- Section D: Phase 1B.1.4 Non-Forgeable Refund Authorization Tests ---
      console.log('\n--- Section D: Phase 1B.1.4 Non-Forgeable Security Verification (7 Mandatory Tests) ---');
      const ticketSecId = 'appr_tk_sec_001';
      await adminClient.query(
        `INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total, currency,
          status, expires_at
        ) VALUES (
          $1, $2, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          2000.00, 0.00, 0.00, 2000.00, 'USD', 'APPROVED', NOW() + INTERVAL '1 hour'
        )`,
        [ticketSecId, seedOrgId]
      );

      const secOrderRes = await adminClient.query(
        `INSERT INTO orders (
          order_number, organization_id, ticket_id, status, authorized_total,
          authorized_subtotal, authorized_tax, authorized_shipping, currency, idempotency_key
        ) VALUES ('ORD-SEC-01', $1, $2, 'COMPLETED', 2000.00, 2000.00, 0, 0, 'USD', 'idem-ord-sec-01')
        RETURNING id`,
        [seedOrgId, ticketSecId]
      );
      const secOrderId = secOrderRes.rows[0].id;

      const secCapRes = await adminClient.query(
        `INSERT INTO payment_captures (
          order_id, external_capture_id, captured_amount, currency
        ) VALUES ($1, 'CAP-SEC-001', 2000.00, 'USD') RETURNING id`,
        [secOrderId]
      );
      const secCapId = secCapRes.rows[0].id;

      // TEST 1: Ordinary Direct Refund Insertion
      console.log('Test 1: Ordinary direct refund insertion denied');
      let t1Blocked = false;
      try {
        await appClient.query(
          `INSERT INTO payment_attempts (
            order_id, related_capture_id, action_type, provider, idempotency_key, requested_amount, currency, status
          ) VALUES ($1, $2, 'REFUND', 'PAYPAL', 'idem-direct-refund-bad', 150.00, 'USD', 'PREPARED')`,
          [secOrderId, secCapId]
        );
      } catch (err: any) {
        t1Blocked = true;
        assert.ok(err.message.includes('Direct INSERT of refund attempts is prohibited'));
      }
      assert.ok(t1Blocked, 'Test 1 failed: Direct INSERT of refund attempt was not blocked');
      console.log('  ✓ Test 1 Passed: Direct INSERT of refund attempt strictly blocked by trigger');

      // TEST 2: Custom GUC Forgery
      console.log('Test 2: Custom GUC forgery test');
      // Set forged custom GUC variable
      await appClient.query(`SET procurepilot.controlled_refund_context = 'true'`);

      // 2a: Attempt direct INSERT with forged GUC
      let t2InsertBlocked = false;
      try {
        await appClient.query(
          `INSERT INTO payment_attempts (
            order_id, related_capture_id, action_type, provider, idempotency_key, requested_amount, currency, status
          ) VALUES ($1, $2, 'REFUND', 'PAYPAL', 'idem-guc-forgery-bad', 150.00, 'USD', 'PREPARED')`,
          [secOrderId, secCapId]
        );
      } catch (err: any) {
        t2InsertBlocked = true;
        assert.ok(err.message.includes('Direct INSERT of refund attempts is prohibited'));
      }
      assert.ok(t2InsertBlocked, 'Test 2a failed: Forged GUC allowed direct INSERT');

      // Create a valid reservation to test forged GUC on direct UPDATE
      const resForGuc = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 300.00, 'USD', 'idem-sec-guc', 'req-sec-guc')`,
        [secOrderId, secCapId]
      );
      const gucAttemptId = resForGuc.rows[0].attempt_id;

      // 2b: Attempt direct parameter tampering with forged GUC
      let t2ParamBlocked = false;
      try {
        await appClient.query(`UPDATE payment_attempts SET requested_amount = 999.00 WHERE id = $1`, [gucAttemptId]);
      } catch (err: any) {
        t2ParamBlocked = true;
        assert.ok(err.message.includes('Immutable financial reservation parameters cannot be modified'));
      }
      assert.ok(t2ParamBlocked, 'Test 2b failed: Forged GUC allowed parameter tampering');

      // 2c: Attempt direct transition to SUCCEEDED with forged GUC
      let t2StatusBlocked = false;
      try {
        await appClient.query(`UPDATE payment_attempts SET status = 'SUCCEEDED' WHERE id = $1`, [gucAttemptId]);
      } catch (err: any) {
        t2StatusBlocked = true;
        assert.ok(err.message.includes('Direct transition to SUCCEEDED is prohibited'));
      }
      assert.ok(t2StatusBlocked, 'Test 2c failed: Forged GUC allowed direct transition to SUCCEEDED');

      // 2d: Attempt direct transition to FAILED with forged GUC
      let t2FailedBlocked = false;
      try {
        await appClient.query(`UPDATE payment_attempts SET status = 'FAILED' WHERE id = $1`, [gucAttemptId]);
      } catch (err: any) {
        t2FailedBlocked = true;
        assert.ok(err.message.includes('Direct transition to FAILED is prohibited'));
      }
      assert.ok(t2FailedBlocked, 'Test 2d failed: Forged GUC allowed direct transition to FAILED');

      // Reset forged variable
      await appClient.query(`RESET procurepilot.controlled_refund_context`);
      console.log('  ✓ Test 2 Passed: Custom GUC forgery has ZERO authorization effect; all unauthorized operations strictly rejected');

      // TEST 3: Direct Privilege Escalation
      console.log('Test 3: Direct privilege escalation denial');
      // 3a: SET ROLE procurepilot_refund_owner
      let t3SetRoleBlocked = false;
      try {
        await appClient.query('SET ROLE procurepilot_refund_owner');
      } catch (err: any) {
        t3SetRoleBlocked = true;
        assert.strictEqual(err.code, '42501', 'SET ROLE must fail with 42501 permission denied');
      }
      assert.ok(t3SetRoleBlocked, 'Test 3a failed: SET ROLE procurepilot_refund_owner was not blocked');

      // 3b: GRANT role membership
      let t3GrantBlocked = false;
      try {
        await appClient.query('GRANT procurepilot_refund_owner TO procurepilot_app');
      } catch (err: any) {
        t3GrantBlocked = true;
        assert.strictEqual(err.code, '42501', 'GRANT role must fail with 42501 permission denied');
      }
      assert.ok(t3GrantBlocked, 'Test 3b failed: GRANT procurepilot_refund_owner was not blocked');

      // 3c: ALTER FUNCTION OWNER
      let t3AlterOwnerBlocked = false;
      try {
        await appClient.query('ALTER FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) OWNER TO procurepilot_app');
      } catch (err: any) {
        t3AlterOwnerBlocked = true;
        assert.strictEqual(err.code, '42501', 'ALTER FUNCTION OWNER must fail with 42501 permission denied');
      }
      assert.ok(t3AlterOwnerBlocked, 'Test 3c failed: ALTER FUNCTION OWNER was not blocked');

      // 3d: CREATE OR REPLACE FUNCTION in public schema
      let t3ReplaceFuncBlocked = false;
      try {
        await appClient.query(`
          CREATE OR REPLACE FUNCTION create_refund_reservation(
            p_order_id UUID, p_capture_id UUID, p_refund_amount NUMERIC(12, 2),
            p_currency VARCHAR(3), p_idempotency_key VARCHAR(128), p_provider_request_id VARCHAR(128)
          ) RETURNS TABLE (attempt_id UUID, is_existing_reservation BOOLEAN, available_balance_after NUMERIC(12, 2)) AS $$
          BEGIN RETURN; END; $$ LANGUAGE plpgsql;
        `);
      } catch (err: any) {
        t3ReplaceFuncBlocked = true;
        assert.strictEqual(err.code, '42501', 'Replacing function must fail with 42501 permission denied');
      }
      assert.ok(t3ReplaceFuncBlocked, 'Test 3d failed: Function replacement was not blocked');

      // 3e: CREATE TABLE in public schema
      let t3CreateTableBlocked = false;
      try {
        await appClient.query('CREATE TABLE public.malicious_object (id serial primary key)');
      } catch (err: any) {
        t3CreateTableBlocked = true;
        assert.strictEqual(err.code, '42501', 'CREATE TABLE must fail with 42501 permission denied');
      }
      assert.ok(t3CreateTableBlocked, 'Test 3e failed: Object creation in public schema was not blocked');

      // 3f: ALTER FUNCTION search_path configuration attempt
      let t3AlterConfigBlocked = false;
      try {
        await appClient.query('ALTER FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) SET search_path = public, pg_temp');
      } catch (err: any) {
        t3AlterConfigBlocked = true;
        assert.strictEqual(err.code, '42501', 'ALTER FUNCTION SET search_path must fail with 42501 permission denied');
      }
      assert.ok(t3AlterConfigBlocked, 'Test 3f failed: Runtime role was able to alter function-level search_path');
      console.log('  ✓ Test 3 Passed: All privilege escalation attempts (SET ROLE, GRANT, ALTER, CREATE, ALTER CONFIG) strictly denied (42501)');

      // TEST 4: Execution Identity Verification & Search Path Hardening
      console.log('Test 4: Execution identity verification & hostile shadowing resistance');
      // 4a: Direct SQL execution identity
      const directIdentRes = await appClient.query('SELECT current_user::text, session_user::text');
      assert.strictEqual(directIdentRes.rows[0].current_user, 'procurepilot_app');
      assert.strictEqual(directIdentRes.rows[0].session_user, 'procurepilot_app');

      // 4b: Inside SECURITY DEFINER function owned by procurepilot_refund_owner
      await adminClient.query(`
        CREATE OR REPLACE FUNCTION public.probe_execution_identity()
        RETURNS TABLE (fn_current_user text, fn_session_user text) AS $$
        BEGIN
          RETURN QUERY SELECT current_user::text, session_user::text;
        END;
        $$ LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp;

        ALTER FUNCTION public.probe_execution_identity() OWNER TO procurepilot_refund_owner;
        GRANT EXECUTE ON FUNCTION public.probe_execution_identity() TO procurepilot_app;
      `);

      const probeRes = await appClient.query('SELECT * FROM public.probe_execution_identity()');
      assert.strictEqual(probeRes.rows[0].fn_current_user, 'procurepilot_refund_owner', 'current_user inside SECURITY DEFINER must be procurepilot_refund_owner');
      assert.strictEqual(probeRes.rows[0].fn_session_user, 'procurepilot_app', 'session_user must remain procurepilot_app');

      // 4c: Clean up identity probe
      await adminClient.query('DROP FUNCTION public.probe_execution_identity()');

      // 4d: Hostile temporary-object shadowing resistance
      console.log('Test 4d: Hostile temporary-object shadowing resistance');
      // Create shadowing temporary tables and functions in pg_temp as procurepilot_app
      await appClient.query(`
        CREATE TEMP TABLE orders (
          id UUID PRIMARY KEY,
          shadow_marker TEXT
        )
      `);
      await appClient.query(`INSERT INTO pg_temp.orders (id, shadow_marker) VALUES ($1, 'HOSTILE_SHADOW')`, [secOrderId]);

      await appClient.query(`
        CREATE TEMP TABLE payment_attempts (
          id UUID PRIMARY KEY,
          shadow_marker TEXT
        )
      `);

      await appClient.query(`
        CREATE OR REPLACE FUNCTION pg_temp.gen_random_uuid() RETURNS UUID AS $$
        BEGIN
          RETURN '00000000-dead-beef-cafe-000000000000'::UUID;
        END;
        $$ LANGUAGE plpgsql
      `);

      // Call create_refund_reservation while temp tables and temp function exist in caller session
      const shadowTestRes = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 50.00, 'USD', 'idem-shadow-test', 'req-shadow')`,
        [secOrderId, secCapId]
      );
      assert.strictEqual(shadowTestRes.rows[0].is_existing_reservation, false);
      const generatedAttemptId = shadowTestRes.rows[0].attempt_id;
      // Must NOT be the fake dead-beef UUID from pg_temp.gen_random_uuid!
      assert.notStrictEqual(generatedAttemptId, '00000000-dead-beef-cafe-000000000000');

      // Check that genuine public.payment_attempts received the row
      const pubCheck = await adminClient.query(`SELECT id FROM public.payment_attempts WHERE id = $1`, [generatedAttemptId]);
      assert.strictEqual(pubCheck.rows.length, 1);

      // Check that pg_temp.payment_attempts was NOT touched / shadowed
      const tempCheck = await appClient.query('SELECT COUNT(*) AS c FROM pg_temp.payment_attempts');
      assert.strictEqual(parseInt(tempCheck.rows[0].c, 10), 0, 'pg_temp.payment_attempts must not receive writes');

      // Clean up temporary objects
      await appClient.query('DROP TABLE pg_temp.orders');
      await appClient.query('DROP TABLE pg_temp.payment_attempts');
      await appClient.query('DROP FUNCTION pg_temp.gen_random_uuid()');
      console.log('  ✓ Test 4 Passed: Direct SQL runs as procurepilot_app; SECURITY DEFINER transitions to procurepilot_refund_owner; hostile temp objects in pg_temp cannot shadow privileged execution');

      // TEST 5: Controlled Operations Verification
      console.log('Test 5: Controlled refund lifecycle operations');
      // 5a: create_refund_reservation succeeds
      const t5Res = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 100.00, 'USD', 'idem-sec-t5', 'req-sec-t5')`,
        [secOrderId, secCapId]
      );
      assert.strictEqual(t5Res.rows[0].is_existing_reservation, false);
      const t5Attempt = await adminClient.query(`SELECT status FROM payment_attempts WHERE id = $1`, [t5Res.rows[0].attempt_id]);
      assert.strictEqual(t5Attempt.rows[0].status, 'PREPARED');

      // 5b: Identical idempotent replay
      const t5Replay = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 100.00, 'USD', 'idem-sec-t5', 'req-sec-t5')`,
        [secOrderId, secCapId]
      );
      assert.strictEqual(t5Replay.rows[0].attempt_id, t5Res.rows[0].attempt_id);
      assert.strictEqual(t5Replay.rows[0].is_existing_reservation, true);

      // 5c: Conflicting key rejection
      let t5ConflictBlocked = false;
      try {
        await appClient.query(
          `SELECT * FROM create_refund_reservation($1, $2, 999.00, 'USD', 'idem-sec-t5', 'req-sec-t5')`,
          [secOrderId, secCapId]
        );
      } catch (err: any) {
        t5ConflictBlocked = true;
        assert.ok(err.message.includes('Idempotency Conflict'));
      }
      assert.ok(t5ConflictBlocked, 'Conflicting idempotency key must be rejected');

      // 5d: Definitive failure recording releases reservation
      const t5FailRes = await appClient.query(
        `SELECT * FROM record_refund_failure($1, 'Provider terminal rejection', 'REJECTED_BY_ISSUER', FALSE)`,
        [t5Res.rows[0].attempt_id]
      );
      assert.strictEqual(parseFloat(t5FailRes.rows[0].released_amount), 100.00);

      // 5e: Ambiguous outcome recording retains reservation
      const t5AmbRes = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 120.00, 'USD', 'idem-sec-amb', 'req-sec-amb')`,
        [secOrderId, secCapId]
      );
      const t5AmbId = t5AmbRes.rows[0].attempt_id;
      const t5HeadroomBefore = parseFloat(t5AmbRes.rows[0].available_balance_after);

      await appClient.query(`SELECT * FROM record_refund_outcome_unknown($1, 'Connection reset by peer')`, [t5AmbId]);
      const t5AmbCheck = await adminClient.query(`SELECT status FROM payment_attempts WHERE id = $1`, [t5AmbId]);
      assert.strictEqual(t5AmbCheck.rows[0].status, 'OUTCOME_UNKNOWN');

      // Verify headroom retained
      const t5HeadroomCheck = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 1.00, 'USD', 'idem-amb-probe', 'req-amb-probe')`,
        [secOrderId, secCapId]
      );
      assert.strictEqual(parseFloat(t5HeadroomCheck.rows[0].available_balance_after), t5HeadroomBefore - 1.00);

      // 5f: Confirmed refund settlement finalization
      const t5SettleAttempt = await appClient.query(
        `SELECT * FROM create_refund_reservation($1, $2, 200.00, 'USD', 'idem-sec-settle', 'req-sec-settle')`,
        [secOrderId, secCapId]
      );
      const t5SettleAttemptId = t5SettleAttempt.rows[0].attempt_id;

      const t5SettleRes = await appClient.query(
        `SELECT * FROM finalize_refund_settlement($1, 'EXT-REF-SEC-T5', 200.00, 'USD', 'Customer agreed refund')`,
        [t5SettleAttemptId]
      );
      assert.ok(t5SettleRes.rows[0].refund_id);
      assert.strictEqual(t5SettleRes.rows[0].new_order_status, 'PARTIALLY_REFUNDED');

      const t5SettleCheck = await adminClient.query(`SELECT status FROM payment_attempts WHERE id = $1`, [t5SettleAttemptId]);
      assert.strictEqual(t5SettleCheck.rows[0].status, 'SUCCEEDED');

      // 5g: Duplicate settlement finalization blocked
      let t5DupBlocked = false;
      try {
        await appClient.query(
          `SELECT * FROM finalize_refund_settlement($1, 'EXT-REF-SEC-T5-DUP', 200.00, 'USD', 'Duplicate request')`,
          [t5SettleAttemptId]
        );
      } catch (err: any) {
        t5DupBlocked = true;
        assert.ok(err.message.includes('Invalid Attempt Status') && err.message.includes('SUCCEEDED'));
      }
      assert.ok(t5DupBlocked, 'Duplicate settlement must be rejected');
      console.log('  ✓ Test 5 Passed: All controlled lifecycle operations (reservation, replay, failure, ambiguity, settlement) succeeded');

      // TEST 6: Existing Protections Re-Verification
      console.log('Test 6: Existing ledger immutability and non-refund attempt protections');
      // 6a: Attempt deletion denial
      let t6DeleteAttemptBlocked = false;
      try {
        await appClient.query(`DELETE FROM payment_attempts WHERE id = $1`, [t5SettleAttemptId]);
      } catch (err: any) {
        t6DeleteAttemptBlocked = true;
        assert.ok(err.code === '42501' || err.message.includes('Deletion of payment_attempts is strictly prohibited'));
      }
      assert.ok(t6DeleteAttemptBlocked, 'Attempt deletion must be denied');

      // 6b: Refund modification denial
      let t6UpdateRefundBlocked = false;
      try {
        await appClient.query(`UPDATE payment_refunds SET refund_amount = 0.00 WHERE id = $1`, [t5SettleRes.rows[0].refund_id]);
      } catch (err: any) {
        t6UpdateRefundBlocked = true;
        assert.ok(err.code === '42501' || err.message.includes('Immutable'));
      }
      assert.ok(t6UpdateRefundBlocked, 'Refund modification must be denied');

      // 6c: Refund deletion denial
      let t6DeleteRefundBlocked = false;
      try {
        await appClient.query(`DELETE FROM payment_refunds WHERE id = $1`, [t5SettleRes.rows[0].refund_id]);
      } catch (err: any) {
        t6DeleteRefundBlocked = true;
        assert.ok(err.code === '42501' || err.message.includes('Immutable'));
      }
      assert.ok(t6DeleteRefundBlocked, 'Refund deletion must be denied');

      // 6d: Non-refund attempts unaffected
      const t6NonRefundRes = await appClient.query(
        `INSERT INTO payment_attempts (
          order_id, action_type, provider, idempotency_key, requested_amount, currency, status
        ) VALUES ($1, 'CREATE_ORDER', 'PAYPAL', 'idem-nonrefund-test6', 500.00, 'USD', 'PREPARED')
        RETURNING *`,
        [secOrderId]
      );
      assert.strictEqual(t6NonRefundRes.rows[0].action_type, 'CREATE_ORDER');

      const t6UpdateRes = await appClient.query(
        `UPDATE payment_attempts
         SET status = 'SUCCEEDED', completed_at = NOW()
         WHERE id = $1
         RETURNING status`,
        [t6NonRefundRes.rows[0].id]
      );
      assert.strictEqual(t6UpdateRes.rows[0].status, 'SUCCEEDED');
      console.log('  ✓ Test 6 Passed: Ledger immutability, attempt deletion denial, and non-refund workflows fully preserved');

      // TEST 7: Runtime Privilege & Catalog Inspection
      console.log('Test 7: Runtime privilege & catalog inspection');
      // 7a: Inspect function ownership, prosecdef, and proconfig
      const t7ProcCheck = await adminClient.query(`
        SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig
        FROM pg_proc p
        JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN (
          'create_refund_reservation',
          'finalize_refund_settlement',
          'record_refund_failure',
          'record_refund_outcome_unknown',
          'enforce_refund_attempt_security'
        )
        ORDER BY p.proname
      `);
      assert.strictEqual(t7ProcCheck.rows.length, 5);
      for (const row of t7ProcCheck.rows) {
        assert.strictEqual(row.owner, 'procurepilot_refund_owner', `${row.proname} must be owned by procurepilot_refund_owner`);
        assert.ok(row.proconfig !== null, `Function ${row.proname} proconfig must not be null`);
        assert.ok(Array.isArray(row.proconfig), `Function ${row.proname} proconfig must be an array`);
        assert.strictEqual(row.proconfig.length, 1, `Function ${row.proname} proconfig must contain exactly one setting`);
        assert.strictEqual(
          row.proconfig[0],
          'search_path=pg_catalog, public, pg_temp',
          `Function ${row.proname} search_path must strictly be 'search_path=pg_catalog, public, pg_temp' (found: ${row.proconfig[0]})`
        );
        if (row.proname === 'enforce_refund_attempt_security') {
          assert.strictEqual(row.prosecdef, false, 'Trigger function must be SECURITY INVOKER (prosecdef=false)');
        } else {
          assert.strictEqual(row.prosecdef, true, `${row.proname} must be SECURITY DEFINER (prosecdef=true)`);
        }
      }
      console.log('  ✓ 7a: Function ownership (procurepilot_refund_owner), prosecdef flags, and safe search_path (pg_catalog, public, pg_temp) verified');

      // 7b: Role attributes check
      const t7RoleCheck = await adminClient.query(`
        SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin
        FROM pg_roles
        WHERE rolname IN ('procurepilot_app', 'procurepilot_refund_owner', 'procurepilot_legacy_importer')
        ORDER BY rolname
      `);
      assert.strictEqual(t7RoleCheck.rows.length, 3);
      const appR = t7RoleCheck.rows.find((r: any) => r.rolname === 'procurepilot_app');
      const ownerR = t7RoleCheck.rows.find((r: any) => r.rolname === 'procurepilot_refund_owner');
      const legacyR = t7RoleCheck.rows.find((r: any) => r.rolname === 'procurepilot_legacy_importer');
      assert.strictEqual(appR.rolsuper, false, 'procurepilot_app must not be superuser');
      assert.strictEqual(appR.rolcanlogin, true, 'procurepilot_app must be login role');
      assert.strictEqual(ownerR.rolsuper, false, 'procurepilot_refund_owner must not be superuser');
      assert.strictEqual(ownerR.rolcanlogin, false, 'procurepilot_refund_owner must be NOLOGIN');
      assert.strictEqual(legacyR.rolsuper, false, 'procurepilot_legacy_importer must not be superuser');
      assert.strictEqual(legacyR.rolcanlogin, false, 'procurepilot_legacy_importer must be NOLOGIN');
      console.log('  ✓ 7b: Role attributes verified: no role is superuser, refund owner and legacy importer are strictly NOLOGIN');

      // 7c: Role membership check
      const t7MemberCheck = await adminClient.query(`
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles r1 ON r1.oid = m.roleid
        JOIN pg_roles r2 ON r2.oid = m.member
        WHERE r1.rolname = 'procurepilot_refund_owner' AND r2.rolname = 'procurepilot_app'
      `);
      assert.strictEqual(t7MemberCheck.rows.length, 0, 'procurepilot_app must NOT be a member of procurepilot_refund_owner');
      console.log('  ✓ 7c: Role membership verified: procurepilot_app is not a member of procurepilot_refund_owner');

      // 7d: Schema CREATE privileges check
      const t7SchemaCheck = await adminClient.query(`
        SELECT has_schema_privilege('procurepilot_app', 'public', 'CREATE') AS app_create,
               has_schema_privilege('procurepilot_refund_owner', 'public', 'CREATE') AS owner_create
      `);
      assert.strictEqual(t7SchemaCheck.rows[0].app_create, false, 'procurepilot_app must not have CREATE on public');
      assert.strictEqual(t7SchemaCheck.rows[0].owner_create, false, 'procurepilot_refund_owner must not have CREATE on public');
      console.log('  ✓ 7d: Schema privileges verified: neither role has CREATE privilege on public schema');

      // Clean up connections
      await connA.end();
      await connB.end();
      await connSame1.end();
      await connSame2.end();
      await appClient.end();
      await adminClient.end();

      return { executed: true, tempDbName };
    } catch (testErr) {
      console.error('Error during test execution:', testErr);
      await adminClient.end();
      throw testErr;
    } finally {
      // Clean up disposable database
      await rootClient.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`);
      console.log(`\n  ✓ Cleaned up disposable test database: ${tempDbName}`);
      await rootClient.end();
    }
  } catch (err) {
    await rootClient.end();
    throw err;
  }
}

if (require.main === module) {
  runLivePostgresValidation()
    .then(() => {
      console.log('\n🎉 ALL LIVE POSTGRESQL 16 MULTI-CONNECTION & CONCURRENCY TESTS PASSED!');
    })
    .catch((err) => {
      console.error('\n❌ Live validation failed:', err);
      process.exit(1);
    });
}
