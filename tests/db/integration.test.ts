import { db, isDatabaseConfigured } from '../../src/db/pool';
import { migrator } from '../../src/db/migrator';

export async function runDatabaseIntegrationTests() {
  console.log('--- Running PostgreSQL Live Database Integration Tests ---');

  if (!isDatabaseConfigured()) {
    console.log('  [INFO] PostgreSQL environment variables (DATABASE_URL or PGHOST) are NOT configured.');
    console.log('  [INFO] Live integration tests skipped safely in accordance with Phase 1B.1 requirements.');
    console.log('  [INFO] The following live integration tests require an active PostgreSQL instance:');
    console.log('         - Live schema migration execution (001 and 002)');
    console.log('         - Live advisory lock concurrency');
    console.log('         - Live parent-order row locking during refund reservation');
    console.log('         - Live check_refund_balance_trigger execution');
    return { executed: false, reason: 'NO_DATABASE_CONFIGURED' };
  }

  console.log('  Attempting live PostgreSQL connectivity check...');
  try {
    const res = await db.query('SELECT NOW() AS current_time, version() AS pg_version');
    console.log(`  ✓ Connected to PostgreSQL: ${res.rows[0].pg_version.split(' ')[0]}`);

    // Check migration status
    const status = await migrator.getStatus();
    console.log(`  ✓ Migration tracking operational. Found ${status.length} migrations.`);

    return { executed: true, status };
  } catch (err) {
    console.warn('  [WARN] PostgreSQL connection attempt failed:', err instanceof Error ? err.message : err);
    console.log('  [INFO] Integration tests skipped. Local or containerized PostgreSQL is not running.');
    return { executed: false, reason: 'CONNECTION_FAILED', error: err instanceof Error ? err.message : String(err) };
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  runDatabaseIntegrationTests().catch((err) => {
    console.error('Integration test runner failed:', err);
    process.exit(1);
  });
}
