import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'node:assert';
import { Client } from 'pg';
import { runLegacyMigration } from '../src/db/legacy-migration';
import { parseExactDecimalToCents } from '../src/db/legacy-preflight';

export async function importHistoricalBaseline() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Historical Baseline Import to "procurepilot"');
  console.log('================================================================');

  const baseConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: 'procurepilot',
  };

  const adminClient = new Client(baseConfig);
  await adminClient.connect();

  const operatorRole = `procurepilot_operator_${Date.now()}`;
  const operatorPass = `op_pass_${crypto.randomBytes(12).toString('hex')}`;

  try {
    // 1. Provision restricted migration operator role
    console.log(`Provisioning restricted migration operator: ${operatorRole}...`);
    await adminClient.query(
      `CREATE ROLE "${operatorRole}" WITH LOGIN PASSWORD '${operatorPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
    );
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${operatorRole}"`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket TO "${operatorRole}"`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket_item TO "${operatorRole}"`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order TO "${operatorRole}"`);
    await adminClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order_item TO "${operatorRole}"`);
    await adminClient.query(
      `GRANT SELECT ON TABLE organizations, approval_tickets, approval_ticket_items, orders, order_items, payment_captures, legacy_migration_execution_audit TO "${operatorRole}"`
    );
    await adminClient.query(`GRANT INSERT ON TABLE organizations, payment_captures TO "${operatorRole}"`);
    console.log('  ✓ Restricted operator provisioned and granted procedure execution rights');

    // 2. Connect as operator
    const operatorClient = new Client({
      ...baseConfig,
      user: operatorRole,
      password: operatorPass,
    });
    await operatorClient.connect();

    try {
      // 3. Execute First Import Pass
      console.log('\n--- Executing Historical Import via Operator Client ---');
      const firstResult = await runLegacyMigration({ client: operatorClient });
      const summary = firstResult.summary;

      console.log('  ✓ Import Summary:');
      console.log(`    - Approvals scanned:             ${summary.approvalsScanned}`);
      console.log(`    - Approvals migrated:            ${summary.approvalsMigrated}`);
      console.log(`    - Approval items migrated:       ${summary.approvalItemsMigrated}`);
      console.log(`    - Orders scanned:                ${summary.ordersScanned}`);
      console.log(`    - Orders migrated:               ${summary.ordersMigrated}`);
      console.log(`    - Order items migrated:          ${summary.orderItemsMigrated}`);
      console.log(`    - Quarantined orphan orders:     ${summary.ordersQuarantinedOrphan}`);
      console.log(`    - Genuine captures migrated:     ${summary.genuineCapturesMigrated} ($${summary.genuineCapturedAmount})`);
      console.log(`    - Synthetic captures excluded:   ${summary.syntheticCapturesExcluded}`);
      console.log(`    - Migrated authorized total:     $${summary.migratedAuthorizedTotal}`);
      console.log(`    - Migrated genuine total:        $${summary.migratedGenuineTotal}`);
      console.log(`    - Migrated simulation total:     $${summary.migratedSimulationTotal}`);

      // Verify exact counts
      assert.strictEqual(summary.approvalsMigrated, 219, 'Must migrate exactly 219 approval tickets');
      assert.strictEqual(summary.approvalItemsMigrated, 323, 'Must migrate exactly 323 approval ticket items');
      assert.strictEqual(summary.ordersMigrated, 80, 'Must migrate exactly 80 orders');
      assert.strictEqual(summary.orderItemsMigrated, 80, 'Must migrate exactly 80 order items');
      assert.strictEqual(summary.ordersQuarantinedOrphan, 1, 'Must quarantine exactly 1 orphan order');
      assert.strictEqual(summary.genuineCapturesMigrated, 1, 'Must migrate exactly 1 genuine capture');
      assert.strictEqual(summary.syntheticCapturesExcluded, 78, 'Must exclude exactly 78 synthetic captures');
      assert.strictEqual(summary.migratedAuthorizedTotal, '109932.60', 'Authorized total must be $109,932.60');
      assert.strictEqual(summary.migratedGenuineTotal, '589.08', 'Genuine orders total must be $589.08');
      assert.strictEqual(summary.migratedSimulationTotal, '109343.52', 'Simulated orders total must be $109,343.52');
      assert.strictEqual(summary.genuineCapturedAmount, '294.54', 'Genuine captured amount must be $294.54');

      // 4. Verify Idempotence (Second Pass)
      console.log('\n--- Verifying Idempotence via Second Pass ---');
      const secondResult = await runLegacyMigration({ client: operatorClient });
      assert.strictEqual(secondResult.summary.ordersMigrated, 80, 'Second pass must report 80 migrated');
      assert.strictEqual(secondResult.summary.approvalsMigrated, 219, 'Second pass must report 219 migrated');
      console.log('  ✓ Idempotence verified: Second pass succeeded without duplicate insertion or errors');

      return summary;
    } finally {
      await operatorClient.end();
    }
  } finally {
    // 5. Clean up temporary operator login role
    console.log(`\nDe-provisioning operator role ${operatorRole}...`);
    try {
      await adminClient.query(`REASSIGN OWNED BY "${operatorRole}" TO postgres`);
      await adminClient.query(`DROP OWNED BY "${operatorRole}"`);
      await adminClient.query(`DROP ROLE IF EXISTS "${operatorRole}"`);
      console.log('  ✓ Operator role de-provisioned cleanly.');
    } catch (e: any) {
      console.warn('  [WARN] Failed to drop operator role:', e.message);
    }
    await adminClient.end();
  }
}

if (require.main === module) {
  importHistoricalBaseline()
    .then(() => {
      console.log('\n🎉 Historical baseline import completed successfully!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Import Failed:', err);
      process.exit(1);
    });
}
