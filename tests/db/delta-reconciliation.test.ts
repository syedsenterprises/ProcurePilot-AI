import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'node:assert';
import { Client, Pool } from 'pg';
import { runLegacyMigration } from '../../src/db/legacy-migration';
import { DeltaReconciler } from '../../src/db/delta-reconciliation';
import { generateLegacyOrderNumber, SEED_ORGANIZATION_ID } from '../../src/db/legacy-migration';
import { approvalService } from '../../src/services/approval/approval.service';

function computeSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function runDeltaReconciliationTests(): Promise<void> {
  console.log('================================================================');
  console.log('ProcurePilot AI — Phase 1B.2.3-B.4.2.2 Security Test Suite');
  console.log('================================================================');

  const baseConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  };

  const testDbName = `procurepilot_delta_test_${Date.now()}`;
  const rootClient = new Client({ ...baseConfig, database: 'postgres' });

  try {
    await rootClient.connect();
    console.log('  ✓ Connected to PostgreSQL root maintenance cluster');
  } catch (err: any) {
    console.error('  [FAIL] Failed to connect to local PostgreSQL instance:', err.message);
    throw err;
  }

  let testPool: Pool | null = null;
  const scratchStagingDirs: string[] = [];
  let reconUser = '';
  let clusterSystemId = '';

  try {
    // Inspect cluster system identifier from rootClient
    try {
      const sysRes = await rootClient.query<{ system_identifier: string }>(
        'SELECT system_identifier::text FROM pg_control_system()'
      );
      clusterSystemId = sysRes.rows[0]?.system_identifier || '';
    } catch {
      clusterSystemId = '';
    }

    // 1. Create Isolated Disposable Test Database
    console.log(`\n--- Provisioning Isolated Test Database: "${testDbName}" ---`);
    await rootClient.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
    await rootClient.query(`CREATE DATABASE "${testDbName}"`);
    console.log(`  ✓ Database "${testDbName}" created successfully`);

    const setupClient = new Client({ ...baseConfig, database: testDbName });
    await setupClient.connect();

    try {
      // 2. Apply Migrations 001 through 008
      const migrationFiles = [
        '001_initial_schema.sql',
        '002_refund_integrity.sql',
        '003_refund_attempt_security.sql',
        '004_non_forgeable_refund_authorization.sql',
        '005_legacy_approval_provenance.sql',
        '006_controlled_delta_reconciliation.sql',
        '007_delta_reconciliation_security_hardening.sql',
        '008_delta_reconciliation_wrapper_resolution.sql',
      ];

      for (const f of migrationFiles) {
        const sql = fs.readFileSync(path.resolve(process.cwd(), 'src/db/migrations', f), 'utf8');
        await setupClient.query(sql);
        console.log(`  ✓ Migration applied: ${f}`);
      }

      // 3. Provision Temporary Baseline Migration Operator & Import Baseline
      const opRole = `test_mig_op_${Date.now()}`;
      const opPass = `op_pass_${crypto.randomBytes(8).toString('hex')}`;
      await setupClient.query(
        `CREATE ROLE "${opRole}" WITH LOGIN PASSWORD '${opPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      await setupClient.query(`GRANT USAGE ON SCHEMA public TO "${opRole}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket TO "${opRole}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket_item TO "${opRole}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order TO "${opRole}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order_item TO "${opRole}"`);
      await setupClient.query(
        `GRANT SELECT ON TABLE organizations, approval_tickets, approval_ticket_items, orders, order_items, payment_captures, legacy_migration_execution_audit TO "${opRole}"`
      );
      await setupClient.query(`GRANT INSERT ON TABLE organizations, payment_captures TO "${opRole}"`);

      const opClient = new Client({
        ...baseConfig,
        database: testDbName,
        user: opRole,
        password: opPass,
      });
      await opClient.connect();

      try {
        console.log('  Loading historical baseline via restricted migration operator...');
        const baselineResult = await runLegacyMigration({ client: opClient });
        assert.strictEqual(baselineResult.summary.ordersMigrated, 80, 'Baseline must import 80 orders');
        assert.strictEqual(baselineResult.summary.approvalsMigrated, 219, 'Baseline must import 219 approvals');
        assert.strictEqual(baselineResult.summary.genuineCapturesMigrated, 1, 'Baseline must import 1 capture');
        assert.strictEqual(baselineResult.summary.migratedAuthorizedTotal, '109932.60', 'Baseline authorized total must be $109,932.60');
        console.log('  ✓ Baseline loaded and verified: 80 orders ($109,932.60), 219 approvals, 1 genuine capture');
      } finally {
        await opClient.end();
      }

      // 4. Provision Dedicated Least-Privilege Reconciliation Operator Role (Correction A)
      reconUser = `test_recon_op_${Date.now()}`;
      const reconPass = `recon_pass_${crypto.randomBytes(8).toString('hex')}`;
      await setupClient.query(
        `CREATE ROLE "${reconUser}" WITH LOGIN PASSWORD '${reconPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      await setupClient.query(`GRANT USAGE ON SCHEMA public TO "${reconUser}"`);
      await setupClient.query(`GRANT SELECT, INSERT, UPDATE ON TABLE orders TO "${reconUser}"`);
      await setupClient.query(`GRANT SELECT, INSERT ON TABLE order_items TO "${reconUser}"`);
      await setupClient.query(`GRANT SELECT, INSERT ON TABLE approval_tickets, approval_ticket_items TO "${reconUser}"`);
      await setupClient.query(`GRANT SELECT, INSERT ON TABLE payment_captures TO "${reconUser}"`);
      await setupClient.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE order_state_transition_audit TO "${reconUser}"`);
      await setupClient.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${reconUser}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) TO "${reconUser}"`);
      await setupClient.query(`GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO "${reconUser}"`);

      // Initialize testPool with dedicated restricted reconciliation credentials
      testPool = new Pool({
        ...baseConfig,
        database: testDbName,
        user: reconUser,
        password: reconPass,
        max: 5,
      });

    } finally {
      await setupClient.end();
    }

    assert.ok(testPool, 'testPool must be initialized');

    // Helper: create isolated scratch staging dir
    const createStagingDir = (): { root: string; orders: string; approvals: string } => {
      const dir = path.resolve(process.cwd(), `scratch/test-delta-staging-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
      const ordDir = path.join(dir, 'orders');
      const appDir = path.join(dir, 'approvals');
      fs.mkdirSync(ordDir, { recursive: true });
      fs.mkdirSync(appDir, { recursive: true });
      scratchStagingDirs.push(dir);
      return { root: dir, orders: ordDir, approvals: appDir };
    };

    let order71FStatus: string | null = null;

    // Helper: copy baseline files
    const copyBaselineToStaging = (staging: { orders: string; approvals: string }) => {
      const srcOrd = path.resolve(process.cwd(), '.data/orders');
      const srcApp = path.resolve(process.cwd(), '.data/approvals');
      for (const f of fs.readdirSync(srcOrd)) {
        fs.copyFileSync(path.join(srcOrd, f), path.join(staging.orders, f));
      }
      for (const f of fs.readdirSync(srcApp)) {
        fs.copyFileSync(path.join(srcApp, f), path.join(staging.approvals, f));
      }
      if (order71FStatus) {
        const p = path.join(staging.orders, '71F126573R549662J.json');
        if (fs.existsSync(p)) {
          const d = JSON.parse(fs.readFileSync(p, 'utf8'));
          d.status = order71FStatus;
          fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
        }
      }
    };

    const validMutationOptions = {
      dryRun: false,
      allowMutations: true,
      authorizedTargetDatabase: testDbName,
      disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      expectedClusterSystemIdentifier: clusterSystemId || undefined,
      expectedDatabaseUser: reconUser,
    };

    const testEphemeralSecret = `test_secret_${crypto.randomBytes(16).toString('hex')}`;
    process.env.APPROVAL_SECRET = testEphemeralSecret;

    // =========================================================================
    // SECTION 1: Baseline Recognition & Idempotent Analysis
    // =========================================================================
    console.log('\n--- Test 1: Baseline Recognition Against Un-mutated Baseline ---');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: path.resolve(process.cwd(), '.data'),
      });
      const analysis = await reconciler.analyze();

      assert.strictEqual(analysis.totalOrdersScanned, 81, 'Must scan 81 order files');
      assert.strictEqual(analysis.totalApprovalsScanned, 219, 'Must scan 219 approval files');
      assert.strictEqual(analysis.existingBaselineUnchangedCount, 80, 'Must recognize 80 unchanged baseline orders');
      assert.strictEqual(analysis.legitimateStateTransitionsCount, 0, 'Must recognize 0 transitions');
      assert.strictEqual(analysis.newRuntimeOrdersCount, 0, 'Must recognize 0 new orders');
      assert.strictEqual(analysis.newRuntimeApprovalsCount, 0, 'Must recognize 0 new approvals');
      assert.strictEqual(analysis.conflictsRejectedCount, 0, 'Must recognize 0 conflicts');
      assert.strictEqual(analysis.quarantinedExcludedCount, 1, 'Must recognize 1 quarantined orphan');
      assert.strictEqual(analysis.hasConflicts, false, 'No conflicts in clean baseline');

      const liveResult = await reconciler.reconcile();
      assert.strictEqual(liveResult.success, true, 'Reconciliation must succeed in default dryRun mode');
      assert.strictEqual(liveResult.dryRun, true, 'Default must be dryRun: true');
      assert.strictEqual(liveResult.appliedTransitionsCount, 0, 'Zero transitions applied');
      assert.strictEqual(liveResult.appliedNewOrdersCount, 0, 'Zero new orders applied');
      assert.strictEqual(liveResult.appliedNewApprovalsCount, 0, 'Zero new approvals applied');
      console.log('  ✓ Test 1 Passed: Clean baseline recognized with zero mutations (80 unchanged, 1 quarantined)');
    }

    console.log('\n--- Test 2: Idempotent Replay ---');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: path.resolve(process.cwd(), '.data'),
      });
      const replayResult = await reconciler.reconcile();
      assert.strictEqual(replayResult.success, true, 'Replay must succeed');
      assert.strictEqual(replayResult.dryRun, true);
      assert.strictEqual(replayResult.appliedTransitionsCount, 0, 'Replay must apply 0 transitions');
      assert.strictEqual(replayResult.appliedNewOrdersCount, 0, 'Replay must apply 0 new orders');
      console.log('  ✓ Test 2 Passed: Second pass executed idempotently with zero unintended side effects');
    }

    // =========================================================================
    // SECTION 2: Correction A — Strengthened Environment Authorization
    // =========================================================================
    console.log('\n--- Correction A Tests: Strengthened Environment Authorization ---');

    console.log('  Subtest A1: Refusal on "procurepilot" database');
    {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('current_database()')) {
              return { rows: [{ current_database: 'procurepilot' }] };
            }
            return { rows: [] };
          },
          release: () => {},
        }),
      } as unknown as Pool;

      const reconciler = new DeltaReconciler({
        pool: mockPool,
        dryRun: false,
        allowMutations: true,
        authorizedTargetDatabase: 'procurepilot',
        disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /Refusing mutating execution against protected cluster database "procurepilot"/,
        'Must strictly refuse mutating execution against protected cluster database procurepilot'
      );
      console.log('    ✓ Subtest A1 Passed: Refused execution against protected "procurepilot"');
    }

    console.log('  Subtest A2: Refusal on "postgres" maintenance database');
    {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('current_database()')) {
              return { rows: [{ current_database: 'postgres' }] };
            }
            return { rows: [] };
          },
          release: () => {},
        }),
      } as unknown as Pool;

      const reconciler = new DeltaReconciler({
        pool: mockPool,
        dryRun: false,
        allowMutations: true,
        authorizedTargetDatabase: 'postgres',
        disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /Refusing mutating execution against protected cluster database "postgres"/,
        'Must strictly refuse mutating execution against protected maintenance database postgres'
      );
      console.log('    ✓ Subtest A2 Passed: Refused execution against maintenance "postgres"');
    }

    console.log('  Subtest A3: Refusal on non-allowlisted database name');
    {
      const mockPool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('current_database()')) {
              return { rows: [{ current_database: 'procurepilot_production_replica' }] };
            }
            return { rows: [] };
          },
          release: () => {},
        }),
      } as unknown as Pool;

      const reconciler = new DeltaReconciler({
        pool: mockPool,
        dryRun: false,
        allowMutations: true,
        authorizedTargetDatabase: 'procurepilot_production_replica',
        disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /is not on the positive allowlist of authorized disposable test databases/,
        'Must reject non-disposable database names'
      );
      console.log('    ✓ Subtest A3 Passed: Non-allowlisted database name rejected');
    }

    console.log('  Subtest A4: Refusal when allowMutations: true is absent');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dryRun: false,
        authorizedTargetDatabase: testDbName,
        disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /requires explicit affirmative option 'allowMutations: true'/,
        'Must reject mutating execution without explicit allowMutations: true'
      );
      console.log('    ✓ Subtest A4 Passed: Missing allowMutations flag rejected');
    }

    console.log('  Subtest A5: Refusal when authorizedTargetDatabase does not match connected database');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dryRun: false,
        allowMutations: true,
        authorizedTargetDatabase: 'procurepilot_delta_test_wrong_target_db',
        disposableEnvironmentMarker: 'DISPOSABLE_TEST_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /does not match explicitly authorized target database/,
        'Must reject execution when authorizedTargetDatabase does not match actual db'
      );
      console.log('    ✓ Subtest A5 Passed: Target database mismatch rejected');
    }

    console.log('  Subtest A6: Refusal when disposableEnvironmentMarker is missing or invalid');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dryRun: false,
        allowMutations: true,
        authorizedTargetDatabase: testDbName,
        disposableEnvironmentMarker: 'PRODUCTION_ENVIRONMENT',
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /requires valid disposable environment marker/,
        'Must reject invalid disposable environment marker'
      );
      console.log('    ✓ Subtest A6 Passed: Invalid environment marker rejected');
    }

    console.log('  Subtest A7: Dry-run defaults to true and applies 0 mutations');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const targetFile = '71F126573R549662J.json';
      const targetPath = path.join(staging.orders, targetFile);
      const orderData = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      orderData.status = 'BUYER_APPROVED';
      fs.writeFileSync(targetPath, JSON.stringify(orderData, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
      });

      const res = await reconciler.reconcile();
      assert.strictEqual(res.dryRun, true, 'dryRun must be true');
      assert.strictEqual(res.appliedTransitionsCount, 0, 'Must apply 0 transitions in dry run');

      const dbCheck = await testPool.query<{ status: string }>(
        `SELECT status FROM orders WHERE external_order_id = '71F126573R549662J'`
      );
      assert.strictEqual(dbCheck.rows[0].status, 'PENDING_PAYMENT_APPROVAL', 'Database status must remain unchanged');
      console.log('    ✓ Subtest A7 Passed: dryRun defaults to true; 0 mutations committed to database');
    }

    console.log('  Subtest A8: Refusal when expectedClusterSystemIdentifier does not match');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        ...validMutationOptions,
        expectedClusterSystemIdentifier: '9999999999999999999', // Mismatched cluster system id
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /does not match expected disposable cluster identifier/,
        'Must reject execution when cluster system identifier does not match'
      );
      console.log('    ✓ Subtest A8 Passed: Cluster system identifier mismatch strictly rejected');
    }

    console.log('  Subtest A9: Refusal when expectedServerHost does not match');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        ...validMutationOptions,
        expectedServerHost: '10.254.254.254', // Mismatched host
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /does not match expected disposable host/,
        'Must reject execution when host address does not match'
      );
      console.log('    ✓ Subtest A9 Passed: Server host mismatch strictly rejected');
    }

    console.log('  Subtest A10: Refusal when expectedServerPort does not match');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        ...validMutationOptions,
        expectedServerPort: 5433, // Mismatched port
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /does not match expected disposable port/,
        'Must reject execution when port does not match'
      );
      console.log('    ✓ Subtest A10 Passed: Server port mismatch strictly rejected');
    }

    console.log('  Subtest A11: Refusal when expectedDatabaseUser does not match');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        ...validMutationOptions,
        expectedDatabaseUser: 'unauthorized_super_user', // Mismatched user
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /does not match expected restricted reconciliation user/,
        'Must reject execution when database user does not match restricted role'
      );
      console.log('    ✓ Subtest A11 Passed: Restricted database user mismatch strictly rejected');
    }

    // =========================================================================
    // SECTION 3: Correction C — Strict HMAC-to-Status Binding
    // =========================================================================
    console.log('\n--- Correction C Tests: Strict HMAC-to-Status Binding ---');

    let validPendingTicketId: string;
    let validApprovedTicketId: string;
    let validConsumedTicketId: string;

    console.log('  Subtest B1: PENDING_APPROVAL + valid challenge signature: accepted');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      validPendingTicketId = `appr_tk_pend_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const items = [{ productId: 'item-01', name: 'Item 1', quantity: 1, unitPrice: 100.0, lineTotal: 100.0 }];
      const fp = approvalService.calculateCartFingerprint(
        [{ productId: 'item-01', quantity: 1, unitPrice: 100.0 }],
        100.0,
        'USD'
      );
      const challengeSig = approvalService.signChallenge(validPendingTicketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${validPendingTicketId}.json`),
        JSON.stringify(
          {
            ticketId: validPendingTicketId,
            nonce,
            cartFingerprint: fp,
            signature: challengeSig,
            status: 'PENDING_APPROVAL',
            verifiedTotal: '100.00',
            verifiedSubtotal: '100.00',
            expiresAt,
            verifiedItems: items,
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === validPendingTicketId);
      assert.strictEqual(item?.category, 'NEW_RUNTIME_RECORD');
      assert.strictEqual(item?.integrityStatus, 'VERIFIED');

      const res = await reconciler.reconcile();
      assert.strictEqual(res.success, true);
      console.log('    ✓ Subtest B1 Passed: Pending ticket with valid challenge signature accepted');
    }

    console.log('  Subtest B2: PENDING_APPROVAL + valid approved-token signature: rejected (state-binding violation)');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_pend_wrong_sig_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      // Compute approved-token signature for a pending ticket
      const authSig = approvalService.signAuthToken(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify(
          {
            ticketId,
            nonce,
            cartFingerprint: fp,
            signature: authSig, // Auth token signature used for PENDING ticket
            status: 'PENDING_APPROVAL',
            verifiedTotal: '100.00',
            expiresAt,
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /State-binding violation.*auth token signature/);
      console.log('    ✓ Subtest B2 Passed: Pending ticket with approved-token signature strictly rejected');
    }

    console.log('  Subtest B3: APPROVED + valid approved-token signature: accepted');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      validApprovedTicketId = `appr_tk_appr_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const items = [{ productId: 'item-02', name: 'Item 2', quantity: 2, unitPrice: 75.0, lineTotal: 150.0 }];
      const fp = approvalService.calculateCartFingerprint(
        [{ productId: 'item-02', quantity: 2, unitPrice: 75.0 }],
        150.0,
        'USD'
      );
      const authSig = approvalService.signAuthToken(validApprovedTicketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${validApprovedTicketId}.json`),
        JSON.stringify(
          {
            ticketId: validApprovedTicketId,
            nonce,
            cartFingerprint: fp,
            signature: authSig,
            status: 'APPROVED',
            verifiedTotal: '150.00',
            expiresAt,
            verifiedItems: items,
            signoff: {
              userName: 'Chief Procurement Officer',
              department: 'Executive',
              signedAt: new Date().toISOString(),
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === validApprovedTicketId);
      assert.strictEqual(item?.category, 'NEW_RUNTIME_RECORD');
      assert.strictEqual(item?.integrityStatus, 'VERIFIED');

      const res = await reconciler.reconcile();
      assert.strictEqual(res.success, true);
      console.log('    ✓ Subtest B3 Passed: Approved ticket with valid approved-token signature accepted');
    }

    console.log('  Subtest B4: APPROVED + valid challenge signature: rejected (state-binding violation)');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_appr_wrong_sig_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      // Compute challenge signature for an approved ticket
      const challengeSig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify(
          {
            ticketId,
            nonce,
            cartFingerprint: fp,
            signature: challengeSig, // Challenge signature used for APPROVED ticket
            status: 'APPROVED',
            verifiedTotal: '100.00',
            expiresAt,
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /State-binding violation.*unapproved challenge signature/);
      console.log('    ✓ Subtest B4 Passed: Approved ticket with challenge signature strictly rejected');
    }

    console.log('  Subtest B5: CONSUMED + valid approved-token signature + consumedAt: accepted');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      validConsumedTicketId = `appr_tk_cons_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const authSig = approvalService.signAuthToken(validConsumedTicketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${validConsumedTicketId}.json`),
        JSON.stringify(
          {
            ticketId: validConsumedTicketId,
            nonce,
            cartFingerprint: fp,
            signature: authSig,
            status: 'CONSUMED',
            verifiedTotal: '100.00',
            expiresAt,
            consumedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === validConsumedTicketId);
      assert.strictEqual(item?.category, 'NEW_RUNTIME_RECORD');
      assert.strictEqual(item?.integrityStatus, 'VERIFIED');

      const res = await reconciler.reconcile();
      assert.strictEqual(res.success, true);
      console.log('    ✓ Subtest B5 Passed: Consumed ticket with valid auth token and consumedAt accepted');
    }

    console.log('  Subtest B6: CONSUMED + valid challenge signature: rejected (state-binding violation)');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_cons_wrong_sig_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const challengeSig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify(
          {
            ticketId,
            nonce,
            cartFingerprint: fp,
            signature: challengeSig,
            status: 'CONSUMED',
            verifiedTotal: '100.00',
            expiresAt,
            consumedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /State-binding violation.*CONSUMED/);
      console.log('    ✓ Subtest B6 Passed: Consumed ticket with challenge signature strictly rejected');
    }

    console.log('  Subtest B7: CONSUMED + missing consumedAt: rejected (lifecycle violation)');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_cons_missing_ts_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const authSig = approvalService.signAuthToken(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify(
          {
            ticketId,
            nonce,
            cartFingerprint: fp,
            signature: authSig,
            status: 'CONSUMED',
            verifiedTotal: '100.00',
            expiresAt,
            // consumedAt is missing!
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Lifecycle violation.*consumedAt timestamp/);
      console.log('    ✓ Subtest B7 Passed: Consumed ticket missing consumedAt timestamp strictly rejected');
    }

    console.log('  Subtest B8: Unsupported/invalid status: rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_unsupported_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const challengeSig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify(
          {
            ticketId,
            nonce,
            cartFingerprint: fp,
            signature: challengeSig,
            status: 'SOME_FAKE_STATUS',
            verifiedTotal: '100.00',
            expiresAt,
          },
          null,
          2
        ),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Unsupported or invalid runtime approval status/);
      console.log('    ✓ Subtest B8 Passed: Unsupported runtime status strictly rejected');
    }

    console.log('  Subtest B9: Random 32-byte (64 hex char) signature rejected as forged');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const forgedTicketId = `appr_tk_forged_${Date.now()}`;
      const forgedSig = crypto.randomBytes(32).toString('hex');
      const forgedApproval = {
        ticketId: forgedTicketId,
        nonce: crypto.randomBytes(32).toString('hex'),
        cartFingerprint: crypto.randomBytes(32).toString('hex'),
        signature: forgedSig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '100.00',
        expiresAt: Date.now() + 3600000,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${forgedTicketId}.json`),
        JSON.stringify(forgedApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === forgedTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cryptographic challenge verification failed/);
      console.log('    ✓ Subtest B9 Passed: Random 64-hex forged signature strictly rejected');
    }

    console.log('  Subtest B10: Tampered verifiedTotal rejected (cart fingerprint binding check)');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const tamperedTotalTicketId = `appr_tk_tamper_total_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const items = [{ productId: 'item-01', name: 'Item', quantity: 1, unitPrice: 50.0, lineTotal: 50.0 }];
      const validFp = approvalService.calculateCartFingerprint(
        [{ productId: 'item-01', quantity: 1, unitPrice: 50.0 }],
        50.0,
        'USD'
      );
      const sig = approvalService.signChallenge(tamperedTotalTicketId, validFp, nonce, expiresAt);

      const tamperedApproval = {
        ticketId: tamperedTotalTicketId,
        nonce,
        cartFingerprint: validFp,
        signature: sig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '999.00', // TAMPERED TOTAL
        expiresAt,
        verifiedItems: items,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${tamperedTotalTicketId}.json`),
        JSON.stringify(tamperedApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === tamperedTotalTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cart fingerprint tampering/);
      console.log('    ✓ Subtest B10 Passed: Tampered verifiedTotal rejected via cart fingerprint binding');
    }

    console.log('  Subtest B11: Tampered cartFingerprint rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const tamperedFpTicketId = `appr_tk_tamper_fp_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const validFp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(tamperedFpTicketId, validFp, nonce, expiresAt);

      const tamperedApproval = {
        ticketId: tamperedFpTicketId,
        nonce,
        cartFingerprint: crypto.randomBytes(32).toString('hex'), // TAMPERED FINGERPRINT
        signature: sig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '50.00',
        expiresAt,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${tamperedFpTicketId}.json`),
        JSON.stringify(tamperedApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === tamperedFpTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cryptographic challenge verification failed/);
      console.log('    ✓ Subtest B11 Passed: Tampered cartFingerprint strictly rejected');
    }

    console.log('  Subtest B12: Tampered nonce rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const tamperedNonceTicketId = `appr_tk_tamper_nonce_${Date.now()}`;
      const originalNonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(tamperedNonceTicketId, fp, originalNonce, expiresAt);

      const tamperedApproval = {
        ticketId: tamperedNonceTicketId,
        nonce: crypto.randomBytes(32).toString('hex'), // TAMPERED NONCE
        cartFingerprint: fp,
        signature: sig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '50.00',
        expiresAt,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${tamperedNonceTicketId}.json`),
        JSON.stringify(tamperedApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === tamperedNonceTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cryptographic challenge verification failed/);
      console.log('    ✓ Subtest B12 Passed: Tampered nonce strictly rejected');
    }

    console.log('  Subtest B13: Tampered expiresAt rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const tamperedExpTicketId = `appr_tk_tamper_exp_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const originalExpiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(tamperedExpTicketId, fp, nonce, originalExpiresAt);

      const tamperedApproval = {
        ticketId: tamperedExpTicketId,
        nonce,
        cartFingerprint: fp,
        signature: sig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '50.00',
        expiresAt: originalExpiresAt + 86400000, // TAMPERED (+24h)
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${tamperedExpTicketId}.json`),
        JSON.stringify(tamperedApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === tamperedExpTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cryptographic challenge verification failed/);
      console.log('    ✓ Subtest B13 Passed: Tampered expiresAt strictly rejected');
    }

    console.log('  Subtest B14: Missing signature rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const missingSigTicketId = `appr_tk_missing_sig_${Date.now()}`;
      const missingSigApproval = {
        ticketId: missingSigTicketId,
        nonce: crypto.randomBytes(32).toString('hex'),
        cartFingerprint: crypto.randomBytes(32).toString('hex'),
        status: 'PENDING_APPROVAL',
        verifiedTotal: '50.00',
        expiresAt: Date.now() + 3600000,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${missingSigTicketId}.json`),
        JSON.stringify(missingSigApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === missingSigTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /lacks valid 64-character hexadecimal HMAC signature/);
      console.log('    ✓ Subtest B14 Passed: Missing signature rejected');
    }

    console.log('  Subtest B15: Expired pending ticket rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const expiredTicketId = `appr_tk_expired_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiredAt = Date.now() - 3600000; // Expired 1 hour ago
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(expiredTicketId, fp, nonce, expiredAt);

      const expiredApproval = {
        ticketId: expiredTicketId,
        nonce,
        cartFingerprint: fp,
        signature: sig,
        status: 'PENDING_APPROVAL',
        verifiedTotal: '50.00',
        expiresAt: expiredAt,
      };

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${expiredTicketId}.json`),
        JSON.stringify(expiredApproval, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === expiredTicketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Runtime approval ticket has expired/);
      console.log('    ✓ Subtest B15 Passed: Expired pending approval ticket rejected');
    }

    console.log('  Subtest B16: Explicit empty secret rejected fail-closed');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_no_secret_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify({ ticketId, nonce, cartFingerprint: fp, signature: sig, status: 'PENDING_APPROVAL', verifiedTotal: '50.00', expiresAt }, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        hmacSecret: '', // Secret empty
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Server HMAC secret is unavailable or empty/);
      console.log('    ✓ Subtest B16 Passed: Explicit empty secret rejected fail-closed');
    }

    console.log('  Subtest B16a: Omitted secret with APPROVAL_SECRET absent rejected fail-closed');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_no_appr_sec_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify({ ticketId, nonce, cartFingerprint: fp, signature: sig, status: 'PENDING_APPROVAL', verifiedTotal: '50.00', expiresAt }, null, 2),
        'utf8'
      );

      const savedAppr = process.env.APPROVAL_SECRET;
      const savedAuth = process.env.NEXTAUTH_SECRET;
      try {
        delete process.env.APPROVAL_SECRET;
        process.env.NEXTAUTH_SECRET = '';

        const reconciler = new DeltaReconciler({
          pool: testPool,
          dataDir: staging.root,
          failOnConflict: false,
        });

        const analysis = await reconciler.analyze();
        const item = analysis.approvals.find((a) => a.ticketId === ticketId);
        assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
        assert.match(item?.reason || '', /Server HMAC secret is unavailable or empty/);
        console.log('    ✓ Subtest B16a Passed: Omitted secret with APPROVAL_SECRET absent rejected fail-closed');
      } finally {
        if (savedAppr !== undefined) process.env.APPROVAL_SECRET = savedAppr;
        if (savedAuth !== undefined) process.env.NEXTAUTH_SECRET = savedAuth;
      }
    }

    console.log('  Subtest B16b: Omitted secret with both APPROVAL_SECRET and NEXTAUTH_SECRET absent rejected fail-closed');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_no_env_sec_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(ticketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify({ ticketId, nonce, cartFingerprint: fp, signature: sig, status: 'PENDING_APPROVAL', verifiedTotal: '50.00', expiresAt }, null, 2),
        'utf8'
      );

      const savedAppr = process.env.APPROVAL_SECRET;
      const savedAuth = process.env.NEXTAUTH_SECRET;
      try {
        delete process.env.APPROVAL_SECRET;
        delete process.env.NEXTAUTH_SECRET;

        const reconciler = new DeltaReconciler({
          pool: testPool,
          dataDir: staging.root,
          failOnConflict: false,
        });

        const analysis = await reconciler.analyze();
        const item = analysis.approvals.find((a) => a.ticketId === ticketId);
        assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
        assert.match(item?.reason || '', /Server HMAC secret is unavailable or empty/);
        console.log('    ✓ Subtest B16b Passed: Omitted secret with both secrets absent rejected fail-closed');
      } finally {
        if (savedAppr !== undefined) process.env.APPROVAL_SECRET = savedAppr;
        if (savedAuth !== undefined) process.env.NEXTAUTH_SECRET = savedAuth;
      }
    }

    console.log('  Subtest B16c: Explicit valid secret accepts valid signature');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_valid_explicit_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const dedicatedSecret = `dedicated_secret_${crypto.randomBytes(16).toString('hex')}`;
      const sig = crypto.createHmac('sha256', dedicatedSecret).update(`${ticketId}:${fp}:${nonce}:${expiresAt}`).digest('hex');

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify({ ticketId, nonce, cartFingerprint: fp, signature: sig, status: 'PENDING_APPROVAL', verifiedTotal: '50.00', expiresAt }, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        hmacSecret: dedicatedSecret,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'NEW_RUNTIME_RECORD');
      assert.strictEqual(item?.integrityStatus, 'VERIFIED');
      console.log('    ✓ Subtest B16c Passed: Explicit valid secret accepts valid signature');
    }

    console.log('  Subtest B17: Wrong HMAC secret rejected');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ticketId = `appr_tk_wrong_secret_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      // Sign with a different secret
      const wrongSig = crypto.createHmac('sha256', 'completely_wrong_secret_key_12345').update(`${ticketId}:${fp}:${nonce}:${expiresAt}`).digest('hex');

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ticketId}.json`),
        JSON.stringify({ ticketId, nonce, cartFingerprint: fp, signature: wrongSig, status: 'PENDING_APPROVAL', verifiedTotal: '50.00', expiresAt }, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.approvals.find((a) => a.ticketId === ticketId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Cryptographic challenge verification failed/);
      console.log('    ✓ Subtest B17 Passed: Signature with wrong HMAC secret rejected');
    }

    // =========================================================================
    // SECTION 4: Correction D & E — SQL Overloads, Immutability & Attribution
    // =========================================================================
    console.log('\n--- Correction D & E Tests: Overload Resolution, Immutability & Attribution ---');

    console.log('  Subtest C1: PUBLIC execution on reconcile_legacy_order_status_transition denied');
    {
      const unprivUser = `unpriv_user_${Date.now()}`;
      const unprivPass = `pass_${crypto.randomBytes(8).toString('hex')}`;
      const adminClient = new Client({ ...baseConfig, database: testDbName });
      await adminClient.connect();

      try {
        await adminClient.query(
          `CREATE ROLE "${unprivUser}" WITH LOGIN PASSWORD '${unprivPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
        );
        await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${unprivUser}"`);

        const unprivClient = new Client({
          ...baseConfig,
          database: testDbName,
          user: unprivUser,
          password: unprivPass,
        });
        await unprivClient.connect();

        try {
          await assert.rejects(
            async () =>
              unprivClient.query(
                `SELECT reconcile_legacy_order_status_transition(
                  '00000000-0000-0000-0000-000000000000'::uuid,
                  'PENDING_PAYMENT_APPROVAL'::varchar(32),
                  'BUYER_APPROVED'::varchar(32),
                  'TEST'::text,
                  'ATTACKER'::varchar(128)
                )`
              ),
            /permission denied for function reconcile_legacy_order_status_transition/,
            'Unprivileged user must be denied EXECUTE on 5-arg reconcile procedure'
          );

          await assert.rejects(
            async () =>
              unprivClient.query(
                `SELECT reconcile_legacy_order_status_transition(
                  '00000000-0000-0000-0000-000000000000'::uuid,
                  'PENDING_PAYMENT_APPROVAL'::varchar(32),
                  'BUYER_APPROVED'::varchar(32),
                  'TEST'::text
                )`
              ),
            /permission denied for function reconcile_legacy_order_status_transition/,
            'Unprivileged user must be denied EXECUTE on 4-arg reconcile procedure'
          );
          console.log('    ✓ Subtest C1 Passed: PUBLIC execution strictly denied on both 4-arg and 5-arg overloads');
        } finally {
          await unprivClient.end();
          await adminClient.query(`DROP OWNED BY "${unprivUser}"`);
          await adminClient.query(`DROP ROLE IF EXISTS "${unprivUser}"`);
        }
      } finally {
        await adminClient.end();
      }
    }

    console.log('  Subtest C2: Direct status UPDATE on legacy order without procedure rejected by trigger');
    {
      assert.ok(testPool);
      const pool = testPool;
      await assert.rejects(
        async () =>
          pool.query(
            `UPDATE orders SET status = 'BUYER_APPROVED' WHERE external_order_id = '71F126573R549662J'`
          ),
        /Security violation: direct legacy order status updates are strictly prohibited/,
        'Direct UPDATE on legacy order without procedure must be blocked by trigger'
      );
      console.log('    ✓ Subtest C2 Passed: Direct legacy order UPDATE blocked by provenance trigger');
    }

    console.log('  Subtest C3: UPDATE and DELETE on order_state_transition_audit rejected by immutability trigger');
    {
      assert.ok(testPool);
      const pool = testPool;
      const sampleOrder = await pool.query<{ id: string; order_number: string }>(
        `SELECT id, order_number FROM orders WHERE external_order_id <> '71F126573R549662J' LIMIT 1`
      );
      const sampleOrderId = sampleOrder.rows[0].id;
      const sampleOrderNum = sampleOrder.rows[0].order_number;

      const insertRes = await pool.query<{ id: string }>(
        `INSERT INTO order_state_transition_audit (
          order_id, order_number, old_status, new_status, transition_reason, operator_identity, session_user_val, current_user_val
        ) VALUES (
          $1, $2, 'DRAFT', 'BUYER_APPROVED', 'TEST', 'TEST_OPERATOR', 'postgres', 'postgres'
        ) RETURNING id`,
        [sampleOrderId, sampleOrderNum]
      );
      const auditId = insertRes.rows[0].id;

      await assert.rejects(
        async () =>
          pool.query(
            `UPDATE order_state_transition_audit SET old_status = 'TAMPERED' WHERE id = $1`,
            [auditId]
          ),
        /Immutability violation: order_state_transition_audit rows are strictly append-only/,
        'UPDATE on order_state_transition_audit must be blocked by immutability trigger'
      );

      await assert.rejects(
        async () =>
          pool.query(
            `DELETE FROM order_state_transition_audit WHERE id = $1`,
            [auditId]
          ),
        /Immutability violation: order_state_transition_audit rows are strictly append-only/,
        'DELETE on order_state_transition_audit must be blocked by immutability trigger'
      );
      console.log('    ✓ Subtest C3 Passed: UPDATE and DELETE on audit trail strictly blocked (append-only)');
    }

    console.log('  Subtest C4: Operator identity recorded in audit table via 5-argument procedure');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const targetFile = '71F126573R549662J.json';
      const targetPath = path.join(staging.orders, targetFile);
      const orderData = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      orderData.status = 'BUYER_APPROVED';
      fs.writeFileSync(targetPath, JSON.stringify(orderData, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        operatorId: 'operator_c4_attribution_tester',
        ...validMutationOptions,
      });

      const res = await reconciler.reconcile();
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.appliedTransitionsCount, 1);

      assert.ok(testPool);
      const auditRow = await testPool.query<{
        operator_identity: string;
        old_status: string;
        new_status: string;
      }>(
        `SELECT operator_identity, old_status, new_status
         FROM order_state_transition_audit
         WHERE order_number = $1 AND operator_identity = 'operator_c4_attribution_tester'`,
        [generateLegacyOrderNumber('71F126573R549662J')]
      );

      assert.strictEqual(auditRow.rows.length, 1);
      assert.strictEqual(auditRow.rows[0].operator_identity, 'operator_c4_attribution_tester');
      assert.strictEqual(auditRow.rows[0].old_status, 'PENDING_PAYMENT_APPROVAL');
      assert.strictEqual(auditRow.rows[0].new_status, 'BUYER_APPROVED');
      order71FStatus = 'BUYER_APPROVED';
      console.log('    ✓ Subtest C4 Passed: Operator identity properly recorded in audit table');
    }

    console.log('  Subtest C5: 4-argument compatibility wrapper successfully resolves and audits transition');
    {
      assert.ok(testPool);
      // Target order: 71F126573R549662J (transition from BUYER_APPROVED to SETTLING)
      const targetOrder = await testPool.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE external_order_id = '71F126573R549662J'`
      );
      assert.strictEqual(targetOrder.rows.length, 1);
      const orderId = targetOrder.rows[0].id;
      const currentStatus = targetOrder.rows[0].status; // BUYER_APPROVED

      // Call the 4-argument overload (transitions BUYER_APPROVED -> SETTLING)
      await testPool.query(
        `SELECT reconcile_legacy_order_status_transition($1, $2, $3, $4)`,
        [orderId, currentStatus, 'SETTLING', 'TEST_4_ARG_WRAPPER']
      );

      // Verify order status updated
      const updatedOrder = await testPool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId]
      );
      assert.strictEqual(updatedOrder.rows[0].status, 'SETTLING');

      // Verify audit record exists with UNAUTHENTICATED_SYSTEM_CONTEXT fallback
      const auditRow = await testPool.query<{
        operator_identity: string;
        old_status: string;
        new_status: string;
        transition_reason: string;
      }>(
        `SELECT operator_identity, old_status, new_status, transition_reason
         FROM order_state_transition_audit
         WHERE order_id = $1 AND transition_reason = 'TEST_4_ARG_WRAPPER'`,
        [orderId]
      );
      assert.strictEqual(auditRow.rows.length, 1);
      assert.strictEqual(auditRow.rows[0].old_status, 'BUYER_APPROVED');
      assert.strictEqual(auditRow.rows[0].new_status, 'SETTLING');
      assert.strictEqual(auditRow.rows[0].operator_identity, 'UNAUTHENTICATED_SYSTEM_CONTEXT');
      order71FStatus = 'SETTLING';
      console.log('    ✓ Subtest C5 Passed: 4-argument wrapper resolved, updated status, and logged fallback audit');
    }

    // =========================================================================
    // SECTION 5: Correction B — Flat-File Payment Capture De-authorization
    // =========================================================================
    console.log('\n--- Correction B Tests: Complete Flat-File Capture De-authorization ---');

    console.log('  Subtest D1: Untrusted flat-file combining forged providerEvidence, non-sandbox ID, fake capture ID, and PAYPAL_API origin strictly blocked');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const ordTicketId = `appr_tk_d1_attack_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(ordTicketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${ordTicketId}.json`),
        JSON.stringify(
          {
            ticketId: ordTicketId,
            nonce,
            cartFingerprint: fp,
            signature: sig,
            status: 'PENDING_APPROVAL',
            verifiedTotal: '500.00',
            expiresAt,
          },
          null,
          2
        ),
        'utf8'
      );

      // Highly adversarial order flatfile with forged providerEvidence
      const fraudOrderId = `GENUINE_LOOKING_ORD_999_${Date.now()}`;
      const fraudCapId = `9XX99999YY888888Z_${Date.now()}`;
      const fraudOrder = {
        orderId: fraudOrderId,
        ticketId: ordTicketId,
        status: 'SETTLING',
        authorizedTotal: '500.00',
        currency: 'USD',
        isSimulated: false,
        captureId: fraudCapId,
        captureOrigin: 'PAYPAL_API',
        providerEvidence: {
          verified: true,
          captureId: fraudCapId,
        },
      };

      fs.writeFileSync(
        path.join(staging.orders, `order-${fraudOrderId}.json`),
        JSON.stringify(fraudOrder, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      // Must be 0 genuine captures!
      assert.strictEqual(analysis.genuineCapturesCount, 0, 'Genuine captures count must be exactly 0 for flatfile');
      assert.ok(analysis.syntheticCapturesSegregatedCount >= 1, 'Must be counted under segregated captures');

      const res = await reconciler.reconcile();
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.appliedGenuineCapturesCount, 0, 'Must apply exactly 0 captures into payment_captures');

      assert.ok(testPool);
      const capCheck = await testPool.query(
        `SELECT id FROM payment_captures WHERE external_capture_id = $1`,
        [fraudCapId]
      );
      assert.strictEqual(capCheck.rows.length, 0, 'Forged capture MUST NOT be inserted into payment_captures ledger');
      console.log('    ✓ Subtest D1 Passed: All 5 adversarial capture spoof vectors de-authorized (0 inserted)');
    }

    console.log('  Subtest D2: Synthetic capture (CAP_*, isSimulated: true) segregated cleanly from ledger');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const simTicketId = `appr_tk_sim_d2_${Date.now()}`;
      const nonce = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000;
      const fp = crypto.randomBytes(32).toString('hex');
      const sig = approvalService.signChallenge(simTicketId, fp, nonce, expiresAt);

      fs.writeFileSync(
        path.join(staging.approvals, `approval-${simTicketId}.json`),
        JSON.stringify(
          {
            ticketId: simTicketId,
            nonce,
            cartFingerprint: fp,
            signature: sig,
            status: 'PENDING_APPROVAL',
            verifiedTotal: '50.00',
            expiresAt,
          },
          null,
          2
        ),
        'utf8'
      );

      const simulatedOrderId = `SANDBOX_SIM_ORDER_D2_${Date.now()}`;
      const simOrder = {
        orderId: simulatedOrderId,
        ticketId: simTicketId,
        status: 'SETTLING',
        authorizedTotal: '50.00',
        currency: 'USD',
        isSimulated: true,
        captureId: 'CAP_SANDBOX_STAGE2_MOCK_99999',
        captureOrigin: 'LOCAL_SYNTHETIC_TEST',
      };
      fs.writeFileSync(
        path.join(staging.orders, `order-${simulatedOrderId}.json`),
        JSON.stringify(simOrder, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      assert.ok(analysis.syntheticCapturesSegregatedCount >= 1, 'Synthetic capture recognized as segregated');

      const result = await reconciler.reconcile();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.appliedGenuineCapturesCount, 0);

      assert.ok(testPool);
      const ordCheck = await testPool.query<{ is_simulated: boolean }>(
        `SELECT is_simulated FROM orders WHERE external_order_id = $1`,
        [simulatedOrderId]
      );
      assert.strictEqual(ordCheck.rows.length, 1);
      assert.strictEqual(ordCheck.rows[0].is_simulated, true);

      const capCheck = await testPool.query(
        `SELECT id FROM payment_captures WHERE external_capture_id = 'CAP_SANDBOX_STAGE2_MOCK_99999'`
      );
      assert.strictEqual(capCheck.rows.length, 0, 'Synthetic capture must NOT enter payment_captures ledger');
      console.log('    ✓ Subtest D2 Passed: Synthetic capture cleanly segregated from financial ledger');
    }

    // =========================================================================
    // SECTION 6: General State, Anti-Tampering, Quarantined & Atomic Replay Matrix
    // =========================================================================
    console.log('\n--- General State & Anti-Tampering Scenarios ---');

    console.log('  Test 4: Immutable Field Tampering Rejection');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const targetFile = '8HX63874LW066860W.json';
      const targetPath = path.join(staging.orders, targetFile);
      const orderData = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      orderData.authorizedTotal = '9999.99'; // Tampered amount
      fs.writeFileSync(targetPath, JSON.stringify(orderData, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      assert.strictEqual(analysis.hasConflicts, true, 'Must report conflicts');
      const tampered = analysis.orders.find((o) => o.orderId === '8HX63874LW066860W');
      assert.ok(tampered);
      assert.strictEqual(tampered?.category, 'CONFLICT_REJECTED');
      assert.strictEqual(tampered?.immutableFieldsMatch, false);

      const strictReconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: true,
        ...validMutationOptions,
      });
      await assert.rejects(
        async () => strictReconciler.reconcile(),
        /conflicting records detected/i,
        'Must reject execution when conflict is detected'
      );

      assert.ok(testPool);
      const dbCheck = await testPool.query<{ authorized_total: string }>(
        `SELECT authorized_total::text FROM orders WHERE external_order_id = '8HX63874LW066860W'`
      );
      assert.strictEqual(dbCheck.rows[0].authorized_total, '294.54', 'Authorized total must remain unchanged in DB');
      console.log('    ✓ Test 4 Passed: Monetary tampering detected and blocked fail-closed');
    }

    console.log('  Test 5: Illegal State Transition Rejection');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const targetFile = 'SANDBOX_STAGE2_179399833345.json';
      const targetPath = path.join(staging.orders, targetFile);
      const orderData = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      orderData.status = 'DRAFT'; // Illegal backward transition from COMPLETED
      fs.writeFileSync(targetPath, JSON.stringify(orderData, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const illegalItem = analysis.orders.find((o) => o.orderId === 'SANDBOX_STAGE2_179399833345');
      assert.strictEqual(illegalItem?.category, 'CONFLICT_REJECTED');
      assert.match(illegalItem?.reason || '', /Illegal state transition/);
      console.log('    ✓ Test 5 Passed: Illegal state-machine jump strictly rejected');
    }

    console.log('  Test 6: Cross-Record Identity Spoofing Rejection');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const spoofOrder = {
        orderId: 'SPOOF_ORDER_IDENTITY_01',
        orderNumber: generateLegacyOrderNumber('8HX63874LW066860W'),
        ticketId: 'appr_tk_1794007620021_1567915a512c835e',
        status: 'PENDING_APPROVAL',
        authorizedTotal: 100.0,
      };
      fs.writeFileSync(path.join(staging.orders, 'order-spoof.json'), JSON.stringify(spoofOrder, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const spoofItem = analysis.orders.find((o) => o.orderId === 'SPOOF_ORDER_IDENTITY_01');
      assert.strictEqual(spoofItem?.category, 'CONFLICT_REJECTED');
      assert.match(spoofItem?.reason || '', /Cross-record identity attack/);
      console.log('    ✓ Test 6 Passed: Cross-record identity collision detected and rejected');
    }

    console.log('  Test 9: New Runtime Order Creation linked to verified runtime approval');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const runtimeOrderId = `RT_ORDER_B422_${Date.now()}`;
      const newOrder = {
        orderId: runtimeOrderId,
        ticketId: validApprovedTicketId, // References verified ticket from B3
        status: 'BUYER_APPROVED',
        authorizedTotal: '150.00',
        authorizedSubtotal: '150.00',
        authorizedTax: '0.00',
        authorizedShipping: '0.00',
        currency: 'USD',
        isSimulated: false,
        items: [
          {
            productId: 'item-02',
            name: 'Item 2',
            quantity: 2,
            unitPrice: 75.0,
            lineTotal: 150.0,
          },
        ],
      };
      fs.writeFileSync(
        path.join(staging.orders, `order-${runtimeOrderId}.json`),
        JSON.stringify(newOrder, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        ...validMutationOptions,
      });

      const analysis = await reconciler.analyze();
      assert.strictEqual(analysis.newRuntimeOrdersCount, 1);
      const ordItem = analysis.orders.find((o) => o.orderId === runtimeOrderId);
      assert.strictEqual(ordItem?.category, 'NEW_RUNTIME_RECORD');

      const result = await reconciler.reconcile();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.appliedNewOrdersCount, 1);

      assert.ok(testPool);
      const dbCheck = await testPool.query<{ source_origin: string; ticket_id: string }>(
        `SELECT source_origin, ticket_id FROM orders WHERE external_order_id = $1`,
        [runtimeOrderId]
      );
      assert.strictEqual(dbCheck.rows.length, 1);
      assert.strictEqual(dbCheck.rows[0].source_origin, 'RUNTIME');
      assert.strictEqual(dbCheck.rows[0].ticket_id, validApprovedTicketId);
      console.log('    ✓ Test 9 Passed: New runtime order reconciled with RUNTIME provenance');
    }

    console.log('  Test 10: Orphaned Ticket Reference Rejection');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      const orphanOrder = {
        orderId: `RT_ORPHAN_${Date.now()}`,
        ticketId: 'appr_tk_non_existent_fake_ticket',
        status: 'PENDING_APPROVAL',
        authorizedTotal: 75.0,
      };
      fs.writeFileSync(
        path.join(staging.orders, `order-orphan.json`),
        JSON.stringify(orphanOrder, null, 2),
        'utf8'
      );

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: false,
      });

      const analysis = await reconciler.analyze();
      const item = analysis.orders.find((o) => o.orderId === orphanOrder.orderId);
      assert.strictEqual(item?.category, 'CONFLICT_REJECTED');
      assert.match(item?.reason || '', /Orphaned ticket reference/);
      console.log('    ✓ Test 10 Passed: Orphaned ticket reference rejected');
    }

    console.log('  Test 13: Quarantined Orphan Exclusion');
    {
      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: path.resolve(process.cwd(), '.data'),
      });
      const analysis = await reconciler.analyze();
      const orphan = analysis.orders.find((o) => o.fileName === 'TEST-ORDER-MUTATION-CHECK-01.json');
      assert.ok(orphan, 'Quarantined file must be scanned');
      assert.strictEqual(orphan?.category, 'QUARANTINED_EXCLUDED');

      assert.ok(testPool);
      const dbCheck = await testPool.query(
        `SELECT id FROM orders WHERE external_order_id = 'TEST-ORDER-MUTATION-CHECK-01'`
      );
      assert.strictEqual(dbCheck.rows.length, 0, 'Quarantined orphan must NEVER exist in DB');
      console.log('    ✓ Test 13 Passed: Quarantined orphan excluded and protected from import');
    }

    console.log('  Test 14: Atomic Rollback on Batch Failure');
    {
      const staging = createStagingDir();
      copyBaselineToStaging(staging);

      // Order A: Valid transition (from COMPLETED to PARTIALLY_REFUNDED)
      const fileA = 'SANDBOX_STAGE2_179399847261.json';
      const pathA = path.join(staging.orders, fileA);
      const dataA = JSON.parse(fs.readFileSync(pathA, 'utf8'));
      dataA.status = 'PARTIALLY_REFUNDED';
      fs.writeFileSync(pathA, JSON.stringify(dataA, null, 2), 'utf8');

      // Order B: Tampered monetary amount (triggers rejection)
      const fileB = 'SANDBOX_STAGE2_179400041133.json';
      const pathB = path.join(staging.orders, fileB);
      const dataB = JSON.parse(fs.readFileSync(pathB, 'utf8'));
      dataB.authorizedTotal = '7777.77';
      fs.writeFileSync(pathB, JSON.stringify(dataB, null, 2), 'utf8');

      const reconciler = new DeltaReconciler({
        pool: testPool,
        dataDir: staging.root,
        failOnConflict: true,
        ...validMutationOptions,
      });

      await assert.rejects(
        async () => reconciler.reconcile(),
        /conflicting records detected/i,
        'Batch reconciliation must fail closed'
      );

      assert.ok(testPool);
      const checkA = await testPool.query<{ status: string }>(
        `SELECT status FROM orders WHERE external_order_id = 'SANDBOX_STAGE2_179399847261'`
      );
      assert.strictEqual(checkA.rows[0].status, 'COMPLETED', 'Order A must remain rolled back');
      console.log('    ✓ Test 14 Passed: Atomic rollback verified on batch failure');
    }

    console.log('\n================================================================');
    console.log('🎉 ALL DELTA RECONCILIATION PHASE B.4.2.2 SECURITY TESTS PASSED (0 FAILURES)');
    console.log('================================================================\n');
  } finally {
    if (testPool) {
      await testPool.end();
    }

    // Clean up temporary scratch directories
    for (const dir of scratchStagingDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }

    // Teardown isolated test database
    try {
      console.log(`Tearing down isolated test database "${testDbName}"...`);
      await rootClient.query(`DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`);
      if (reconUser) {
        await rootClient.query(`DROP ROLE IF EXISTS "${reconUser}"`);
      }
      console.log(`  ✓ Database "${testDbName}" dropped successfully`);
    } catch (e: any) {
      console.warn(`Warning: failed to drop test database ${testDbName}:`, e.message);
    }

    await rootClient.end();
  }
}

if (require.main === module) {
  runDeltaReconciliationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Delta reconciliation tests failed:', err);
      process.exit(1);
    });
}
