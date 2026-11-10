import { runConfigTests } from './config.test';
import { runMigratorUnitTests } from './migrator.test';
import { runSchemaContractTests } from './schema-contract.test';
import { runLegacyPreflightTests } from './legacy-preflight.test';
import { runRefundIntegrityLogicTests } from './refund-integrity-logic.test';
import { runDatabaseIntegrationTests } from './integration.test';
import {
  setupTestIsolation,
  teardownTestIsolation,
  capturePersistentDataInventory,
  assertDataInventoryUnchanged,
} from '../test-isolation';

async function main() {
  console.log('================================================================');
  console.log('ProcurePilot AI — Phase 1B.1 Database Foundation Test Suite');
  console.log('================================================================\n');

  const initialInventory = capturePersistentDataInventory();
  const { testDir } = setupTestIsolation();

  try {
    await runConfigTests();
    console.log('');
    await runMigratorUnitTests();
    console.log('');
    await runSchemaContractTests();
    console.log('');
    await runLegacyPreflightTests();
    console.log('');
    await runRefundIntegrityLogicTests();
    console.log('');
    await runDatabaseIntegrationTests();

    console.log('\n================================================================');
    console.log('🎉 ALL PHASE 1B.1 DATABASE FOUNDATION UNIT & SPECIFICATION TESTS PASSED');
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n❌ DATABASE TEST SUITE FAILED:', err);
    process.exit(1);
  } finally {
    teardownTestIsolation();
    const finalInventory = capturePersistentDataInventory();
    assertDataInventoryUnchanged(initialInventory, finalInventory);
  }
}

if (require.main === module) {
  main();
}
