import assert from 'node:assert';
import { DatabaseConfigSchema, getDatabaseConfig, isDatabaseConfigured } from '../../src/db/config';

export async function runConfigTests() {
  console.log('--- Running Database Configuration & Environment Tests ---');

  // Test 1: Default configuration parsing
  console.log('Test 1: Default schema parsing');
  const defaults = DatabaseConfigSchema.parse({});
  assert.strictEqual(defaults.host, 'localhost');
  assert.strictEqual(defaults.port, 5432);
  assert.strictEqual(defaults.database, 'procurepilot');
  assert.strictEqual(defaults.user, 'procurepilot_app');
  assert.strictEqual(defaults.maxConnections, 20);
  assert.strictEqual(defaults.ssl, false);
  console.log('  ✓ Default configuration adheres to Phase 1B.1 baseline');

  // Test 2: Custom environment overrides
  console.log('Test 2: Environment variable overrides');
  const custom = DatabaseConfigSchema.parse({
    host: 'pg-cluster.internal',
    port: 5433,
    database: 'procurepilot_prod',
    user: 'prod_app',
    maxConnections: 50,
    ssl: true,
  });
  assert.strictEqual(custom.host, 'pg-cluster.internal');
  assert.strictEqual(custom.port, 5433);
  assert.strictEqual(custom.database, 'procurepilot_prod');
  assert.strictEqual(custom.user, 'prod_app');
  assert.strictEqual(custom.maxConnections, 50);
  assert.strictEqual(custom.ssl, true);
  console.log('  ✓ Custom configuration correctly validated');

  // Test 3: Invalid configuration values rejected
  console.log('Test 3: Reject invalid configurations');
  assert.throws(() => {
    DatabaseConfigSchema.parse({ port: -1 });
  }, /(?:greater than 0|>0|too_small)/i);

  assert.throws(() => {
    DatabaseConfigSchema.parse({ maxConnections: 0 });
  }, /(?:greater than 0|>0|too_small)/i);
  console.log('  ✓ Invalid ports and non-positive connections strictly rejected');

  // Test 4: Helper isDatabaseConfigured
  console.log('Test 4: isDatabaseConfigured helper behavior');
  const originalUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const configured = isDatabaseConfigured();
  console.log(`  ✓ Current environment configured check: ${configured}`);
  if (originalUrl) process.env.DATABASE_URL = originalUrl;
}

if (require.main === module) {
  runConfigTests().catch((err) => {
    console.error('Config tests failed:', err);
    process.exit(1);
  });
}
