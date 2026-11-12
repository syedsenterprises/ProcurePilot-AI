import { runApprovalTests } from './security/approval.test';
import { runPayPalTests } from './security/paypal.test';
import { runPayPalCheckoutLifecycleTests } from './security/paypal-checkout-lifecycle.test';
import { runPayPalWebhookTests } from './security/paypal-webhook.test';
import { runGeminiTests } from './security/gemini.test';
import { runRateLimitTests } from './security/rate-limit.test';
import { runValidationTests } from './security/validation.test';
import { runConfigTests } from './db/config.test';
import { runMigratorUnitTests } from './db/migrator.test';
import { runSchemaContractTests } from './db/schema-contract.test';
import { runLegacyPreflightTests } from './db/legacy-preflight.test';
import { runRefundIntegrityLogicTests } from './db/refund-integrity-logic.test';
import { runRefreshPersistenceTests } from './persistence/refresh-persistence.test';
import {
  setupTestIsolation,
  teardownTestIsolation,
  capturePersistentDataInventory,
  assertDataInventoryUnchanged,
} from './test-isolation';

async function main() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Automated Security & Integrity Suite');
  console.log('================================================================');

  // Capture baseline inventory before test execution
  const initialInventory = capturePersistentDataInventory();
  console.log(`[TEST ISOLATION] Baseline persistent inventory: ${initialInventory.ordersCount} orders, ${initialInventory.approvalsCount} approvals.`);

  // Setup isolated temporary directory in os.tmpdir()
  const { testDir } = setupTestIsolation();
  console.log(`[TEST ISOLATION] Active isolated temporary directory: ${testDir}`);

  try {
    await runApprovalTests();
    await runPayPalTests();
    await runPayPalCheckoutLifecycleTests();
    await runPayPalWebhookTests();
    await runGeminiTests();
    await runRateLimitTests();
    await runValidationTests();
    await runConfigTests();
    await runMigratorUnitTests();
    await runSchemaContractTests();
    await runLegacyPreflightTests();
    await runRefundIntegrityLogicTests();
    await runRefreshPersistenceTests();

    console.log('\n================================================================');
    console.log('🎉 ALL AUTOMATED SECURITY & CHECKOUT LIFECYCLE TESTS PASSED (0 FAILURES)');
    console.log('================================================================\n');
  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED:', error);
    process.exit(1);
  } finally {
    // Teardown temporary directory and restore store paths
    teardownTestIsolation();
    console.log(`[TEST ISOLATION] Cleaned up temporary test directory: ${testDir}`);

    // Verify persistent .data/ was not mutated
    const finalInventory = capturePersistentDataInventory();
    assertDataInventoryUnchanged(initialInventory, finalInventory);
    console.log(`[TEST ISOLATION] ✓ Verified persistent .data/ inventory strictly unchanged:`);
    console.log(`                Orders: ${finalInventory.ordersCount} files (0 mutated, 0 added)`);
    console.log(`                Approvals: ${finalInventory.approvalsCount} files (0 mutated, 0 added)`);
  }
}

main();
