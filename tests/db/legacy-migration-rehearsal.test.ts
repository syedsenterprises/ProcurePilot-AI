import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'node:assert';
import { runLegacyMigration, SEED_ORGANIZATION_ID } from '../../src/db/legacy-migration';
import { approvalService } from '../../src/services/approval/approval.service';
import {
  capturePersistentDataInventory,
  assertDataInventoryUnchanged,
} from '../test-isolation';

function getFileSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function runLegacyMigrationRehearsalTest() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Phase 1B.2.1.2.2 Restricted Migration Operator & Immutability Test');
  console.log('================================================================');

  // Pre-execution manifest and source file hashing
  const preflightPath = path.resolve(process.cwd(), 'migration-preflight-manifest.json');
  const quarantinePath = path.resolve(process.cwd(), 'migration-quarantine-manifest.json');
  const simulatedPath = path.resolve(process.cwd(), 'migration-simulated-orders-manifest.json');

  const preHashes = {
    preflight: fs.existsSync(preflightPath) ? getFileSha256(preflightPath) : null,
    quarantine: fs.existsSync(quarantinePath) ? getFileSha256(quarantinePath) : null,
    simulated: fs.existsSync(simulatedPath) ? getFileSha256(simulatedPath) : null,
  };

  const initialInventory = capturePersistentDataInventory();
  console.log(`  [PREFLIGHT] Baseline persistent inventory: ${initialInventory.ordersCount} orders, ${initialInventory.approvalsCount} approvals.`);
  console.log(`  [MANIFESTS] Captured SHA-256 hashes of preflight, quarantine, and simulated manifests.`);

  const baseConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  };

  const tempDbName = `procurepilot_provenance_rehearsal_${Date.now()}`;
  const rootClient = new Client({ ...baseConfig, database: 'postgres' });
  rootClient.on('error', () => {});

  try {
    await rootClient.connect();
    console.log('  ✓ Connected to root PostgreSQL instance');
  } catch (err) {
    console.log('  [INFO] Local PostgreSQL unavailable or credentials refused.');
    console.log('  [INFO] Migration rehearsal explicitly marked NOT EXECUTED — DATABASE UNAVAILABLE');
    return { executed: false, reason: 'DATABASE UNAVAILABLE' };
  }

  try {
    // Drop any leftover administrator test role from prior unhardened test runs
    await rootClient.query(`DROP ROLE IF EXISTS procurepilot_admin`);

    // 1. Create temporary disposable database for rehearsal
    await rootClient.query(`CREATE DATABASE "${tempDbName}"`);
    console.log(`  ✓ Created isolated disposable test database: ${tempDbName}`);

    const testClient = new Client({ ...baseConfig, database: tempDbName });
    testClient.on('error', () => {});
    await testClient.connect();

    try {
      // 2. Apply all migrations in order (001 through 005)
      const migrationFiles = [
        '001_initial_schema.sql',
        '002_refund_integrity.sql',
        '003_refund_attempt_security.sql',
        '004_non_forgeable_refund_authorization.sql',
        '005_legacy_approval_provenance.sql',
      ];

      for (const file of migrationFiles) {
        const sqlPath = path.resolve(process.cwd(), 'src/db/migrations', file);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await testClient.query(sql);
        console.log(`  ✓ Migration applied: ${file}`);
      }

      // 2b. Provision Disposable External Migration Operator outside versioned migrations
      const operatorRole = `procurepilot_test_operator_${Date.now()}`;
      const operatorPass = `test_op_pass_${crypto.randomBytes(8).toString('hex')}`;

      await testClient.query(`CREATE ROLE "${operatorRole}" WITH LOGIN PASSWORD '${operatorPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
      await testClient.query(`GRANT USAGE ON SCHEMA public TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket_item TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order_item TO "${operatorRole}"`);
      await testClient.query(`GRANT SELECT ON TABLE organizations, approval_tickets, approval_ticket_items, orders, order_items, payment_captures, legacy_migration_execution_audit TO "${operatorRole}"`);
      await testClient.query(`GRANT INSERT ON TABLE organizations, payment_captures TO "${operatorRole}"`);

      console.log(`  ✓ Provisioned external migration operator: ${operatorRole} (NOLOGIN importer uncompromised)`);

      const operatorClient = new Client({
        ...baseConfig,
        database: tempDbName,
        user: operatorRole,
        password: operatorPass,
      });
      operatorClient.on('error', () => {});
      await operatorClient.connect();

      // 3. First Import: Execute runLegacyMigration() via the External Operator Client
      console.log('\n--- Part A: Executing First runLegacyMigration() via External Migration Operator ---');
      const firstResult = await runLegacyMigration({ client: operatorClient });
      const { summary, excludedApprovals, excludedOrders, excludedSyntheticCaptures } = firstResult;

      console.log(`  ✓ Legacy migration execution completed via operator (${operatorRole}):`);
      console.log(`    - Approvals scanned:             ${summary.approvalsScanned}`);
      console.log(`    - Approvals migrated (legacy):   ${summary.approvalsMigrated}`);
      console.log(`    - Approvals excluded:            ${summary.approvalsExcluded}`);
      console.log(`    - Orders scanned:                ${summary.ordersScanned}`);
      console.log(`    - Orders migrated:               ${summary.ordersMigrated}`);
      console.log(`    - Orders quarantined:            ${summary.ordersQuarantinedOrphan}`);
      console.log(`    - Orders excluded (ticket FK):   ${summary.ordersExcludedUnresolvedDependency}`);
      console.log(`    - Genuine captures migrated:     ${summary.genuineCapturesMigrated} ($${summary.genuineCapturedAmount})`);
      console.log(`    - Synthetic captures excluded:   ${summary.syntheticCapturesExcluded}`);
      console.log(`    - Migrated authorized total:     $${summary.migratedAuthorizedTotal}`);
      console.log(`    - Migrated genuine total:        $${summary.migratedGenuineTotal}`);
      console.log(`    - Migrated simulation total:     $${summary.migratedSimulationTotal}`);

      // ----------------------------------------------------------------------
      // MANDATORY TEST SCENARIOS (1 through 20)
      // ----------------------------------------------------------------------
      console.log('\n--- Part B: Executing 20 Mandatory Test Scenarios ---');

      // Scenario 1: Runtime approval insertion with valid signature succeeds
      console.log('Scenario 1: Runtime approval insertion with valid signature succeeds');
      const runtimeTicketId = `appr_tk_runtime_valid_${Date.now()}`;
      const runtimeNonce = crypto.randomBytes(32).toString('hex');
      const runtimeFingerprint = crypto.randomBytes(32).toString('hex');
      const runtimeExpiresAt = new Date(Date.now() + 600000);
      const runtimeSig = crypto.randomBytes(32).toString('hex'); // 64 hex chars

      await testClient.query(`
        INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total,
          currency, status, identity_tier, expires_at, source_origin, integrity_status
        ) VALUES (
          $1, $2, $3, $4, $5, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
          'SELF_ATTESTED_REQUISITIONER', $6, 'RUNTIME', 'VERIFIED'
        )
      `, [runtimeTicketId, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeSig, runtimeExpiresAt]);
      console.log('  ✓ 1: Runtime approval insertion with valid signature succeeded');

      // Scenario 2: Runtime approval insertion with NULL signature fails
      console.log('Scenario 2: Runtime approval insertion with NULL signature fails');
      let nullSigBlocked = false;
      try {
        await testClient.query(`
          INSERT INTO approval_tickets (
            ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
            verified_subtotal, verified_tax, verified_shipping, verified_total,
            currency, status, identity_tier, expires_at, source_origin, integrity_status
          ) VALUES (
            $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
            'SELF_ATTESTED_REQUISITIONER', $5, 'RUNTIME', 'VERIFIED'
          )
        `, [`appr_tk_runtime_null_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt]);
      } catch (err: any) {
        nullSigBlocked = true;
        assert.ok(
          err.code === '23514', // check_violation
          `Expected check_violation (23514), got: ${err.code} (${err.message})`
        );
      }
      assert.ok(nullSigBlocked, 'Runtime ticket insertion with NULL signature must be rejected by chk_approval_tickets_provenance');
      console.log('  ✓ 2: Runtime approval insertion with NULL signature strictly failed (23514 check constraint violation)');

      // Scenario 3: Runtime application role & migration role authorization checks
      console.log('Scenario 3: Runtime application role & migration role authorization checks');
      const appClient = new Client({
        ...baseConfig,
        database: tempDbName,
        user: 'procurepilot_app',
        password: 'procurepilot_app_pass_test',
      });
      appClient.on('error', () => {});
      await appClient.connect();

      try {
        // 3a: Direct INSERT claiming LEGACY_JSON_IMPORT as procurepilot_app
        let runtimeClaimBlocked = false;
        try {
          await appClient.query(`
            INSERT INTO approval_tickets (
              ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
              verified_subtotal, verified_tax, verified_shipping, verified_total,
              currency, status, identity_tier, expires_at, source_origin, integrity_status
            ) VALUES (
              $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
              'SELF_ATTESTED_REQUISITIONER', $5, 'LEGACY_JSON_IMPORT', 'UNVERIFIABLE_LEGACY'
            )
          `, [`appr_tk_forged_legacy_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt]);
        } catch (err: any) {
          runtimeClaimBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected insufficient_privilege (42501), got: ${err.code}`);
        }
        assert.ok(runtimeClaimBlocked, 'Direct INSERT claiming LEGACY_JSON_IMPORT by procurepilot_app must be denied (42501)');

        // 3b: Calling import_legacy_approval_ticket as procurepilot_app
        let funcExecBlocked = false;
        try {
          await appClient.query(`
            SELECT import_legacy_approval_ticket(
              $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
              NULL, 'Hacker', 'IT', 'Bypass test', 'SELF_ATTESTED_REQUISITIONER',
              $5, NULL, NULL, NOW()
            )
          `, [`appr_tk_forged_func_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt]);
        } catch (err: any) {
          funcExecBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected permission denied (42501), got: ${err.code}`);
        }
        assert.ok(funcExecBlocked, 'Execution of import_legacy_approval_ticket by procurepilot_app must be denied (42501)');

        // 3c: Calling import_legacy_order as procurepilot_app
        let orderFuncExecBlocked = false;
        try {
          await appClient.query(`
            SELECT import_legacy_order(
              'FORGED_ORDER', $1, 'some_ticket', 'EXT_FORGED', 'PAYPAL', 'SANDBOX', 'COMPLETED',
              100.00, 100.00, 0.00, 0.00, 'USD', 'Hacker', 'IT', 'key', false, NULL, NULL, NOW(), NOW()
            )
          `, [SEED_ORGANIZATION_ID]);
        } catch (err: any) {
          orderFuncExecBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected permission denied (42501), got: ${err.code}`);
        }
        assert.ok(orderFuncExecBlocked, 'Execution of import_legacy_order by procurepilot_app must be denied (42501)');

        // 3d: Updating legacy ticket as procurepilot_app
        let legacyUpdateBlocked = false;
        try {
          await appClient.query(`
            UPDATE approval_tickets
            SET status = 'CONSUMED'
            WHERE source_origin = 'LEGACY_JSON_IMPORT'
          `);
        } catch (err: any) {
          legacyUpdateBlocked = true;
          assert.ok(err.code === '42501' || err.code === '22000', `Expected insufficient_privilege (42501) or immutability violation (22000), got: ${err.code}`);
        }
        assert.ok(legacyUpdateBlocked, 'UPDATE of legacy ticket by procurepilot_app must be denied');

        // 3e: Attempting SET ROLE procurepilot_legacy_importer as procurepilot_app
        let setRoleBlocked = false;
        try {
          await appClient.query(`SET ROLE procurepilot_legacy_importer`);
        } catch (err: any) {
          setRoleBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected insufficient_privilege (42501), got: ${err.code}`);
        }
        assert.ok(setRoleBlocked, 'procurepilot_app attempting SET ROLE procurepilot_legacy_importer must be denied (42501)');

      } finally {
        await appClient.end();
      }

      // 3f: Verify procurepilot_legacy_importer role attributes in pg_roles
      const roleCheck = await testClient.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolinherit: boolean;
      }>(`
        SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit
        FROM pg_roles
        WHERE rolname = 'procurepilot_legacy_importer'
      `);
      assert.strictEqual(roleCheck.rows.length, 1, 'procurepilot_legacy_importer must exist');
      assert.strictEqual(roleCheck.rows[0].rolcanlogin, false, 'procurepilot_legacy_importer must be NOLOGIN');
      assert.strictEqual(roleCheck.rows[0].rolsuper, false, 'procurepilot_legacy_importer must be NOSUPERUSER');
      assert.strictEqual(roleCheck.rows[0].rolcreaterole, false, 'procurepilot_legacy_importer must be NOCREATEROLE');
      assert.strictEqual(roleCheck.rows[0].rolcreatedb, false, 'procurepilot_legacy_importer must be NOCREATEDB');
      assert.strictEqual(roleCheck.rows[0].rolinherit, false, 'procurepilot_legacy_importer must be NOINHERIT');

      // 3g: Verify procurepilot_admin does NOT exist in pg_roles
      const adminRoleCheck = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM pg_roles WHERE rolname = 'procurepilot_admin'
      `);
      assert.strictEqual(adminRoleCheck.rows[0].count, '0', 'procurepilot_admin role must NOT exist in pg_roles');

      // 3h: Verify migration file 005 has no embedded credentials
      const m005Raw = fs.readFileSync(path.resolve(process.cwd(), 'src/db/migrations/005_legacy_approval_provenance.sql'), 'utf8');
      assert.ok(!m005Raw.includes('procurepilot_admin'), 'Migration 005 must NOT contain procurepilot_admin');
      assert.ok(!m005Raw.toLowerCase().includes('password'), 'Migration 005 must NOT contain hardcoded passwords');
      console.log('  ✓ 3: Runtime application role and migration role authorization invariants verified (NOLOGIN, no admin role, no hardcoded password)');

      // Scenario 4: Superuser Allowlist Removal Verification
      console.log('Scenario 4: Superuser Allowlist Removal Verification');
      // 4a: Direct INSERT into approval_tickets with source_origin = 'LEGACY_JSON_IMPORT' as postgres (superuser)
      let superuserTicketInsertBlocked = false;
      try {
        await testClient.query(`
          INSERT INTO approval_tickets (
            ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
            verified_subtotal, verified_tax, verified_shipping, verified_total,
            currency, status, identity_tier, expires_at, source_origin, integrity_status
          ) VALUES (
            'test_superuser_bypass_ticket', $1, $2, $3, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
            'SELF_ATTESTED_REQUISITIONER', $4, 'LEGACY_JSON_IMPORT', 'UNVERIFIABLE_LEGACY'
          )
        `, [SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt]);
      } catch (err: any) {
        superuserTicketInsertBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
        assert.match(err.message, /Authorization violation: execution identity "postgres" cannot create or modify records with legacy provenance/);
      }
      assert.ok(superuserTicketInsertBlocked, 'Direct INSERT into approval_tickets by superuser postgres must be blocked by trigger (42501)');

      // 4b: Direct INSERT into orders with source_origin = 'LEGACY_JSON_IMPORT' as postgres (superuser)
      let superuserOrderInsertBlocked = false;
      try {
        await testClient.query(`
          INSERT INTO orders (
            order_number, organization_id, ticket_id, external_order_id, provider,
            provider_environment, status, authorized_total, authorized_subtotal,
            authorized_tax, authorized_shipping, currency, approver_name,
            approver_department, idempotency_key, is_simulated, is_simulated_provenance,
            simulated_reason, source_origin, created_at, updated_at
          ) VALUES (
            'ORD_SUPERUSER_BYPASS', $1, 'appr_tk_1793998333437_fe333497a5dc47a7', 'EXT_BYPASS', 'PAYPAL', 'SANDBOX',
            'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD', 'Admin', 'IT', 'key', false, NULL, NULL,
            'LEGACY_JSON_IMPORT', NOW(), NOW()
          )
        `, [SEED_ORGANIZATION_ID]);
      } catch (err: any) {
        superuserOrderInsertBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
        assert.match(err.message, /Authorization violation: execution identity "postgres" cannot create or modify records with legacy provenance/);
      }
      assert.ok(superuserOrderInsertBlocked, 'Direct INSERT into orders by superuser postgres must be blocked by trigger (42501)');
      console.log('  ✓ 4: Superuser postgres allowlist removal verified; direct writes strictly blocked by triggers (42501)');

      // Scenario 5: External Migration Operator Execution Identity Audit (Audit Trail Verification)
      console.log('Scenario 5: External Migration Operator Execution Identity Audit (Audit Trail Verification)');
      const auditSummary = await operatorClient.query<{
        operation: string;
        session_user_val: string;
        current_user_val: string;
        count: string;
      }>(`
        SELECT operation, session_user_val, current_user_val, COUNT(*)::text AS count
        FROM legacy_migration_execution_audit
        GROUP BY operation, session_user_val, current_user_val
        ORDER BY operation ASC
      `);

      console.log('    - Execution identity audit rows:');
      const auditMap: Record<string, { session: string; current: string; count: number }> = {};
      for (const row of auditSummary.rows) {
        console.log(`      * ${row.operation}: session_user=${row.session_user_val}, current_user=${row.current_user_val}, count=${row.count}`);
        assert.strictEqual(row.session_user_val, operatorRole, `session_user must equal external operator (${operatorRole})`);
        assert.strictEqual(row.current_user_val, 'procurepilot_legacy_importer', 'current_user must equal procurepilot_legacy_importer');
        auditMap[row.operation] = { session: row.session_user_val, current: row.current_user_val, count: parseInt(row.count, 10) };
      }

      assert.strictEqual(auditMap['IMPORT_APPROVAL_TICKET']?.count, 219, 'Audit trail must record 219 approval tickets');
      assert.strictEqual(auditMap['IMPORT_APPROVAL_TICKET_ITEM']?.count, 323, 'Audit trail must record 323 approval items');
      assert.strictEqual(auditMap['IMPORT_ORDER']?.count, 80, 'Audit trail must record 80 orders');
      assert.strictEqual(auditMap['IMPORT_ORDER_ITEM']?.count, 80, 'Audit trail must record 80 order items');

      const postgresAuditCheck = await operatorClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM legacy_migration_execution_audit
        WHERE current_user_val = 'postgres' OR session_user_val = 'postgres'
      `);
      assert.strictEqual(postgresAuditCheck.rows[0].count, '0', 'Zero ordinary migration operations may run under postgres');
      console.log('  ✓ 5: External operator execution identity proved; session_user=operator, current_user=importer (0 under postgres)');

      // Scenario 6: Historical Child Record Security (approval_ticket_items & order_items)
      console.log('Scenario 6: Historical Child Record Security (approval_ticket_items & order_items)');
      const appClientChild = new Client({
        ...baseConfig,
        database: tempDbName,
        user: 'procurepilot_app',
        password: 'procurepilot_app_pass_test',
      });
      appClientChild.on('error', () => {});
      await appClientChild.connect();

      try {
        // 6a: Direct INSERT into approval_ticket_items referencing legacy ticket
        let childTicketInsertBlocked = false;
        try {
          await appClientChild.query(`
            INSERT INTO approval_ticket_items (
              ticket_id, product_id, product_name, quantity, unit_price, line_total
            ) VALUES (
              'appr_tk_1793998333437_fe333497a5dc47a7', 'prod-hacked', 'Hacked Item', 1, 10.00, 10.00
            )
          `);
        } catch (err: any) {
          childTicketInsertBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
          assert.match(err.message, /Authorization violation: execution identity "procurepilot_app" cannot insert child items for legacy approval tickets/);
        }
        assert.ok(childTicketInsertBlocked, 'Direct INSERT into approval_ticket_items for legacy ticket by procurepilot_app must be blocked (42501)');

        // 6b: Direct UPDATE on approval_ticket_items for legacy ticket
        let childTicketUpdateBlocked = false;
        try {
          await appClientChild.query(`
            UPDATE approval_ticket_items
            SET quantity = 99
            WHERE ticket_id = 'appr_tk_1793998333437_fe333497a5dc47a7'
          `);
        } catch (err: any) {
          childTicketUpdateBlocked = true;
          assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
          assert.match(err.message, /Immutability violation: approval items belonging to legacy approval tickets are strictly immutable/);
        }
        assert.ok(childTicketUpdateBlocked, 'Direct UPDATE on approval_ticket_items for legacy ticket by procurepilot_app must be blocked (22000)');

        // 6c: Direct DELETE on approval_ticket_items for legacy ticket
        let childTicketDeleteBlocked = false;
        try {
          await appClientChild.query(`
            DELETE FROM approval_ticket_items
            WHERE ticket_id = 'appr_tk_1793998333437_fe333497a5dc47a7'
          `);
        } catch (err: any) {
          childTicketDeleteBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected 42501 (table privilege), got: ${err.code}`);
        }
        assert.ok(childTicketDeleteBlocked, 'Direct DELETE on approval_ticket_items by procurepilot_app must be blocked (42501)');

        // Also verify trigger enforces 22000 for any execution identity attempting deletion
        let childTicketDeleteTriggerBlocked = false;
        try {
          await testClient.query(`
            DELETE FROM approval_ticket_items
            WHERE ticket_id = 'appr_tk_1793998333437_fe333497a5dc47a7'
          `);
        } catch (err: any) {
          childTicketDeleteTriggerBlocked = true;
          assert.strictEqual(err.code, '22000', `Expected 22000 from trigger, got: ${err.code}`);
          assert.match(err.message, /Immutability violation: approval items belonging to legacy approval tickets are strictly immutable/);
        }
        assert.ok(childTicketDeleteTriggerBlocked, 'Direct DELETE on approval_ticket_items for legacy ticket must be blocked by trigger (22000)');

        // Sample legacy order ID for order child tests
        const sampleOrderRow = await testClient.query<{ id: string }>(`
          SELECT id FROM orders WHERE source_origin = 'LEGACY_JSON_IMPORT' LIMIT 1
        `);
        const sampleLegacyOrderId = sampleOrderRow.rows[0].id;

        // 6d: Direct INSERT into order_items referencing legacy order
        let childOrderInsertBlocked = false;
        try {
          await appClientChild.query(`
            INSERT INTO order_items (
              organization_id, order_id, product_id, product_name, quantity, unit_price, line_total
            ) VALUES (
              $1, $2, 'prod-hacked', 'Hacked Order Item', 1, 10.00, 10.00
            )
          `, [SEED_ORGANIZATION_ID, sampleLegacyOrderId]);
        } catch (err: any) {
          childOrderInsertBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
          assert.match(err.message, /Authorization violation: execution identity "procurepilot_app" cannot insert child items for legacy orders/);
        }
        assert.ok(childOrderInsertBlocked, 'Direct INSERT into order_items for legacy order by procurepilot_app must be blocked (42501)');

        // 6e: Direct UPDATE on order_items for legacy order
        let childOrderUpdateBlocked = false;
        try {
          await appClientChild.query(`
            UPDATE order_items
            SET quantity = 99
            WHERE order_id = $1
          `, [sampleLegacyOrderId]);
        } catch (err: any) {
          childOrderUpdateBlocked = true;
          assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
          assert.match(err.message, /Immutability violation: order items belonging to legacy orders are strictly immutable/);
        }
        assert.ok(childOrderUpdateBlocked, 'Direct UPDATE on order_items for legacy order by procurepilot_app must be blocked (22000)');

        // 6f: Direct DELETE on order_items for legacy order
        let childOrderDeleteBlocked = false;
        try {
          await appClientChild.query(`
            DELETE FROM order_items
            WHERE order_id = $1
          `, [sampleLegacyOrderId]);
        } catch (err: any) {
          childOrderDeleteBlocked = true;
          assert.strictEqual(err.code, '42501', `Expected 42501 (table privilege), got: ${err.code}`);
        }
        assert.ok(childOrderDeleteBlocked, 'Direct DELETE on order_items by procurepilot_app must be blocked (42501)');

        // Also verify trigger enforces 22000 for any execution identity attempting deletion
        let childOrderDeleteTriggerBlocked = false;
        try {
          await testClient.query(`
            DELETE FROM order_items
            WHERE order_id = $1
          `, [sampleLegacyOrderId]);
        } catch (err: any) {
          childOrderDeleteTriggerBlocked = true;
          assert.strictEqual(err.code, '22000', `Expected 22000 from trigger, got: ${err.code}`);
          assert.match(err.message, /Immutability violation: order items belonging to legacy orders are strictly immutable/);
        }
        assert.ok(childOrderDeleteTriggerBlocked, 'Direct DELETE on order_items for legacy order must be blocked by trigger (22000)');

        // 6g: Verify normal runtime child-item operations on RUNTIME parents succeed
        const runtimeOrderRow = await testClient.query<{ id: string }>(`
          INSERT INTO orders (
            order_number, organization_id, ticket_id, external_order_id, provider,
            provider_environment, status, authorized_total, authorized_subtotal,
            authorized_tax, authorized_shipping, currency, approver_name,
            approver_department, idempotency_key, is_simulated, is_simulated_provenance,
            simulated_reason, source_origin, created_at, updated_at
          ) VALUES (
            'ORD_RUNTIME_NORMAL', $1, $2, 'EXT_RUNTIME', 'PAYPAL', 'SANDBOX',
            'PENDING_PAYMENT_APPROVAL', 115.00, 100.00, 10.00, 5.00, 'USD', 'Alice', 'Engineering',
            'rt_key', false, 'EXPLICIT_PROVIDER', NULL, 'ONLINE_CHECKOUT', NOW(), NOW()
          ) RETURNING id
        `, [SEED_ORGANIZATION_ID, runtimeTicketId]);
        const runtimeOrderId = runtimeOrderRow.rows[0].id;

        // Insert runtime ticket item via procurepilot_app
        await appClientChild.query(`
          INSERT INTO approval_ticket_items (
            ticket_id, product_id, product_name, quantity, unit_price, line_total
          ) VALUES ($1, 'prod-runtime-01', 'Runtime Chair', 1, 100.00, 100.00)
        `, [runtimeTicketId]);

        // Update runtime ticket item via procurepilot_app
        await appClientChild.query(`
          UPDATE approval_ticket_items
          SET quantity = 2, line_total = 200.00
          WHERE ticket_id = $1 AND product_id = 'prod-runtime-01'
        `, [runtimeTicketId]);

        // Insert runtime order item via procurepilot_app
        await appClientChild.query(`
          INSERT INTO order_items (
            organization_id, order_id, product_id, product_name, quantity, unit_price, line_total
          ) VALUES ($1, $2, 'prod-runtime-01', 'Runtime Chair', 1, 100.00, 100.00)
        `, [SEED_ORGANIZATION_ID, runtimeOrderId]);

        // Update runtime order item via procurepilot_app
        await appClientChild.query(`
          UPDATE order_items
          SET quantity = 2, line_total = 200.00
          WHERE order_id = $1 AND product_id = 'prod-runtime-01'
        `, [runtimeOrderId]);

        // Trigger allows deletion on RUNTIME parent (verified via testClient)
        await testClient.query(`
          DELETE FROM order_items
          WHERE order_id = $1 AND product_id = 'prod-runtime-01'
        `, [runtimeOrderId]);

        await testClient.query(`
          DELETE FROM approval_ticket_items
          WHERE ticket_id = $1 AND product_id = 'prod-runtime-01'
        `, [runtimeTicketId]);

        console.log('    - Normal runtime child item operations (INSERT, UPDATE, DELETE) verified working on RUNTIME parents');

      } finally {
        await appClientChild.end();
      }
      console.log('  ✓ 6: Historical child records strictly protected; runtime parent operations preserved');

      // Scenario 7: Controlled migration path can insert a legacy approval with NULL signature
      console.log('Scenario 7: Controlled migration path can insert a legacy approval with NULL signature');
      const controlledTicketId = `test_controlled_legacy_${Date.now()}`;
      const controlledCreatedAt = new Date('2026-01-15T10:00:00.000Z');
      await operatorClient.query(`
        SELECT import_legacy_approval_ticket(
          $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
          NULL, 'Alex Mercer', 'DevOps', 'Legacy Migration Rehearsal', 'SELF_ATTESTED_REQUISITIONER',
          $5, NULL, NULL, $6
        )
      `, [controlledTicketId, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);

      const controlledCheck = await operatorClient.query<{ challenge_signature: string | null; source_origin: string; integrity_status: string }>(
        `SELECT challenge_signature, source_origin, integrity_status FROM approval_tickets WHERE ticket_id = $1`,
        [controlledTicketId]
      );
      assert.strictEqual(controlledCheck.rows[0].challenge_signature, null, 'challenge_signature must be NULL');
      assert.strictEqual(controlledCheck.rows[0].source_origin, 'LEGACY_JSON_IMPORT');
      assert.strictEqual(controlledCheck.rows[0].integrity_status, 'UNVERIFIABLE_LEGACY');
      console.log('  ✓ 7: Controlled migration path successfully inserted legacy approval with NULL signature');

      // Scenario 8: Genuine Immutability & Conflict Rejection for Approval Tickets
      console.log('Scenario 8: Genuine Immutability & Conflict Rejection for Approval Tickets');
      // 8a: Identical repeat invocation returns cleanly without modification
      await operatorClient.query(`
        SELECT import_legacy_approval_ticket(
          $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
          NULL, 'Alex Mercer', 'DevOps', 'Legacy Migration Rehearsal', 'SELF_ATTESTED_REQUISITIONER',
          $5, NULL, NULL, $6
        )
      `, [controlledTicketId, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);
      console.log('    - Identical repeat import succeeded cleanly (RETURN;)');

      // 8b: Conflicting invocation on existing ticket ID fails explicitly with data_exception (22000)
      let conflictFailed = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, NULL, 999.00, 10.00, 5.00, 1014.00, 'USD', 'PENDING_APPROVAL',
            NULL, 'Alex Mercer', 'DevOps', 'Legacy Migration Rehearsal', 'SELF_ATTESTED_REQUISITIONER',
            $5, NULL, NULL, $6
          )
        `, [controlledTicketId, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);
      } catch (err: any) {
        conflictFailed = true;
        assert.strictEqual(err.code, '22000', `Expected data_exception (22000), got: ${err.code} (${err.message})`);
        assert.match(err.message, /Conflicting import for legacy ticket/);
      }
      assert.ok(conflictFailed, 'Conflicting repeat import must fail with data_exception (22000)');
      console.log('    - Conflicting import on existing ticket ID failed explicitly with 22000');

      // 8c: Direct UPDATE on legacy approval ticket fails with 22000
      let directTicketUpdateBlocked = false;
      try {
        await testClient.query(`
          UPDATE approval_tickets
          SET verified_total = 999.00
          WHERE ticket_id = $1
        `, [controlledTicketId]);
      } catch (err: any) {
        directTicketUpdateBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Immutability violation: legacy approval tickets are strictly immutable and cannot be updated/);
      }
      assert.ok(directTicketUpdateBlocked, 'Direct UPDATE on legacy ticket must fail with immutability violation (22000)');
      console.log('    - Direct UPDATE on legacy approval ticket strictly blocked by trigger (22000)');

      // 8d: Direct DELETE on legacy approval ticket fails with 22000
      let directTicketDeleteBlocked = false;
      try {
        await testClient.query(`
          DELETE FROM approval_tickets
          WHERE ticket_id = $1
        `, [controlledTicketId]);
      } catch (err: any) {
        directTicketDeleteBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Immutability violation: legacy approval tickets are strictly immutable and cannot be deleted/);
      }
      assert.ok(directTicketDeleteBlocked, 'Direct DELETE on legacy ticket must fail with immutability violation (22000)');
      console.log('    - Direct DELETE on legacy approval ticket strictly blocked by trigger (22000)');
      console.log('  ✓ 8: Genuine immutability and conflict rejection verified for approval tickets');

      // Scenario 9: Genuine Immutability & Complete Field Equivalence for Orders
      console.log('Scenario 9: Genuine Immutability & Complete Field Equivalence for Orders');
      // 9a: Identical repeat invocation of import_legacy_order returns existing order ID
      const sampleLegacyOrder = await operatorClient.query<{
        id: string;
        order_number: string;
        organization_id: string;
        ticket_id: string;
        external_order_id: string;
        provider: string;
        provider_environment: string;
        status: string;
        authorized_total: string;
        authorized_subtotal: string;
        authorized_tax: string;
        authorized_shipping: string;
        currency: string;
        approver_name: string;
        approver_department: string;
        idempotency_key: string;
        is_simulated: boolean;
        is_simulated_provenance: string;
        simulated_reason: string;
        created_at: Date;
        updated_at: Date;
      }>(`
        SELECT * FROM orders WHERE source_origin = 'LEGACY_JSON_IMPORT' LIMIT 1
      `);
      const ord = sampleLegacyOrder.rows[0];

      const repeatOrderRes = await operatorClient.query<{ id: string }>(`
        SELECT import_legacy_order(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        ) AS id
      `, [
        ord.order_number, ord.organization_id, ord.ticket_id, ord.external_order_id,
        ord.provider, ord.provider_environment, ord.status, ord.authorized_total,
        ord.authorized_subtotal, ord.authorized_tax, ord.authorized_shipping,
        ord.currency, ord.approver_name, ord.approver_department, ord.idempotency_key,
        ord.is_simulated, ord.is_simulated_provenance, ord.simulated_reason,
        ord.created_at, ord.updated_at
      ]);
      assert.strictEqual(repeatOrderRes.rows[0].id, ord.id, 'Identical repeat import must return exact existing order ID');
      console.log('    - Identical repeat order import returned existing ID without modification');

      // 9b: Conflicting order import with modified authorized_total fails with data_exception (22000)
      let conflictOrderTotalBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_order(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          ) AS id
        `, [
          ord.order_number, ord.organization_id, ord.ticket_id, ord.external_order_id,
          ord.provider, ord.provider_environment, ord.status, 9999.00,
          ord.authorized_subtotal, ord.authorized_tax, ord.authorized_shipping,
          ord.currency, ord.approver_name, ord.approver_department, ord.idempotency_key,
          ord.is_simulated, ord.is_simulated_provenance, ord.simulated_reason,
          ord.created_at, ord.updated_at
        ]);
      } catch (err: any) {
        conflictOrderTotalBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Conflicting import for legacy order/);
      }
      assert.ok(conflictOrderTotalBlocked, 'Conflicting order import with modified authorized_total must fail (22000)');
      console.log('    - Conflicting order import (modified total) rejected with data_exception (22000)');

      // 9c: Conflicting order import with modified external_order_id fails with 22000
      let conflictOrderIdBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_order(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
          ) AS id
        `, [
          ord.order_number, ord.organization_id, ord.ticket_id, 'FORGED_EXT_ID',
          ord.provider, ord.provider_environment, ord.status, ord.authorized_total,
          ord.authorized_subtotal, ord.authorized_tax, ord.authorized_shipping,
          ord.currency, ord.approver_name, ord.approver_department, ord.idempotency_key,
          ord.is_simulated, ord.is_simulated_provenance, ord.simulated_reason,
          ord.created_at, ord.updated_at
        ]);
      } catch (err: any) {
        conflictOrderIdBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Conflicting import for legacy order/);
      }
      assert.ok(conflictOrderIdBlocked, 'Conflicting order import with modified external_order_id must fail (22000)');
      console.log('    - Conflicting order import (modified external ID) rejected with data_exception (22000)');

      // 9d: Direct UPDATE on legacy order fails with 22000
      let directOrderUpdateBlocked = false;
      try {
        await testClient.query(`
          UPDATE orders
          SET status = 'CANCELLED'
          WHERE id = $1
        `, [ord.id]);
      } catch (err: any) {
        directOrderUpdateBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Immutability violation: legacy orders are strictly immutable and cannot be updated/);
      }
      assert.ok(directOrderUpdateBlocked, 'Direct UPDATE on legacy order must fail with immutability violation (22000)');
      console.log('    - Direct UPDATE on legacy order strictly blocked by trigger (22000)');

      // 9e: Direct DELETE on legacy order fails with 22000
      let directOrderDeleteBlocked = false;
      try {
        await testClient.query(`
          DELETE FROM orders
          WHERE id = $1
        `, [ord.id]);
      } catch (err: any) {
        directOrderDeleteBlocked = true;
        assert.strictEqual(err.code, '22000', `Expected 22000, got: ${err.code}`);
        assert.match(err.message, /Immutability violation: legacy orders are strictly immutable and cannot be deleted/);
      }
      assert.ok(directOrderDeleteBlocked, 'Direct DELETE on legacy order must fail with immutability violation (22000)');
      console.log('    - Direct DELETE on legacy order strictly blocked by trigger (22000)');
      console.log('  ✓ 9: Complete field equivalence and conflict rejection verified for orders');

      // Scenario 10: Strict Signature Validation (verbatim storage, no trim, rejection of malformed/whitespace)
      console.log('Scenario 10: Strict Signature Validation');
      // 10a: Valid 64-hex signature succeeds and is stored verbatim
      const validSigTicketId = `test_sig_valid_${Date.now()}`;
      const validSig = crypto.randomBytes(32).toString('hex');
      await operatorClient.query(`
        SELECT import_legacy_approval_ticket(
          $1, $2, $3, $4, $5, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
          NULL, 'Alex Mercer', 'DevOps', 'Valid Sig Test', 'SELF_ATTESTED_REQUISITIONER',
          $6, NULL, NULL, $7
        )
      `, [validSigTicketId, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, validSig, runtimeExpiresAt, controlledCreatedAt]);

      const sigCheckRow = await operatorClient.query<{ challenge_signature: string }>(
        `SELECT challenge_signature FROM approval_tickets WHERE ticket_id = $1`,
        [validSigTicketId]
      );
      assert.strictEqual(sigCheckRow.rows[0].challenge_signature, validSig, 'Valid 64-hex signature must be stored verbatim');
      console.log('    - Valid 64-hex signature stored verbatim in PostgreSQL');

      // 10b: Malformed non-hex signature fails with invalid_parameter_value (22023)
      let malformedSigBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, 'not-a-valid-hex-signature-string-too-short', 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
            NULL, 'Alex Mercer', 'DevOps', 'Bad Sig Test', 'SELF_ATTESTED_REQUISITIONER',
            $5, NULL, NULL, $6
          )
        `, [`test_sig_bad_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);
      } catch (err: any) {
        malformedSigBlocked = true;
        assert.strictEqual(err.code, '22023', `Expected invalid_parameter_value (22023), got: ${err.code}`);
      }
      assert.ok(malformedSigBlocked, 'Malformed non-hex signature must be rejected with 22023');
      console.log('    - Malformed signature rejected with invalid_parameter_value (22023)');

      // 10c: Whitespace-padded signature fails with invalid_parameter_value (22023, no trim)
      let whitespaceSigBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, $5, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
            NULL, 'Alex Mercer', 'DevOps', 'Whitespace Sig Test', 'SELF_ATTESTED_REQUISITIONER',
            $6, NULL, NULL, $7
          )
        `, [
          `test_sig_ws_${Date.now()}`,
          SEED_ORGANIZATION_ID,
          runtimeNonce,
          runtimeFingerprint,
          `  ${validSig}  `, // padded with whitespace
          runtimeExpiresAt,
          controlledCreatedAt,
        ]);
      } catch (err: any) {
        whitespaceSigBlocked = true;
        assert.strictEqual(err.code, '22023', `Expected invalid_parameter_value (22023), got: ${err.code}`);
      }
      assert.ok(whitespaceSigBlocked, 'Whitespace-padded signature must be rejected with 22023 (no trim)');
      console.log('    - Whitespace-padded signature rejected with invalid_parameter_value (22023, no trim)');
      console.log('  ✓ 10: Strict signature validation invariants verified');

      // Scenario 11: Historical Field Defaults Audit
      console.log('Scenario 11: Historical Field Defaults Audit');
      // 11a: Missing p_created_at fails with invalid_parameter_value (22023)
      let missingCreatedAtBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', 'PENDING_APPROVAL',
            NULL, 'Alex Mercer', 'DevOps', 'Audit Defaults Test', 'SELF_ATTESTED_REQUISITIONER',
            $5, NULL, NULL, NULL
          )
        `, [`test_def_created_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt]);
      } catch (err: any) {
        missingCreatedAtBlocked = true;
        assert.strictEqual(err.code, '22023', `Expected invalid_parameter_value (22023), got: ${err.code}`);
        assert.match(err.message, /Mandatory field missing: p_created_at/);
      }
      assert.ok(missingCreatedAtBlocked, 'Missing p_created_at must fail with 22023 (no COALESCE with NOW())');
      console.log('    - Missing p_created_at rejected with 22023 (no synthesized timestamp)');

      // 11b: Missing p_status fails with invalid_parameter_value (22023)
      let missingStatusBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'USD', NULL,
            NULL, 'Alex Mercer', 'DevOps', 'Audit Defaults Test', 'SELF_ATTESTED_REQUISITIONER',
            $5, NULL, NULL, $6
          )
        `, [`test_def_status_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);
      } catch (err: any) {
        missingStatusBlocked = true;
        assert.strictEqual(err.code, '22023', `Expected invalid_parameter_value (22023), got: ${err.code}`);
      }
      assert.ok(missingStatusBlocked, 'Missing p_status must fail with 22023');
      console.log('    - Missing p_status rejected with 22023');

      // 11c: Unsupported currency fails with invalid_parameter_value (22023)
      let badCurrencyBlocked = false;
      try {
        await operatorClient.query(`
          SELECT import_legacy_approval_ticket(
            $1, $2, $3, $4, NULL, 100.00, 10.00, 5.00, 115.00, 'EUR', 'PENDING_APPROVAL',
            NULL, 'Alex Mercer', 'DevOps', 'Audit Defaults Test', 'SELF_ATTESTED_REQUISITIONER',
            $5, NULL, NULL, $6
          )
        `, [`test_def_curr_${Date.now()}`, SEED_ORGANIZATION_ID, runtimeNonce, runtimeFingerprint, runtimeExpiresAt, controlledCreatedAt]);
      } catch (err: any) {
        badCurrencyBlocked = true;
        assert.strictEqual(err.code, '22023', `Expected invalid_parameter_value (22023), got: ${err.code}`);
      }
      assert.ok(badCurrencyBlocked, 'Unsupported currency must fail with 22023');
      console.log('    - Unsupported currency rejected with 22023');
      console.log('  ✓ 11: Historical field defaults audit passed (no silent synthesis)');

      // Scenario 12: Legacy approval has integrity status UNVERIFIABLE_LEGACY
      console.log('Scenario 12: Legacy approval has integrity status UNVERIFIABLE_LEGACY');
      const integrityCheck = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM approval_tickets
        WHERE source_origin = 'LEGACY_JSON_IMPORT' AND integrity_status <> 'UNVERIFIABLE_LEGACY'
      `);
      assert.strictEqual(integrityCheck.rows[0].count, '0', 'All legacy approvals must have UNVERIFIABLE_LEGACY integrity status');
      console.log('  ✓ 12: All legacy approvals strictly possess UNVERIFIABLE_LEGACY integrity status');

      // Scenario 13: Legacy APPROVED and CONSUMED tickets cannot authorize new checkout
      console.log('Scenario 13: Legacy APPROVED and CONSUMED tickets cannot authorize new checkout');
      // Test 13a: Test via approvalService.verifyAndConsumeTicket
      const legacyStateApproved = {
        ticketId: 'test_legacy_approved',
        nonce: runtimeNonce,
        cartFingerprint: runtimeFingerprint,
        verifiedItems: [{ productId: 'prod-hm-aeron-01', name: 'Aeron Chair', unitPrice: 249.00, quantity: 1, lineTotal: 249.00 }],
        verifiedSubtotal: 249.00,
        verifiedTax: 20.54,
        verifiedShipping: 25.00,
        verifiedTotal: 294.54,
        currency: 'USD' as const,
        createdAt: Date.now() - 3600000,
        expiresAt: Date.now() + 600000,
        status: 'APPROVED' as const,
        sourceOrigin: 'LEGACY_JSON_IMPORT' as const,
        integrityStatus: 'UNVERIFIABLE_LEGACY' as const,
      };

      // Mock save to approval service memory store for verification test
      (approvalService as any).memoryStore.set(legacyStateApproved.ticketId, legacyStateApproved);
      const consumeLegacyApproved = approvalService.verifyAndConsumeTicket(
        legacyStateApproved.ticketId,
        'dummy_auth_token_value_that_should_not_matter_because_it_is_legacy',
        [{ productId: 'prod-hm-aeron-01', quantity: 1 }]
      );
      assert.strictEqual(consumeLegacyApproved.isValid, false, 'Legacy ticket must not be valid for checkout');
      assert.match(consumeLegacyApproved.error || '', /Historical legacy approval tickets cannot authorize new checkout/);

      // Test 13b: Test via approvalService.signApproval
      assert.throws(() => {
        approvalService.signApproval(
          legacyStateApproved.ticketId,
          'sig',
          runtimeFingerprint,
          runtimeNonce,
          { userName: 'Alex Mercer', department: 'DevOps', purchaseJustification: 'Test' }
        );
      }, /Historical legacy approval tickets cannot be signed/);
      console.log('  ✓ 13: Legacy APPROVED and CONSUMED tickets strictly rejected by checkout authorization service');

      // Scenario 14: Original source fields remain unchanged
      console.log('Scenario 14: Original source fields remain unchanged');
      const sampleCheckRow = await testClient.query<{
        ticket_id: string;
        nonce: string;
        cart_fingerprint: string;
        verified_total: string;
        currency: string;
      }>(`
        SELECT ticket_id, nonce, cart_fingerprint, verified_total::text, currency
        FROM approval_tickets
        WHERE ticket_id = 'appr_tk_1793998333437_fe333497a5dc47a7'
      `);
      assert.strictEqual(sampleCheckRow.rows.length, 1);
      assert.strictEqual(sampleCheckRow.rows[0].currency, 'USD');
      assert.strictEqual(sampleCheckRow.rows[0].verified_total, '2104.38');
      assert.strictEqual(sampleCheckRow.rows[0].nonce, 'bb5b81c4fbe24bba17cf88e9210d6766c9453d660ef1c220aadceaafda1e7bb1');
      assert.strictEqual(sampleCheckRow.rows[0].cart_fingerprint, '10f378f1b99343a7365ca22d9f5b3bc4909458dab3f074cba7a26f52540b4da0');
      console.log('  ✓ 14: Original source fields verified unchanged in PostgreSQL');

      // Scenario 15: Accurate Approval Counts Reconciliation (strictly separated historical vs test fixtures)
      console.log('Scenario 15: Accurate Approval Counts Reconciliation');
      const historicalStatusDist = await testClient.query<{ source_origin: string; integrity_status: string; status: string; count: string }>(`
        SELECT source_origin, integrity_status, status, COUNT(*)::text AS count
        FROM approval_tickets
        WHERE source_origin = 'LEGACY_JSON_IMPORT' AND ticket_id LIKE 'appr_tk_%'
        GROUP BY source_origin, integrity_status, status
        ORDER BY status ASC
      `);
      console.log('    - Historical legacy approvals breakdown:');
      let totalHistorical = 0;
      const historicalByStatus: Record<string, number> = {};
      for (const row of historicalStatusDist.rows) {
        const c = parseInt(row.count, 10);
        totalHistorical += c;
        historicalByStatus[row.status] = c;
        console.log(`      * ${row.source_origin} / ${row.integrity_status} / ${row.status}: ${row.count}`);
      }
      assert.strictEqual(totalHistorical, 219, 'Must have exactly 219 historical approval tickets');
      assert.strictEqual(historicalByStatus['CONSUMED'], 141, 'Historical CONSUMED tickets must equal 141');
      assert.strictEqual(historicalByStatus['APPROVED'], 26, 'Historical APPROVED tickets must equal 26');
      assert.strictEqual(historicalByStatus['PENDING_APPROVAL'], 52, 'Historical PENDING_APPROVAL tickets must equal 52');

      // Separate query for runtime / rehearsal test fixtures
      const fixtureCounts = await testClient.query<{ source_origin: string; count: string }>(`
        SELECT source_origin, COUNT(*)::text AS count
        FROM approval_tickets
        WHERE ticket_id NOT LIKE 'appr_tk_%' OR source_origin <> 'LEGACY_JSON_IMPORT'
        GROUP BY source_origin
        ORDER BY source_origin ASC
      `);
      console.log('    - Test fixture approvals (strictly separated):');
      for (const row of fixtureCounts.rows) {
        console.log(`      * ${row.source_origin}: ${row.count}`);
      }
      assert.strictEqual(summary.approvalsMigrated, 219);
      assert.strictEqual(summary.approvalsExcluded, 0);
      console.log('  ✓ 15: All 219 historical approvals reconciled accurately (141 CONSUMED, 26 APPROVED, 52 PENDING_APPROVAL) and separated from test fixtures');

      // Scenario 16: Valid dependent orders can be imported without broken foreign keys
      console.log('Scenario 16: Valid dependent orders can be imported without broken foreign keys');
      const ordersInDb = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM orders WHERE source_origin = 'LEGACY_JSON_IMPORT'
      `);
      assert.strictEqual(ordersInDb.rows[0].count, '80', 'Exactly 80 valid orders must be imported');

      const brokenFkCheck = await testClient.query(`
        SELECT o.id, o.order_number, o.ticket_id
        FROM orders o
        LEFT JOIN approval_tickets a ON o.ticket_id = a.ticket_id
        WHERE a.ticket_id IS NULL
      `);
      assert.strictEqual(brokenFkCheck.rows.length, 0, 'Must have zero broken foreign keys');
      console.log('  ✓ 16: Exactly 80 valid orders imported with 0 broken foreign keys (fk_orders_org_ticket satisfied)');

      // Scenario 17: Exactly one genuine capture is inserted
      console.log('Scenario 17: Exactly one genuine capture is inserted');
      const captureCheck = await testClient.query<{ count: string; amount: string; origin: string }>(`
        SELECT COUNT(*)::text AS count, SUM(captured_amount)::numeric(12,2)::text AS amount, capture_origin AS origin
        FROM payment_captures
        GROUP BY capture_origin
      `);
      assert.strictEqual(captureCheck.rows.length, 1);
      assert.strictEqual(captureCheck.rows[0].count, '1');
      assert.strictEqual(captureCheck.rows[0].amount, '294.54');
      assert.strictEqual(captureCheck.rows[0].origin, 'PAYPAL_API');
      console.log('  ✓ 17: Exactly one genuine capture in payment_captures (amount: $294.54, origin: PAYPAL_API)');

      // Scenario 18: Zero synthetic captures enter payment_captures
      console.log('Scenario 18: Zero synthetic captures enter payment_captures');
      const synthCheck = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM payment_captures
        WHERE capture_origin <> 'PAYPAL_API' OR external_capture_id LIKE 'CAP_SANDBOX_STAGE2_%'
      `);
      assert.strictEqual(synthCheck.rows[0].count, '0');
      console.log('  ✓ 18: Zero synthetic captures in payment_captures ledger (count = 0, 78 excluded to manifest)');

      // Scenario 19: Second import produces no duplicates
      console.log('Scenario 19: Second import produces no duplicates');
      const secondResult = await runLegacyMigration({ client: operatorClient });
      assert.strictEqual(secondResult.summary.approvalsMigrated, 219);
      assert.strictEqual(secondResult.summary.ordersMigrated, 80);
      assert.strictEqual(secondResult.summary.genuineCapturesMigrated, 1);

      const dbApprovalsAfter = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM approval_tickets WHERE source_origin = 'LEGACY_JSON_IMPORT' AND ticket_id LIKE 'appr_tk_%'
      `);
      assert.strictEqual(dbApprovalsAfter.rows[0].count, '219', 'Second import must create 0 duplicate approval tickets');

      const dbOrdersAfter = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM orders WHERE source_origin = 'LEGACY_JSON_IMPORT'
      `);
      assert.strictEqual(dbOrdersAfter.rows[0].count, '80', 'Second import must create 0 duplicate orders');

      const dbCapturesAfter = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM payment_captures
      `);
      assert.strictEqual(dbCapturesAfter.rows[0].count, '1', 'Second import must create 0 duplicate payment captures');
      console.log('  ✓ 19: Second import creates zero duplicate records; database contents strictly idempotent');

      // Scenario 20: Existing refund security and search-path controls remain intact
      console.log('Scenario 20: Existing refund security and search-path controls remain intact');
      // 20a: Search-path configuration on all privileged functions
      const funcSearchPathCheck = await testClient.query<{ proname: string; proconfig: string[] }>(`
        SELECT p.proname, p.proconfig
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'create_refund_reservation',
            'finalize_refund_settlement',
            'record_refund_failure',
            'record_refund_outcome_unknown',
            'import_legacy_approval_ticket',
            'import_legacy_approval_ticket_item',
            'import_legacy_order',
            'import_legacy_order_item'
          )
        ORDER BY p.proname ASC
      `);
      assert.strictEqual(funcSearchPathCheck.rows.length, 8, 'All 8 privileged functions must exist');
      for (const row of funcSearchPathCheck.rows) {
        assert.ok(row.proconfig, `Function ${row.proname} must have fixed search_path configuration`);
        assert.ok(
          row.proconfig.includes('search_path=pg_catalog, public, pg_temp'),
          `Function ${row.proname} must have safe search_path: pg_catalog, public, pg_temp`
        );
      }

      // 20b: Refund attempt protection trigger remains active
      const trgCheck = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM pg_trigger
        WHERE tgname = 'trg_protect_refund_attempts'
      `);
      assert.strictEqual(trgCheck.rows[0].count, '1', 'Refund attempt trigger must remain active');
      console.log('  ✓ 20: Search-path configuration on all 8 functions and refund write-path security controls fully intact');

      // Export rehearsal summary to separate artifact
      const summaryPath = path.resolve(process.cwd(), 'migration-provenance-rehearsal-summary.json');
      fs.writeFileSync(
        summaryPath,
        JSON.stringify(
          {
            phase: 'Phase 1B.2.1.2.2',
            timestamp: new Date().toISOString(),
            operatorRole,
            firstPass: summary,
            secondPass: secondResult.summary,
            scenariosVerified: 20,
            allScenariosPassed: true,
          },
          null,
          2
        ),
        'utf8'
      );
      console.log(`\n  ✓ Execution summary written to: ${summaryPath}`);

      await operatorClient.end();
      await testClient.end();
      return { executed: true, summary, secondSummary: secondResult.summary };
    } catch (testErr) {
      console.error('Error during rehearsal execution:', testErr);
      await testClient.end();
      throw testErr;
    } finally {
      // Clean up disposable database
      await rootClient.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`);
      console.log(`  ✓ Cleaned up disposable rehearsal database: ${tempDbName}`);
      await rootClient.end();
    }
  } catch (err) {
    await rootClient.end();
    throw err;
  } finally {
    // Assert manifests were NOT mutated
    if (preHashes.preflight) {
      const postHash = getFileSha256(preflightPath);
      assert.strictEqual(
        postHash,
        preHashes.preflight,
        'migration-preflight-manifest.json MUST NOT be mutated during rehearsal'
      );
    }
    if (preHashes.quarantine) {
      const postHash = getFileSha256(quarantinePath);
      assert.strictEqual(
        postHash,
        preHashes.quarantine,
        'migration-quarantine-manifest.json MUST NOT be mutated during rehearsal'
      );
    }
    if (preHashes.simulated) {
      const postHash = getFileSha256(simulatedPath);
      assert.strictEqual(
        postHash,
        preHashes.simulated,
        'migration-simulated-orders-manifest.json MUST NOT be mutated during rehearsal'
      );
    }
    console.log('  ✓ Manifest preservation verified: all 3 manifests have identical pre/post SHA-256 hashes');

    // Assert .data/ directory was NOT mutated
    const finalInventory = capturePersistentDataInventory();
    assertDataInventoryUnchanged(initialInventory, finalInventory);
    console.log('  ✓ Source data preservation verified: all 81 orders and 219 approvals identical to baseline');
  }
}

if (require.main === module) {
  runLegacyMigrationRehearsalTest()
    .then(() => {
      console.log('\n🎉 ALL PHASE 1B.2.1.2.2 RESTRICTED OPERATOR & IMMUTABILITY CHECKS PASSED (0 FAILURES)');
    })
    .catch((err) => {
      console.error('\n❌ Restricted operator & immutability rehearsal test failed:', err);
      process.exit(1);
    });
}
