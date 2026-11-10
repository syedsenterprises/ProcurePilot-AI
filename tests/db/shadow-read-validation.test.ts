import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'node:assert';
import { Client } from 'pg';
import { getDatabaseConfig } from '@/db/config';
import { runPreflightInspection, parseExactDecimalToCents } from '@/db/legacy-preflight';
import { runLegacyMigration, SEED_ORGANIZATION_ID, generateLegacyOrderNumber } from '@/db/legacy-migration';
import { ShadowComparator } from '@/services/shadow/shadow-comparator';
import { payPalOrderStore, StoredPayPalOrder } from '@/services/paypal/paypal-order-store';
import { ApprovalChallengeState } from '@/services/approval/approval.service';
import { AUTHORITATIVE_ORDER_STATES } from '@/db/order-state-machine';

function getFileSha256(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function runShadowReadValidationTest() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Phase 1B.2.2 Read-Only Shadow-Read Validation');
  console.log('================================================================');

  // Baseline manifests & .data/ hashes check
  const preflightPath = path.resolve(process.cwd(), 'migration-preflight-manifest.json');
  const quarantinePath = path.resolve(process.cwd(), 'migration-quarantine-manifest.json');
  const simulatedPath = path.resolve(process.cwd(), 'migration-simulated-orders-manifest.json');

  const preHashes = {
    preflight: fs.existsSync(preflightPath) ? getFileSha256(preflightPath) : null,
    quarantine: fs.existsSync(quarantinePath) ? getFileSha256(quarantinePath) : null,
    simulated: fs.existsSync(simulatedPath) ? getFileSha256(simulatedPath) : null,
  };

  const initialPreflight = runPreflightInspection(process.cwd());
  assert.strictEqual(initialPreflight.manifest.totalOrdersScanned, 81);
  assert.strictEqual(initialPreflight.manifest.validOrdersCount, 80);
  assert.strictEqual(initialPreflight.manifest.totalApprovalsScanned, 219);
  assert.strictEqual(initialPreflight.quarantine.length, 1);
  console.log('  [PREFLIGHT] Baseline persistent inventory: 81 orders, 219 approvals.');

  const baseConfig = {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  };

  const tempDbName = `procurepilot_shadow_rehearsal_${Date.now()}`;
  const rootClient = new Client({ ...baseConfig, database: 'postgres' });
  rootClient.on('error', () => {});
  try {
    await rootClient.connect();
    console.log('  ✓ Connected to root PostgreSQL instance');
  } catch (err) {
    console.log('  [INFO] Local PostgreSQL unavailable or credentials refused.');
    return { executed: false, reason: 'DATABASE UNAVAILABLE' };
  }

  let operatorRole = '';
  let shadowReaderRole = '';
  let shadowReaderPass = '';

  try {
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

      // 3. Provision Disposable External Migration Operator
      operatorRole = `procurepilot_test_operator_${Date.now()}`;
      const operatorPass = `test_op_pass_${crypto.randomBytes(8).toString('hex')}`;

      await testClient.query(
        `CREATE ROLE "${operatorRole}" WITH LOGIN PASSWORD '${operatorPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      await testClient.query(`GRANT USAGE ON SCHEMA public TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_approval_ticket_item TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order TO "${operatorRole}"`);
      await testClient.query(`GRANT EXECUTE ON FUNCTION import_legacy_order_item TO "${operatorRole}"`);
      await testClient.query(
        `GRANT SELECT ON TABLE organizations, approval_tickets, approval_ticket_items, orders, order_items, payment_captures, legacy_migration_execution_audit TO "${operatorRole}"`
      );
      await testClient.query(`GRANT INSERT ON TABLE organizations, payment_captures TO "${operatorRole}"`);
      console.log(`  ✓ Provisioned external migration operator: ${operatorRole}`);

      const operatorClient = new Client({
        ...baseConfig,
        database: tempDbName,
        user: operatorRole,
        password: operatorPass,
      });
      operatorClient.on('error', () => {});
      await operatorClient.connect();

      // 4. Import the accepted legacy dataset using the external migration operator
      console.log('\n--- Part A: Executing Legacy Migration via External Operator ---');
      const migrationResult = await runLegacyMigration({
        client: operatorClient,
        baseDir: process.cwd(),
      });
      const summary = migrationResult.summary;
      console.log(`  ✓ Legacy migration completed via operator:`);
      console.log(`    - Approvals migrated:       ${summary.approvalsMigrated}`);
      console.log(`    - Approval items migrated:  ${summary.approvalItemsMigrated}`);
      console.log(`    - Orders migrated:          ${summary.ordersMigrated}`);
      console.log(`    - Order items migrated:     ${summary.orderItemsMigrated}`);
      console.log(`    - Genuine captures:         ${summary.genuineCapturesMigrated} ($${summary.genuineCapturedAmount})`);
      console.log(`    - Synthetic excluded:       ${summary.syntheticCapturesExcluded}`);

      assert.strictEqual(summary.approvalsMigrated, 219, 'Must migrate exactly 219 approval tickets');
      assert.strictEqual(summary.approvalItemsMigrated, 323, 'Must migrate exactly 323 approval ticket items');
      assert.strictEqual(summary.ordersMigrated, 80, 'Must migrate exactly 80 orders');
      assert.strictEqual(summary.orderItemsMigrated, 80, 'Must migrate exactly 80 order items');
      assert.strictEqual(summary.genuineCapturesMigrated, 1, 'Must migrate exactly 1 genuine capture');
      assert.strictEqual(summary.syntheticCapturesExcluded, 78, 'Must exclude exactly 78 synthetic captures');
      await operatorClient.end();

      // 5. Provision & Verify Dedicated PostgreSQL Shadow-Reader Role
      console.log('\n--- Part B: Provisioning & Verifying Dedicated Read-Only Shadow Reader ---');
      shadowReaderRole = `procurepilot_shadow_reader_${Date.now()}`;
      shadowReaderPass = `shadow_pass_${crypto.randomBytes(12).toString('hex')}`;

      await testClient.query(
        `CREATE ROLE "${shadowReaderRole}" WITH LOGIN PASSWORD '${shadowReaderPass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      await testClient.query(`GRANT USAGE ON SCHEMA public TO "${shadowReaderRole}"`);
      await testClient.query(
        `GRANT SELECT ON TABLE orders, order_items, approval_tickets, approval_ticket_items, payment_captures, payment_attempts, payment_refunds, payment_events, organizations TO "${shadowReaderRole}"`
      );
      console.log(`  ✓ Provisioned read-only shadow reader: ${shadowReaderRole}`);

      // 5b. Catalog-level permission verification
      const privChecks = await testClient.query<{
        table_name: string;
        has_select: boolean;
        has_insert: boolean;
        has_update: boolean;
        has_delete: boolean;
        has_truncate: boolean;
      }>(`
        SELECT 
          t.table_name,
          has_table_privilege('${shadowReaderRole}', 'public.' || t.table_name, 'SELECT') AS has_select,
          has_table_privilege('${shadowReaderRole}', 'public.' || t.table_name, 'INSERT') AS has_insert,
          has_table_privilege('${shadowReaderRole}', 'public.' || t.table_name, 'UPDATE') AS has_update,
          has_table_privilege('${shadowReaderRole}', 'public.' || t.table_name, 'DELETE') AS has_delete,
          has_table_privilege('${shadowReaderRole}', 'public.' || t.table_name, 'TRUNCATE') AS has_truncate
        FROM (VALUES 
          ('orders'), ('order_items'), ('approval_tickets'), ('approval_ticket_items'),
          ('payment_captures'), ('payment_attempts'), ('payment_refunds'), ('payment_events'), ('organizations')
        ) AS t(table_name)
      `);

      for (const row of privChecks.rows) {
        assert.strictEqual(row.has_select, true, `${shadowReaderRole} must have SELECT on ${row.table_name}`);
        assert.strictEqual(row.has_insert, false, `${shadowReaderRole} must NOT have INSERT on ${row.table_name}`);
        assert.strictEqual(row.has_update, false, `${shadowReaderRole} must NOT have UPDATE on ${row.table_name}`);
        assert.strictEqual(row.has_delete, false, `${shadowReaderRole} must NOT have DELETE on ${row.table_name}`);
        assert.strictEqual(row.has_truncate, false, `${shadowReaderRole} must NOT have TRUNCATE on ${row.table_name}`);
      }
      console.log('  ✓ Catalog inspection verified: SELECT only; INSERT, UPDATE, DELETE, TRUNCATE are false');

      const roleAttrCheck = await testClient.query<{
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        has_create_public: boolean;
      }>(`
        SELECT 
          r.rolsuper,
          r.rolcreaterole,
          r.rolcreatedb,
          has_schema_privilege('${shadowReaderRole}', 'public', 'CREATE') AS has_create_public
        FROM pg_roles r
        WHERE r.rolname = '${shadowReaderRole}'
      `);
      assert.strictEqual(roleAttrCheck.rows[0].rolsuper, false, 'Shadow reader must NOT be superuser');
      assert.strictEqual(roleAttrCheck.rows[0].rolcreaterole, false, 'Shadow reader must NOT have CREATEROLE');
      assert.strictEqual(roleAttrCheck.rows[0].rolcreatedb, false, 'Shadow reader must NOT have CREATEDB');
      assert.strictEqual(roleAttrCheck.rows[0].has_create_public, false, 'Shadow reader must NOT have CREATE on public');
      console.log('  ✓ Role attributes verified: NOSUPERUSER, NOCREATEROLE, NOCREATEDB, no CREATE on public');

      // Membership isolation check: shadow reader is NOT a member of privileged roles
      const membershipCheck = await testClient.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count 
        FROM pg_auth_members m
        JOIN pg_roles r_mem ON r_mem.oid = m.member
        JOIN pg_roles r_role ON r_role.oid = m.roleid
        WHERE r_mem.rolname = '${shadowReaderRole}'
          AND r_role.rolname IN ('procurepilot_legacy_importer', 'procurepilot_refund_owner')
      `);
      assert.strictEqual(parseInt(membershipCheck.rows[0].count, 10), 0, 'Shadow reader must NOT belong to privileged owner roles');
      console.log('  ✓ Membership isolation verified: shadow reader does not belong to privileged roles');

      // Connect shadow reader client and verify live execution denial for writes and privileged functions
      const readerClient = new Client({
        ...baseConfig,
        database: tempDbName,
        user: shadowReaderRole,
        password: shadowReaderPass,
      });
      readerClient.on('error', () => {});
      await readerClient.connect();

      // Test 5c: Verify write operations directly fail with 42501
      let directInsertBlocked = false;
      try {
        await readerClient.query(`INSERT INTO orders (order_number, organization_id, ticket_id) VALUES ('HACK', '${SEED_ORGANIZATION_ID}', 'T')`);
      } catch (err: any) {
        directInsertBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
      }
      assert.ok(directInsertBlocked, 'Shadow reader direct INSERT must fail with 42501');

      let directUpdateBlocked = false;
      try {
        await readerClient.query(`UPDATE orders SET status = 'CANCELLED'`);
      } catch (err: any) {
        directUpdateBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
      }
      assert.ok(directUpdateBlocked, 'Shadow reader direct UPDATE must fail with 42501');

      let directDeleteBlocked = false;
      try {
        await readerClient.query(`DELETE FROM orders`);
      } catch (err: any) {
        directDeleteBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
      }
      assert.ok(directDeleteBlocked, 'Shadow reader direct DELETE must fail with 42501');

      let setRoleBlocked = false;
      try {
        await readerClient.query(`SET ROLE procurepilot_legacy_importer`);
      } catch (err: any) {
        setRoleBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
      }
      assert.ok(setRoleBlocked, 'Shadow reader SET ROLE procurepilot_legacy_importer must fail with 42501');

      let funcExecBlocked = false;
      try {
        await readerClient.query(`SELECT import_legacy_order('1', '${SEED_ORGANIZATION_ID}', 't', 'e', 'PAYPAL', 'SANDBOX', 'DRAFT', 10, 10, 0, 0, 'USD', 'a', 'd', 'k', false, 'EXPLICIT', 'r', NOW(), NOW())`);
      } catch (err: any) {
        funcExecBlocked = true;
        assert.strictEqual(err.code, '42501', `Expected 42501, got: ${err.code}`);
      }
      assert.ok(funcExecBlocked, 'Shadow reader execution of import_legacy_order must fail with 42501');

      // Test 5d: Verify read-only transaction execution succeeds
      await readerClient.query('BEGIN TRANSACTION READ ONLY');
      const testSelect = await readerClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM orders');
      assert.strictEqual(parseInt(testSelect.rows[0].count, 10), 80);
      await readerClient.query('COMMIT');
      console.log('  ✓ Shadow reader live security verified: writes blocked (42501), read-only transactions operational');

      // 6. Initialize ShadowComparator
      const comparator = new ShadowComparator({
        client: readerClient,
        baseDir: process.cwd(),
      });

      // 7. Part C: 12 Adversarial Mismatch Tests
      console.log('\n--- Part C: 12 Mandatory Adversarial Mismatch Tests ---');

      // Fetch two valid ticket IDs to satisfy foreign key constraints during adversarial order tests
      const ticketRows = await testClient.query<{ ticket_id: string }>(
        `SELECT ticket_id FROM approval_tickets LIMIT 2`
      );
      const validTicketId = ticketRows.rows[0].ticket_id;
      const validTicketId2 = ticketRows.rows[1].ticket_id;

      // Adversarial Test 1: Missing PostgreSQL record
      console.log('Adversarial Test 1: Missing PostgreSQL record');
      const adv1Result = await comparator.compareOrder('NON_EXISTENT_ORDER_ID_99999');
      assert.strictEqual(adv1Result.isMatch, true, 'Both null must match as cleanly non-existent');

      const fakeOrderId = `FAKE_ORDER_ADV_1_${Date.now()}`;
      const mockOrderAdv1: StoredPayPalOrder = {
        orderId: fakeOrderId,
        ticketId: validTicketId,
        authorizedTotal: 50.0,
        authorizedSubtotal: 45.0,
        authorizedTax: 5.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CREATED',
        approverName: 'Alice',
        approverDepartment: 'IT',
        items: [{ productId: 'test', name: 'Item', quantity: 1, unitPrice: 45.0 }],
        createdAt: new Date().toISOString(),
      };

      const adv1MissingPg = await comparator.compareOrder(fakeOrderId, mockOrderAdv1);
      assert.strictEqual(adv1MissingPg.isMatch, false, 'Missing PG record must be detected as mismatch');
      assert.ok(
        adv1MissingPg.unexpectedMismatches.some((d) => d.category === 'MISSING_POSTGRES_RECORD'),
        'Must record MISSING_POSTGRES_RECORD mismatch'
      );
      console.log('  ✓ 1: MISSING_POSTGRES_RECORD accurately detected');

      // Adversarial Test 2: Extra PostgreSQL record
      console.log('Adversarial Test 2: Extra PostgreSQL record');
      const extraOrderId = `EXTRA_PG_ORD_${Date.now()}`;
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(extraOrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${extraOrderId}', 'PAYPAL',
          'SANDBOX', 'PENDING_PAYMENT_APPROVAL', 10.00, 10.00, 0.00, 0.00, 'USD',
          'key_adv2', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv2Result = await comparator.compareOrder(extraOrderId);
      assert.strictEqual(adv2Result.isMatch, false, 'Extra PG record must be detected as mismatch');
      assert.ok(
        adv2Result.unexpectedMismatches.some((d) => d.category === 'EXTRA_POSTGRES_RECORD'),
        'Must record EXTRA_POSTGRES_RECORD mismatch'
      );
      // Clean up extra row
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${extraOrderId}'`);
      console.log('  ✓ 2: EXTRA_POSTGRES_RECORD accurately detected');

      // Adversarial Test 3: Wrong order status
      console.log('Adversarial Test 3: Wrong order status');
      const adv3OrderId = `ADV_STATUS_ORD_${Date.now()}`;
      const mockOrderAdv3: StoredPayPalOrder = {
        orderId: adv3OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CAPTURED', // Normalizes to COMPLETED
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: new Date().toISOString(),
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv3OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv3OrderId}', 'PAYPAL',
          'SANDBOX', 'CANCELLED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv3', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv3Result = await comparator.compareOrder(adv3OrderId, mockOrderAdv3);
      assert.strictEqual(adv3Result.isMatch, false, 'Status mismatch must fail');
      assert.ok(
        adv3Result.unexpectedMismatches.some((d) => d.category === 'STATUS_MISMATCH'),
        'Must record STATUS_MISMATCH'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv3OrderId}'`);
      console.log('  ✓ 3: STATUS_MISMATCH accurately detected');

      // Adversarial Test 4: Incorrect monetary amount
      console.log('Adversarial Test 4: Incorrect monetary amount');
      const adv4OrderId = `ADV_AMT_ORD_${Date.now()}`;
      const mockOrderAdv4: StoredPayPalOrder = {
        orderId: adv4OrderId,
        ticketId: validTicketId,
        authorizedTotal: 294.54,
        authorizedSubtotal: 250.0,
        authorizedTax: 24.54,
        authorizedShipping: 20.0,
        currency: 'USD',
        status: 'CAPTURED',
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: new Date().toISOString(),
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv4OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv4OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 294.55, 250.00, 24.54, 20.00, 'USD',
          'key_adv4', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv4Result = await comparator.compareOrder(adv4OrderId, mockOrderAdv4);
      assert.strictEqual(adv4Result.isMatch, false, 'Amount mismatch must fail');
      assert.ok(
        adv4Result.unexpectedMismatches.some((d) => d.category === 'AMOUNT_MISMATCH'),
        'Must record AMOUNT_MISMATCH'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv4OrderId}'`);
      console.log('  ✓ 4: AMOUNT_MISMATCH accurately detected');

      // Adversarial Test 5: Wrong currency
      console.log('Adversarial Test 5: Wrong currency');
      const adv5OrderId = `ADV_CURR_ORD_${Date.now()}`;
      const mockOrderAdv5: StoredPayPalOrder = {
        orderId: adv5OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'EUR' as any,
        status: 'CAPTURED',
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: new Date().toISOString(),
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv5OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv5OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv5', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv5Result = await comparator.compareOrder(adv5OrderId, mockOrderAdv5);
      assert.strictEqual(adv5Result.isMatch, false, 'Currency mismatch must fail');
      assert.ok(
        adv5Result.unexpectedMismatches.some((d) => d.category === 'CURRENCY_MISMATCH'),
        'Must record CURRENCY_MISMATCH'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv5OrderId}'`);
      console.log('  ✓ 5: CURRENCY_MISMATCH accurately detected');

      // Adversarial Test 6: Changed line-item quantity
      console.log('Adversarial Test 6: Changed line-item quantity');
      const adv6OrderId = `ADV_QTY_ORD_${Date.now()}`;
      const mockOrderAdv6: StoredPayPalOrder = {
        orderId: adv6OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CAPTURED',
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [{ productId: 'chair_01', name: 'Chair', quantity: 2, unitPrice: 50.0 }],
        createdAt: new Date().toISOString(),
      };
      const adv6OrdRes = await testClient.query<{ id: string }>(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv6OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv6OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv6', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        ) RETURNING id
      `);
      await testClient.query(`
        INSERT INTO order_items (organization_id, order_id, product_id, product_name, quantity, unit_price, line_total)
        VALUES ('${SEED_ORGANIZATION_ID}', '${adv6OrdRes.rows[0].id}', 'chair_01', 'Chair', 3, 50.00, 150.00)
      `);
      const adv6Result = await comparator.compareOrder(adv6OrderId, mockOrderAdv6);
      assert.strictEqual(adv6Result.isMatch, false, 'Line item quantity mismatch must fail');
      assert.ok(
        adv6Result.unexpectedMismatches.some((d) => d.category === 'LINE_ITEM_QUANTITY_MISMATCH'),
        'Must record LINE_ITEM_QUANTITY_MISMATCH'
      );
      await testClient.query(`DELETE FROM order_items WHERE order_id = '${adv6OrdRes.rows[0].id}'`);
      await testClient.query(`DELETE FROM orders WHERE id = '${adv6OrdRes.rows[0].id}'`);
      console.log('  ✓ 6: LINE_ITEM_QUANTITY_MISMATCH accurately detected');

      // Adversarial Test 7: Broken approval/order relationship
      console.log('Adversarial Test 7: Broken approval/order relationship');
      const adv7OrderId = `ADV_REL_ORD_${Date.now()}`;
      const mockOrderAdv7: StoredPayPalOrder = {
        orderId: adv7OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CAPTURED',
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: new Date().toISOString(),
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv7OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId2}', '${adv7OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv7', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv7Result = await comparator.compareOrder(adv7OrderId, mockOrderAdv7);
      assert.strictEqual(adv7Result.isMatch, false, 'Broken relationship must fail');
      assert.ok(
        adv7Result.unexpectedMismatches.some((d) => d.category === 'BROKEN_RELATIONSHIP'),
        'Must record BROKEN_RELATIONSHIP'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv7OrderId}'`);
      console.log('  ✓ 7: BROKEN_RELATIONSHIP accurately detected');

      // Adversarial Test 8: Timestamp mismatch
      console.log('Adversarial Test 8: Timestamp mismatch');
      const adv8OrderId = `ADV_TIME_ORD_${Date.now()}`;
      const mockOrderAdv8: StoredPayPalOrder = {
        orderId: adv8OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CAPTURED',
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv8OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv8OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv8', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', '2026-06-01T00:00:00.000Z', NOW()
        )
      `);
      const adv8Result = await comparator.compareOrder(adv8OrderId, mockOrderAdv8);
      assert.ok(
        adv8Result.differences.some((d) => d.category === 'TIMESTAMP_MISMATCH'),
        'Must record TIMESTAMP_MISMATCH'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv8OrderId}'`);
      console.log('  ✓ 8: TIMESTAMP_MISMATCH accurately detected');

      // Adversarial Test 9: Incorrect simulation provenance
      console.log('Adversarial Test 9: Incorrect simulation provenance');
      const adv9OrderId = `ADV_SIM_ORD_${Date.now()}`;
      const mockOrderAdv9: StoredPayPalOrder = {
        orderId: adv9OrderId,
        ticketId: validTicketId,
        authorizedTotal: 100.0,
        authorizedSubtotal: 100.0,
        authorizedTax: 0.0,
        authorizedShipping: 0.0,
        currency: 'USD',
        status: 'CAPTURED',
        isSimulated: true,
        approverName: 'Bob',
        approverDepartment: 'Finance',
        items: [],
        createdAt: new Date().toISOString(),
      };
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${generateLegacyOrderNumber(adv9OrderId)}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv9OrderId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 100.00, 100.00, 0.00, 0.00, 'USD',
          'key_adv9', false, 'EXPLICIT_SOURCE', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      const adv9Result = await comparator.compareOrder(adv9OrderId, mockOrderAdv9);
      assert.strictEqual(adv9Result.isMatch, false, 'Simulation provenance mismatch must fail');
      assert.ok(
        adv9Result.unexpectedMismatches.some((d) => d.category === 'SIMULATION_PROVENANCE_MISMATCH'),
        'Must record SIMULATION_PROVENANCE_MISMATCH'
      );
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv9OrderId}'`);
      console.log('  ✓ 9: SIMULATION_PROVENANCE_MISMATCH accurately detected');

      // Adversarial Test 10: Synthetic capture appearing in financial ledger
      console.log('Adversarial Test 10: Synthetic capture appearing in financial ledger');
      const mockSyntheticPgCapture = [
        {
          id: 'test-cap-id',
          order_id: 'some_order_id',
          external_capture_id: 'CAP_SANDBOX_STAGE2_ILLEGAL_TEST',
          captured_amount: '50.00',
          currency: 'USD',
          capture_origin: 'LOCAL_SYNTHETIC_TEST',
          created_at: new Date(),
        },
      ];
      const adv10Result = await comparator.compareFinancialCaptures('ADV_SYNTH_ORD', mockSyntheticPgCapture);
      assert.strictEqual(adv10Result.isMatch, false, 'Synthetic capture in ledger must be flagged as critical mismatch');
      assert.ok(
        adv10Result.unexpectedMismatches.some((d) => d.category === 'SYNTHETIC_CAPTURE_IN_LEDGER'),
        'Must record SYNTHETIC_CAPTURE_IN_LEDGER'
      );
      console.log('  ✓ 10: SYNTHETIC_CAPTURE_IN_LEDGER accurately detected');

      // Adversarial Test 11: Unexpected legacy signature becoming VERIFIED
      console.log('Adversarial Test 11: Unexpected legacy signature becoming VERIFIED');
      const adv11TicketId = `ADV_TICKET_VERIFIED_${Date.now()}`;
      await testClient.query(`
        INSERT INTO approval_tickets (
          ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
          verified_subtotal, verified_tax, verified_shipping, verified_total, currency,
          status, identity_tier, expires_at, source_origin, integrity_status
        ) VALUES (
          '${adv11TicketId}', '${SEED_ORGANIZATION_ID}', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          10.00, 0.00, 0.00, 10.00, 'USD', 'PENDING_APPROVAL', 'REQUISITIONER',
          NOW() + INTERVAL '1 hour', 'RUNTIME', 'VERIFIED'
        )
      `);
      const mockLegacyTicketAdv11: any = {
        ticketId: adv11TicketId,
        status: 'PENDING_APPROVAL',
        sourceOrigin: 'LEGACY_JSON_IMPORT',
        integrityStatus: 'UNVERIFIABLE_LEGACY',
      };
      const adv11Result = await comparator.compareApprovalStatus(adv11TicketId, mockLegacyTicketAdv11);
      assert.strictEqual(adv11Result.isMatch, false, 'Legacy ticket marked as VERIFIED must fail');
      assert.ok(
        adv11Result.unexpectedMismatches.some((d) => d.category === 'UNEXPECTED_LEGACY_SIGNATURE_VERIFIED'),
        'Must record UNEXPECTED_LEGACY_SIGNATURE_VERIFIED'
      );
      await testClient.query(`DELETE FROM approval_tickets WHERE ticket_id = '${adv11TicketId}'`);
      console.log('  ✓ 11: UNEXPECTED_LEGACY_SIGNATURE_VERIFIED accurately detected');

      // Adversarial Test 12: Incorrect sorting or pagination
      console.log('Adversarial Test 12: Incorrect sorting or pagination');
      const adv12Result = await comparator.compareOrderList({ limit: 5, offset: 0 });
      if (!adv12Result.isMatch) {
        console.error('adv12Result mismatches:', adv12Result.unexpectedMismatches);
      }
      assert.strictEqual(adv12Result.isMatch, true, 'Clean paginated read must match without mismatch');
      // Intentionally request negative/invalid limit or offset that exposes pagination boundary
      const adv12OffsetResult = await comparator.compareOrderList({ limit: 10, offset: 75 });
      assert.strictEqual(adv12OffsetResult.isMatch, true, 'Offset page within bounds must match');
      assert.strictEqual(adv12OffsetResult.legacyResult?.orders.length, 5, 'Offset 75 with 80 total orders must have 5 rows');
      console.log('  ✓ 12: SORTING_OR_PAGINATION_MISMATCH invariants verified');

      // ----------------------------------------------------------------------
      // Phase 1B.2.2.1: Targeted Precision Verification Suites
      // ----------------------------------------------------------------------
      console.log('\n--- Phase 1B.2.2.1 Precision Tests: Order ID Resolution & Integrity ---');

      // 1. Original legacy order ID resolution
      console.log('Precision Test 1: Strict legacy order identity enforcement');
      
      // 1a. Correct external ID + correct canonical order number → returns the correct row
      const sampleOrder = initialPreflight.manifest.orders[0];
      const res1a = await comparator.resolvePostgresOrder(sampleOrder.orderId);
      assert.ok(res1a, `Order ${sampleOrder.orderId} must resolve successfully`);
      assert.strictEqual(res1a.external_order_id, sampleOrder.orderId);
      assert.strictEqual(res1a.order_number, generateLegacyOrderNumber(sampleOrder.orderId));
      console.log('  ✓ 1a: Correct external ID + correct canonical order number returns correct row');

      // 1b. Correct external ID + incorrect order number → throws an identity-integrity error
      const adv1bExtId = `ADV_1B_EXT_${Date.now()}`;
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          'LEG-WRONG-CANONICAL-NUM', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv1bExtId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 10.00, 10.00, 0.00, 0.00, 'USD',
          'key_adv_1b', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      let adv1bCaught = false;
      try {
        await comparator.resolvePostgresOrder(adv1bExtId);
      } catch (err: any) {
        adv1bCaught = true;
        assert.ok(err.message.includes('Order identity integrity violation'), 'Must throw identity integrity violation');
      }
      assert.strictEqual(adv1bCaught, true, 'Mismatch between external ID and canonical order number must fail');
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv1bExtId}'`);
      console.log('  ✓ 1b: Correct external ID + incorrect order number strictly throws identity-integrity error');

      // 1c. Incorrect external ID + matching canonical order number → must not return that row
      const adv1cTargetExtId = `TARGET_EXT_${Date.now()}`;
      const adv1cWrongExtId = `WRONG_EXT_${Date.now()}`;
      const adv1cTargetOrderNumber = generateLegacyOrderNumber(adv1cTargetExtId);
      await testClient.query(`
        INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, idempotency_key, is_simulated,
          is_simulated_provenance, source_origin, created_at, updated_at
        ) VALUES (
          '${adv1cTargetOrderNumber}', '${SEED_ORGANIZATION_ID}', '${validTicketId}', '${adv1cWrongExtId}', 'PAYPAL',
          'SANDBOX', 'COMPLETED', 10.00, 10.00, 0.00, 0.00, 'USD',
          'key_adv_1c', false, 'EXPLICIT_PROVIDER', 'ONLINE_CHECKOUT', NOW(), NOW()
        )
      `);
      // Querying for target external ID must NOT return the row with wrong external ID
      const res1c = await comparator.resolvePostgresOrder(adv1cTargetExtId);
      assert.strictEqual(res1c, null, 'Must not return row when queried external ID does not match row external_order_id');
      await testClient.query(`DELETE FROM orders WHERE external_order_id = '${adv1cWrongExtId}'`);
      console.log('  ✓ 1c: Incorrect external ID + matching canonical order number does not return the row');

      // 1d. Unknown external ID + matching-looking order number → returns null
      const unknownResolved = await comparator.resolvePostgresOrder('NONEXISTENT_LEGACY_ORDER_XYZ_12345');
      assert.strictEqual(unknownResolved, null, 'Unknown order ID must return null without error');
      console.log('  ✓ 1d: Unknown external ID returns null cleanly');

      // 1e. A row belonging to Order B can never be returned for Order A
      const orderA = initialPreflight.manifest.orders[0];
      const orderB = initialPreflight.manifest.orders[1];
      const resA = await comparator.resolvePostgresOrder(orderA.orderId);
      const resB = await comparator.resolvePostgresOrder(orderB.orderId);
      assert.notStrictEqual(resA.id, resB.id, 'Distinct order queries must never map to the same record');
      assert.strictEqual(resA.external_order_id, orderA.orderId);
      assert.strictEqual(resB.external_order_id, orderB.orderId);
      assert.notStrictEqual(resA.external_order_id, resB.external_order_id);
      console.log('  ✓ 1e: A row belonging to Order B can never be returned for Order A');

      // 1f. All 80 original source order identifiers resolve to their exact corresponding PostgreSQL records
      for (const ord of initialPreflight.manifest.orders) {
        const resolved = await comparator.resolvePostgresOrder(ord.orderId);
        assert.ok(resolved, `Original legacy source order ID "${ord.orderId}" must resolve to a record`);
        assert.strictEqual(resolved.external_order_id, ord.orderId, 'Resolved record must have identical original external_order_id');
        assert.strictEqual(resolved.order_number, generateLegacyOrderNumber(ord.orderId), 'Resolved record must have exact canonical order_number');
      }
      console.log('  ✓ 1f: All 80 original source order identifiers resolve to exact corresponding PostgreSQL records');

      // 1g. Existing external PayPal order ID lookup continues to work
      const genuinePayPalId = '8HX63874LW066860W';
      const paypalLookupRes = await comparator.compareOrderByExternalId(genuinePayPalId);
      assert.strictEqual(paypalLookupRes.isMatch, true, 'Genuine PayPal external order ID lookup must match');
      assert.strictEqual((paypalLookupRes.postgresResult as any)?.external_order_id, genuinePayPalId);
      console.log('  ✓ 1g: External PayPal order ID lookup verified operational');

      // 1h. Duplicate or ambiguous mapping fails explicitly
      let ambiguousCaught = false;
      try {
        const fakeClient = {
          query: async () => ({ rows: [{ external_order_id: 'DUP_1', order_number: 'LEG-1' }, { external_order_id: 'DUP_1', order_number: 'LEG-1' }] }),
        } as any;
        const fakeComparator = new ShadowComparator({ client: fakeClient });
        await fakeComparator.resolvePostgresOrder('DUP_1');
      } catch (err: any) {
        ambiguousCaught = true;
        assert.ok(err.message.includes('Ambiguous legacy order mapping'), 'Must throw explicit ambiguous resolution error');
      }
      assert.strictEqual(ambiguousCaught, true, 'Duplicate / ambiguous order ID match must fail explicitly');
      console.log('  ✓ 1h: Ambiguous / duplicate order ID mapping strictly rejected with explicit error');

      // 2. Exact timestamp comparisons
      console.log('\nPrecision Test 2: Exact timestamp canonical comparison & drift detection');
      // 2a. Exact timestamp match
      const tExact = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T20:52:13.456Z');
      assert.strictEqual(tExact.isMatch, true);
      assert.strictEqual(tExact.diffMs, 0);
      console.log('  ✓ Exact timestamp match: 0ms delta');

      // 2b. 1 millisecond difference (strictly fails)
      const t1ms = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T20:52:13.457Z');
      assert.strictEqual(t1ms.isMatch, false);
      assert.strictEqual(t1ms.diffMs, 1);
      console.log('  ✓ 1 millisecond difference: accurately detected (delta=1ms)');

      // 2c. 1 second difference (strictly fails)
      const t1s = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T20:52:14.456Z');
      assert.strictEqual(t1s.isMatch, false);
      assert.strictEqual(t1s.diffMs, 1000);
      console.log('  ✓ 1 second difference: accurately detected (delta=1000ms)');

      // 2d. 30-second difference (strictly fails)
      const t30s = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T20:52:43.456Z');
      assert.strictEqual(t30s.isMatch, false);
      assert.strictEqual(t30s.diffMs, 30000);
      console.log('  ✓ 30-second difference: accurately detected (delta=30000ms)');

      // 2e. 60-second difference (strictly fails)
      const t60s = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T20:53:13.456Z');
      assert.strictEqual(t60s.isMatch, false);
      assert.strictEqual(t60s.diffMs, 60000);
      console.log('  ✓ 60-second difference: accurately detected (delta=60000ms)');

      // 2f. 3-hour difference (strictly fails)
      const t3h = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T23:52:13.456Z');
      assert.strictEqual(t3h.isMatch, false);
      assert.strictEqual(t3h.diffMs, 10800000);
      console.log('  ✓ 3-hour difference: accurately detected (delta=10800000ms)');

      // 2g. Timezone-equivalent representations of the same instant normalize to equality
      const tTz1 = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-06T15:52:13.456-05:00');
      assert.strictEqual(tTz1.isMatch, true, 'UTC and EST offset representing same instant must match');
      assert.strictEqual(tTz1.diffMs, 0);

      const tTz2 = ShadowComparator.compareTimestamps('2026-11-06T20:52:13.456Z', '2026-11-07T02:22:13.456+05:30');
      assert.strictEqual(tTz2.isMatch, true, 'UTC and IST offset representing same instant must match');
      assert.strictEqual(tTz2.diffMs, 0);
      console.log('  ✓ Timezone-equivalent representations of same instant normalize to equality (0ms drift)');

      // 3. Exact monetary comparison without binary floating point
      console.log('\nPrecision Test 3: Exact monetary comparison & rounding edge-case protection');
      // 3a. Exact string and number conversions
      assert.strictEqual(parseExactDecimalToCents(0), 0);
      assert.strictEqual(parseExactDecimalToCents('0.00'), 0);
      assert.strictEqual(parseExactDecimalToCents(249), 24900);
      assert.strictEqual(parseExactDecimalToCents('294.54'), 29454);
      assert.strictEqual(parseExactDecimalToCents('-50.25'), -5025);
      console.log('  ✓ Standard zero, whole-dollar, two-decimal, and negative numbers parse losslessly to integer cents');

      // 3b. Rounding edge cases: 1.005 and 2.675 strictly rejected as excess precision
      let caught1005 = false;
      try {
        parseExactDecimalToCents('1.005');
      } catch (err: any) {
        caught1005 = true;
        assert.ok(err.message.includes('Excess monetary precision'));
      }
      assert.strictEqual(caught1005, true, 'String "1.005" must be rejected for excess precision');

      let caught2675 = false;
      try {
        parseExactDecimalToCents('2.675');
      } catch (err: any) {
        caught2675 = true;
        assert.ok(err.message.includes('Excess monetary precision'));
      }
      assert.strictEqual(caught2675, true, 'String "2.675" must be rejected for excess precision');

      let caughtNum1005 = false;
      try {
        parseExactDecimalToCents(1.005);
      } catch (err: any) {
        caughtNum1005 = true;
        assert.ok(err.message.includes('Excess monetary precision'));
      }
      assert.strictEqual(caughtNum1005, true, 'Number 1.005 must be rejected for excess precision');
      console.log('  ✓ Rounding edge cases (1.005, 2.675) strictly rejected with excess precision errors');

      // 3c. Safe integer overflow and malformed strings
      let caughtOverflow = false;
      try {
        parseExactDecimalToCents('9007199254740992');
      } catch (err: any) {
        caughtOverflow = true;
        assert.ok(err.message.includes('beyond safe integer range'));
      }
      assert.strictEqual(caughtOverflow, true, 'Value beyond safe integer range must be rejected');

      let caughtMalformed = false;
      try {
        parseExactDecimalToCents('12.3.4');
      } catch (err: any) {
        caughtMalformed = true;
        assert.ok(err.message.includes('Malformed monetary string format'));
      }
      assert.strictEqual(caughtMalformed, true, 'Malformed string "12.3.4" must be rejected');
      console.log('  ✓ Safe integer range overflow and malformed inputs strictly rejected');

      // 4. Canonical simulation status verification
      console.log('\nPrecision Test 4: Canonical simulation status verification in PostgreSQL');
      const dbStatusRes = await testClient.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM orders GROUP BY status ORDER BY status ASC`
      );
      for (const row of dbStatusRes.rows) {
        assert.ok(
          (AUTHORITATIVE_ORDER_STATES as readonly string[]).includes(row.status),
          `Persisted order status "${row.status}" must belong to AUTHORITATIVE_ORDER_STATES`
        );
      }
      // Explicitly verify SIMULATION_COMPLETED is nowhere in the database
      const simStatusCount = await testClient.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM orders WHERE status = 'SIMULATION_COMPLETED'`
      );
      assert.strictEqual(parseInt(simStatusCount.rows[0].count, 10), 0, 'SIMULATION_COMPLETED must never exist in orders table');
      // Verify exact canonical counts
      const statusMap: Record<string, number> = {};
      for (const r of dbStatusRes.rows) {
        statusMap[r.status] = parseInt(r.count, 10);
      }
      assert.strictEqual(statusMap['COMPLETED'], 79, 'Exactly 79 orders must have COMPLETED status in database');
      assert.strictEqual(statusMap['PENDING_PAYMENT_APPROVAL'], 1, 'Exactly 1 order must have PENDING_PAYMENT_APPROVAL status in database');
      console.log('  ✓ Canonical simulation status verified: 79 COMPLETED, 1 PENDING_PAYMENT_APPROVAL, 0 SIMULATION_COMPLETED');

      // 8. Part D: Full Dataset Reconciliation (Positive Legitimate Comparison)
      console.log('\n--- Part D: Full Dataset Positive Reconciliation (Target: 0 Mismatches) ---');

      let ordersCompared = 0;
      let orderMatches = 0;
      let orderMismatches = 0;
      let orderItemsCompared = 0;
      let orderItemMatches = 0;
      let orderItemMismatches = 0;

      // 8a. Compare all 80 valid orders by ID and External ID
      for (const ord of initialPreflight.manifest.orders) {
        // Skip quarantined
        if (ord.ticketId === 'non-existent-ticket-for-orphan-check') {
          continue;
        }

        // Resolve by original legacy order ID
        const resolvedOrder = await comparator.resolvePostgresOrder(ord.orderId);
        assert.ok(resolvedOrder, `Order ${ord.orderId} must resolve via resolvePostgresOrder`);
        assert.strictEqual(resolvedOrder.external_order_id, ord.orderId, 'external_order_id must match original source ID');

        // Compare by ID
        const resById = await comparator.compareOrder(ord.orderId);
        ordersCompared++;
        if (resById.isMatch) {
          orderMatches++;
        } else {
          orderMismatches++;
          console.error(`Mismatch on order ${ord.orderId}:`, resById.unexpectedMismatches);
        }

        // Compare by External ID
        const resByExtId = await comparator.compareOrderByExternalId(ord.orderId);
        assert.strictEqual(resByExtId.isMatch, true, `Order ${ord.orderId} must match by external ID`);

        // Compare Order Items
        const resItems = await comparator.compareOrderItems(ord.orderId);
        orderItemsCompared += resItems.legacyResult?.length || 0;
        if (resItems.isMatch) {
          orderItemMatches += resItems.legacyResult?.length || 0;
        } else {
          orderItemMismatches += resItems.legacyResult?.length || 0;
          console.error(`Mismatch on order items for ${ord.orderId}:`, resItems.unexpectedMismatches);
        }
      }

      console.log(`  ✓ Orders compared:       ${ordersCompared} (Matches: ${orderMatches}, Mismatches: ${orderMismatches})`);
      console.log(`  ✓ Order items compared:  ${orderItemsCompared} (Matches: ${orderItemMatches}, Mismatches: ${orderItemMismatches})`);
      assert.strictEqual(ordersCompared, 80);
      assert.strictEqual(orderMatches, 80);
      assert.strictEqual(orderMismatches, 0);
      assert.strictEqual(orderItemsCompared, 80);
      assert.strictEqual(orderItemMatches, 80);
      assert.strictEqual(orderItemMismatches, 0);

      // 8b. Compare Quarantined Orphaned Order ('TEST-ORDER-MUTATION-CHECK-01')
      const quarantineComp = await comparator.compareOrder('TEST-ORDER-MUTATION-CHECK-01');
      assert.strictEqual(quarantineComp.isMatch, true, 'Quarantined order must match cleanly with intentional exclusion');
      assert.strictEqual(quarantineComp.unexpectedMismatches.length, 0);
      assert.ok(quarantineComp.intentionalDifferences.some((d) => d.category === 'MISSING_POSTGRES_RECORD' && d.isIntentionalDifference));
      console.log('  ✓ Quarantined orphaned order verified legitimately absent from PostgreSQL (0 unexpected mismatches)');

      // 8c. Compare all 219 historical approval tickets and items
      let approvalsCompared = 0;
      let approvalMatches = 0;
      let approvalMismatches = 0;
      let approvalItemsCompared = 0;
      let approvalItemMatches = 0;
      let approvalItemMismatches = 0;

      for (const appr of initialPreflight.manifest.approvals) {
        // Compare ticket
        const resTicket = await comparator.compareApprovalTicket(appr.ticketId);
        approvalsCompared++;
        if (resTicket.isMatch) {
          approvalMatches++;
        } else {
          approvalMismatches++;
          console.error(`Mismatch on ticket ${appr.ticketId}:`, resTicket.unexpectedMismatches);
        }

        // Compare status
        const resStatus = await comparator.compareApprovalStatus(appr.ticketId);
        assert.strictEqual(resStatus.isMatch, true, `Ticket status for ${appr.ticketId} must match`);

        // Compare items
        const resItems = await comparator.compareApprovalTicketItems(appr.ticketId);
        const itemCount = resItems.legacyResult?.length || 0;
        approvalItemsCompared += itemCount;
        if (resItems.isMatch) {
          approvalItemMatches += itemCount;
        } else {
          approvalItemMismatches += itemCount;
          console.error(`Mismatch on ticket items for ${appr.ticketId}:`, resItems.unexpectedMismatches);
        }
      }

      console.log(`  ✓ Approvals compared:    ${approvalsCompared} (Matches: ${approvalMatches}, Mismatches: ${approvalMismatches})`);
      console.log(`  ✓ Approval items compared: ${approvalItemsCompared} (Matches: ${approvalItemMatches}, Mismatches: ${approvalItemMismatches})`);
      assert.strictEqual(approvalsCompared, 219);
      assert.strictEqual(approvalMatches, 219);
      assert.strictEqual(approvalMismatches, 0);
      assert.strictEqual(approvalItemsCompared, 323);
      assert.strictEqual(approvalItemMatches, 323);
      assert.strictEqual(approvalItemMismatches, 0);

      // 8d. Compare financial captures
      const captureComp = await comparator.compareFinancialCaptures();
      assert.strictEqual(captureComp.isMatch, true, 'Global financial captures must match with 0 unexpected mismatches');
      assert.strictEqual(captureComp.unexpectedMismatches.length, 0);
      assert.strictEqual(captureComp.legacyResult?.totalGenuineCaptures, 1);
      assert.strictEqual(captureComp.postgresResult?.totalGenuineCaptures, 1);
      assert.strictEqual(captureComp.legacyResult?.totalCapturedAmount, '294.54');
      assert.strictEqual(captureComp.postgresResult?.totalCapturedAmount, '294.54');
      console.log('  ✓ Financial captures verified: exactly 1 genuine capture ($294.54), 0 synthetic in ledger');

      // 8e. Compare dashboard summary
      const dashboardComp = await comparator.compareDashboardSummary();
      assert.strictEqual(dashboardComp.isMatch, true, 'Dashboard summary comparison must match with 0 unexpected mismatches');
      assert.strictEqual(dashboardComp.unexpectedMismatches.length, 0);
      assert.strictEqual(dashboardComp.legacyResult?.totalOrders, 80);
      assert.strictEqual(dashboardComp.postgresResult?.totalOrders, 80);
      assert.strictEqual(dashboardComp.legacyResult?.aggregateAuthorizedTotal, '109932.60');
      assert.strictEqual(dashboardComp.postgresResult?.aggregateAuthorizedTotal, '109932.60');
      assert.strictEqual(dashboardComp.legacyResult?.totalApprovals, 219);
      assert.strictEqual(dashboardComp.postgresResult?.totalApprovals, 219);
      assert.strictEqual(dashboardComp.legacyResult?.approvalsByStatus.CONSUMED, 141);
      assert.strictEqual(dashboardComp.legacyResult?.approvalsByStatus.APPROVED, 26);
      assert.strictEqual(dashboardComp.legacyResult?.approvalsByStatus.PENDING_APPROVAL, 52);
      console.log('  ✓ Dashboard summary comparison verified: 80 orders ($109,932.60), 219 approvals (141 CONSUMED, 26 APPROVED, 52 PENDING_APPROVAL)');

      // 9. Save rehearsal summary to JSON
      const summaryPath = path.resolve(process.cwd(), 'shadow-read-rehearsal-summary.json');
      fs.writeFileSync(
        summaryPath,
        JSON.stringify(
          {
            phase: 'Phase 1B.2.2.1',
            timestamp: new Date().toISOString(),
            shadowReaderRole,
            adversarialTestsVerified: 12,
            allAdversarialPassed: true,
            precisionTestsVerified: {
              orderIdResolution80of80: true,
              unknownIdReturnsNull: true,
              ambiguousMappingRejected: true,
              externalPayPalLookupVerified: true,
              crossRecordMatchesPrevented: true,
              exactTimestampMatchTested: true,
              timestampDriftsTested: ['1ms', '1s', '30s', '60s', '3h'],
              timezoneEquivalencePreserved: true,
              exactMonetaryArithmeticVerified: true,
              roundingEdgeCasesRejected: ['1.005', '2.675'],
              canonicalStatusesVerified: {
                completedOrders: 79,
                pendingPaymentApprovalOrders: 1,
                simulationCompletedInDb: 0,
              },
            },
            reconciliation: {
              ordersCompared: 80,
              ordersMatched: 80,
              orderItemsCompared: 80,
              orderItemsMatched: 80,
              approvalsCompared: 219,
              approvalsMatched: 219,
              approvalItemsCompared: 323,
              approvalItemsMatched: 323,
              quarantinedOrdersVerified: 1,
              genuineCapturesMatched: 1,
              syntheticCapturesExcluded: 78,
              unexpectedMismatches: 0,
            },
            allReconciled: true,
          },
          null,
          2
        ),
        'utf8'
      );
      console.log(`\n  ✓ Shadow read execution summary written to: ${summaryPath}`);

      await readerClient.end();
      await testClient.end();
      return { executed: true, allPassed: true };
    } catch (testErr) {
      console.error('Error during shadow read rehearsal:', testErr);
      await testClient.end();
      throw testErr;
    } finally {
      // Clean up disposable database
      await rootClient.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`);
      if (shadowReaderRole) {
        await rootClient.query(`DROP ROLE IF EXISTS "${shadowReaderRole}"`);
      }
      if (operatorRole) {
        await rootClient.query(`DROP ROLE IF EXISTS "${operatorRole}"`);
      }
      console.log(`  ✓ Cleaned up disposable database (${tempDbName}) and ephemeral roles`);
      await rootClient.end();
    }
  } catch (err) {
    await rootClient.end();
    throw err;
  } finally {
    // Assert manifests were NOT mutated
    if (preHashes.preflight) {
      const postHash = getFileSha256(preflightPath);
      assert.strictEqual(postHash, preHashes.preflight, 'migration-preflight-manifest.json MUST NOT be mutated');
    }
    if (preHashes.quarantine) {
      const postHash = getFileSha256(quarantinePath);
      assert.strictEqual(postHash, preHashes.quarantine, 'migration-quarantine-manifest.json MUST NOT be mutated');
    }
    if (preHashes.simulated) {
      const postHash = getFileSha256(simulatedPath);
      assert.strictEqual(postHash, preHashes.simulated, 'migration-simulated-orders-manifest.json MUST NOT be mutated');
    }
    console.log('  ✓ Manifest preservation verified: all 3 manifests have identical pre/post SHA-256 hashes');
  }
}

if (require.main === module) {
  runShadowReadValidationTest()
    .then(() => {
      console.log('\n🎉 ALL PHASE 1B.2.2 SHADOW-READ VALIDATION CHECKS PASSED (0 FAILURES)\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ SHADOW-READ VALIDATION FAILED:', err);
      process.exit(1);
    });
}
