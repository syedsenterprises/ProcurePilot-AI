import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import {
  AUTHORITATIVE_ORDER_STATES,
  canTransitionOrder,
  validateOrderTransition,
  mapLegacyOrderStatusToDb,
} from '../../src/db/order-state-machine';

export async function runSchemaContractTests() {
  console.log('--- Running Schema Contract & Constraint Specification Tests ---');

  const m001Path = path.resolve(process.cwd(), 'src/db/migrations/001_initial_schema.sql');
  const m002Path = path.resolve(process.cwd(), 'src/db/migrations/002_refund_integrity.sql');
  const m003Path = path.resolve(process.cwd(), 'src/db/migrations/003_refund_attempt_security.sql');
  const m004Path = path.resolve(process.cwd(), 'src/db/migrations/004_non_forgeable_refund_authorization.sql');
  const m005Path = path.resolve(process.cwd(), 'src/db/migrations/005_legacy_approval_provenance.sql');

  const m001Sql = fs.readFileSync(m001Path, 'utf8');
  const m002Sql = fs.readFileSync(m002Path, 'utf8');
  const m003Sql = fs.readFileSync(m003Path, 'utf8');
  const m004Sql = fs.readFileSync(m004Path, 'utf8');
  const m005Sql = fs.readFileSync(m005Path, 'utf8');

  // Test 1: Exactly 13 core tables created
  console.log('Test 1: Verification of 13 Core Tables in Migration 001');
  const expectedTables = [
    'organizations',
    'procurement_requests',
    'approval_tickets',
    'approval_ticket_items',
    'orders',
    'order_items',
    'payment_attempts',
    'payment_captures',
    'payment_refunds',
    'payment_events',
    'webhook_events',
    'webhook_transmissions',
    'audit_events',
  ];

  for (const table of expectedTables) {
    const tableRegex = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
    assert.ok(tableRegex.test(m001Sql), `Missing authoritative table definition for "${table}"`);
  }
  console.log(`  ✓ All ${expectedTables.length} authoritative core tables defined in 001_initial_schema.sql`);

  // Test 2: Seed Tenant is provisioned
  console.log('Test 2: Verification of Seed Tenant 00000000-0000-0000-0000-000000000001');
  assert.ok(m001Sql.includes('00000000-0000-0000-0000-000000000001'));
  assert.ok(m001Sql.includes('default-enterprise'));
  console.log('  ✓ Deterministic seed organization provisioned for single-tenant phase');

  // Test 3: Composite tenant foreign keys
  console.log('Test 3: Verification of Composite Multi-Tenant Constraints');
  assert.ok(m001Sql.includes('CONSTRAINT uq_orders_org_id UNIQUE (organization_id, id)'));
  assert.ok(m001Sql.includes('CONSTRAINT uq_approval_tickets_org_ticket UNIQUE (organization_id, ticket_id)'));
  assert.ok(m001Sql.includes('CONSTRAINT fk_orders_org_ticket FOREIGN KEY (organization_id, ticket_id)'));
  assert.ok(m001Sql.includes('CONSTRAINT fk_order_items_org_order FOREIGN KEY (organization_id, order_id)'));
  console.log('  ✓ Cross-tenant composite foreign keys properly enforced in DDL');

  // Test 4: All 12 canonical order statuses present in check constraint & state machine
  console.log('Test 4: Verification of Order State Machine Check Constraint');
  assert.strictEqual(AUTHORITATIVE_ORDER_STATES.length, 12, 'Must have exactly 12 authoritative states');

  for (const status of AUTHORITATIVE_ORDER_STATES) {
    assert.ok(m001Sql.includes(`'${status}'`), `Missing expected order status '${status}' in 001 constraint`);
  }
  // Ensure obsolete legacy statuses are removed from DB constraint
  assert.ok(!m001Sql.includes("'PAYMENT_AUTHORIZED'"), 'Obsolete status PAYMENT_AUTHORIZED should not be in 001');
  assert.ok(!m001Sql.includes("'PAYMENT_PENDING'"), 'Obsolete status PAYMENT_PENDING should not be in 001');
  assert.ok(!m001Sql.includes("'PAYMENT_COMPLETED'"), 'Obsolete status PAYMENT_COMPLETED should not be in 001');

  // Verify state machine transitions
  assert.ok(canTransitionOrder('DRAFT', 'PENDING_PAYMENT_APPROVAL'));
  assert.ok(canTransitionOrder('PENDING_PAYMENT_APPROVAL', 'BUYER_APPROVED'));
  assert.ok(canTransitionOrder('BUYER_APPROVED', 'SETTLING'));
  assert.ok(canTransitionOrder('SETTLING', 'COMPLETED'));
  assert.ok(canTransitionOrder('COMPLETED', 'PARTIALLY_REFUNDED'));
  assert.ok(canTransitionOrder('PARTIALLY_REFUNDED', 'REFUNDED'));
  assert.ok(!canTransitionOrder('REFUNDED', 'DRAFT'), 'Terminal state REFUNDED cannot transition back');
  assert.ok(!canTransitionOrder('CANCELLED', 'COMPLETED'), 'Terminal state CANCELLED cannot transition');

  assert.throws(() => {
    validateOrderTransition('REFUNDED', 'SETTLING');
  }, /Invalid Order Status Transition/);

  // Legacy status conversion
  assert.strictEqual(mapLegacyOrderStatusToDb('CREATED', false), 'DRAFT');
  assert.strictEqual(mapLegacyOrderStatusToDb('CREATED', true), 'PENDING_PAYMENT_APPROVAL');
  assert.strictEqual(mapLegacyOrderStatusToDb('SAVED'), 'PENDING_PAYMENT_APPROVAL');
  assert.strictEqual(mapLegacyOrderStatusToDb('APPROVED'), 'BUYER_APPROVED');
  assert.strictEqual(mapLegacyOrderStatusToDb('CAPTURED'), 'COMPLETED');
  assert.strictEqual(mapLegacyOrderStatusToDb('VOIDED'), 'CANCELLED');
  console.log('  ✓ All 12 canonical order states, transition validation and legacy conversion verified');

  // Test 5: Refund reservation, settlement finalization, and immutability triggers in Migration 002
  console.log('Test 5: Verification of Refund Stored Functions, Finalization, and Immutability Invariants');
  assert.ok(m002Sql.includes('CREATE OR REPLACE FUNCTION create_refund_reservation'));
  assert.ok(m002Sql.includes('PERFORM id FROM orders WHERE id = p_order_id FOR UPDATE'));
  assert.ok(m002Sql.includes('CREATE OR REPLACE FUNCTION finalize_refund_settlement'));
  assert.ok(m002Sql.includes('CREATE OR REPLACE FUNCTION check_refund_balance_trigger'));
  assert.ok(m002Sql.includes('CREATE TRIGGER trg_enforce_refund_balance'));
  assert.ok(m002Sql.includes('CREATE OR REPLACE FUNCTION prevent_immutable_record_mutation'));
  assert.ok(m002Sql.includes('CREATE TRIGGER trg_immutable_payment_captures'));
  assert.ok(m002Sql.includes('CREATE TRIGGER trg_immutable_payment_refunds'));
  console.log('  ✓ Stored procedures and append-only immutability triggers defined in 002_refund_integrity.sql');

  // Test 6: Refund Attempt Write-Path Security Invariants in Migration 003
  console.log('Test 6: Verification of Refund Attempt Write-Path Security in Migration 003');
  assert.ok(m003Sql.includes('CREATE OR REPLACE FUNCTION enforce_refund_attempt_security'));
  assert.ok(m003Sql.includes('CREATE TRIGGER trg_protect_refund_attempts'));
  assert.ok(m003Sql.includes('CREATE OR REPLACE FUNCTION record_refund_failure'));
  assert.ok(m003Sql.includes('CREATE OR REPLACE FUNCTION record_refund_outcome_unknown'));
  assert.ok(m003Sql.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC'));
  assert.ok(m003Sql.includes('REVOKE CREATE ON SCHEMA public FROM procurepilot_app'));
  assert.ok(m003Sql.includes('GRANT EXECUTE ON FUNCTION record_refund_failure'));
  assert.ok(m003Sql.includes('GRANT EXECUTE ON FUNCTION record_refund_outcome_unknown'));
  console.log('  ✓ Refund attempt protection trigger, failure/ambiguity functions, and role grants verified in 003');

  // Test 7: Non-Forgeable Refund Authorization Invariants in Migration 004
  console.log('Test 7: Verification of Non-Forgeable Refund Authorization in Migration 004');
  assert.ok(m004Sql.includes('procurepilot_refund_owner'), 'Migration 004 must reference procurepilot_refund_owner');
  assert.ok(m004Sql.includes('WITH NOLOGIN'), 'Dedicated refund owner role must be NOLOGIN');
  assert.ok(m004Sql.includes("current_user = 'procurepilot_refund_owner'"), 'Trigger must use current_user execution identity');
  assert.ok(m004Sql.includes('SECURITY INVOKER'), 'Trigger function must be explicitly SECURITY INVOKER');
  assert.ok(!m004Sql.includes('procurepilot.controlled_refund_context'), 'Forgeable custom GUC setting must be removed from 004');
  assert.ok(m004Sql.includes('ALTER FUNCTION create_refund_reservation'), 'Must reassign ownership of create_refund_reservation');
  assert.ok(m004Sql.includes('ALTER FUNCTION finalize_refund_settlement'), 'Must reassign ownership of finalize_refund_settlement');
  assert.ok(m004Sql.includes('ALTER FUNCTION record_refund_failure'), 'Must reassign ownership of record_refund_failure');
  assert.ok(m004Sql.includes('ALTER FUNCTION record_refund_outcome_unknown'), 'Must reassign ownership of record_refund_outcome_unknown');
  assert.ok(m004Sql.includes('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO procurepilot_refund_owner'), 'Refund owner must have sequence privileges for payment_events');
  assert.ok(m004Sql.includes('REVOKE CREATE ON SCHEMA public FROM procurepilot_refund_owner'), 'Schema creation must be revoked from refund owner');
  assert.ok(m004Sql.includes('SET search_path = pg_catalog, public, pg_temp;'), 'Must configure fixed trusted search_path with pg_temp last');
  assert.ok(m004Sql.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC;'), 'Must revoke CREATE on public from PUBLIC');
  assert.ok(m004Sql.includes('REVOKE CREATE ON SCHEMA public FROM procurepilot_app;'), 'Must revoke CREATE on public from procurepilot_app');
  console.log('  ✓ Dedicated non-login role, SECURITY DEFINER ownership, safe search_path, and GUC removal verified in 004');

  // Test 8: Legacy Approval Provenance & Integrity Constraints in Migration 005
  console.log('Test 8: Verification of Legacy Approval Provenance Schema & Constraints in Migration 005');
  assert.ok(m005Sql.includes('procurepilot_legacy_importer'), 'Migration 005 must define procurepilot_legacy_importer');
  assert.ok(m005Sql.includes('WITH NOLOGIN'), 'Dedicated legacy importer role must be NOLOGIN');
  assert.ok(m005Sql.includes('REVOKE CREATE ON SCHEMA public FROM procurepilot_legacy_importer'), 'Schema creation must be revoked from legacy importer');
  assert.ok(!m005Sql.includes('procurepilot_admin'), 'Migration 005 must NOT contain procurepilot_admin');
  assert.ok(!m005Sql.toLowerCase().includes('password'), 'Migration 005 must NOT contain any embedded passwords or credentials');
  assert.ok(!m005Sql.includes('ON CONFLICT (ticket_id) DO UPDATE'), 'import_legacy_approval_ticket must NOT use ON CONFLICT DO UPDATE');
  assert.ok(m005Sql.includes('ALTER COLUMN challenge_signature DROP NOT NULL'), 'Must drop NOT NULL on challenge_signature');
  assert.ok(m005Sql.includes('chk_approval_tickets_provenance'), 'Must define composite provenance constraint chk_approval_tickets_provenance');
  assert.ok(m005Sql.includes("'RUNTIME'"), 'Must reference RUNTIME source origin');
  assert.ok(m005Sql.includes("'LEGACY_JSON_IMPORT'"), 'Must reference LEGACY_JSON_IMPORT source origin');
  assert.ok(m005Sql.includes("'VERIFIED'"), 'Must reference VERIFIED integrity status');
  assert.ok(m005Sql.includes("'UNVERIFIABLE_LEGACY'"), 'Must reference UNVERIFIABLE_LEGACY integrity status');
  assert.ok(m005Sql.includes('import_legacy_approval_ticket'), 'Must define import_legacy_approval_ticket function');
  assert.ok(m005Sql.includes('import_legacy_approval_ticket_item'), 'Must define import_legacy_approval_ticket_item function');
  assert.ok(m005Sql.includes('import_legacy_order'), 'Must define import_legacy_order function');
  assert.ok(m005Sql.includes('import_legacy_order_item'), 'Must define import_legacy_order_item function');
  assert.ok(m005Sql.includes('legacy_migration_execution_audit'), 'Must define legacy_migration_execution_audit table');
  assert.ok(m005Sql.includes('SECURITY DEFINER'), 'Import functions must be SECURITY DEFINER');
  assert.ok(m005Sql.includes('SET search_path = pg_catalog, public, pg_temp'), 'Must configure fixed trusted search_path with pg_temp last');
  assert.ok(m005Sql.includes('OWNER TO procurepilot_legacy_importer'), 'Import functions must be owned by procurepilot_legacy_importer');
  assert.ok(m005Sql.includes('REVOKE ALL ON FUNCTION import_legacy_approval_ticket'), 'Must revoke execute from PUBLIC');
  assert.ok(m005Sql.includes('REVOKE ALL ON FUNCTION import_legacy_order'), 'Must revoke execute on import_legacy_order from PUBLIC');
  assert.ok(m005Sql.includes('FROM procurepilot_app'), 'Must revoke execute from runtime role procurepilot_app');
  assert.ok(m005Sql.includes('enforce_approval_provenance_security'), 'Must define enforce_approval_provenance_security trigger function');
  assert.ok(m005Sql.includes('trg_protect_approval_provenance'), 'Must define trg_protect_approval_provenance trigger');
  assert.ok(m005Sql.includes('BEFORE INSERT OR UPDATE OR DELETE ON approval_tickets'), 'Approval trigger must enforce immutability on UPDATE and DELETE');
  assert.ok(m005Sql.includes('enforce_order_provenance_security'), 'Must define enforce_order_provenance_security trigger function');
  assert.ok(m005Sql.includes('trg_protect_order_provenance'), 'Must define trg_protect_order_provenance trigger');
  assert.ok(m005Sql.includes('BEFORE INSERT OR UPDATE OR DELETE ON orders'), 'Order trigger must enforce immutability on UPDATE and DELETE');
  assert.ok(m005Sql.includes('trg_protect_approval_ticket_items_provenance'), 'Must define trg_protect_approval_ticket_items_provenance trigger');
  assert.ok(m005Sql.includes('trg_protect_order_items_provenance'), 'Must define trg_protect_order_items_provenance trigger');
  assert.ok(!m005Sql.includes("current_user NOT IN ('procurepilot_legacy_importer', 'postgres')"), 'Superuser postgres must not be allowlisted in triggers');
  console.log('  ✓ Dedicated non-login importer role, no embedded credentials, superuser unallowlisted, SECURITY DEFINER ownership, safe search_path, provenance constraints, strict immutability triggers for parents & children, and grant isolation verified in 005');
}

if (require.main === module) {
  runSchemaContractTests().catch((err) => {
    console.error('Schema contract tests failed:', err);
    process.exit(1);
  });
}
