import assert from 'node:assert';
import { RateLimiter, MemoryRateLimitStore, FileRateLimitStore } from '../../src/lib/security/rate-limiter';
import { AuditLogger, auditLogger } from '../../src/lib/security/audit-logger';
import { setupTestIsolation, teardownTestIsolation } from '../test-isolation';
import path from 'path';
import fs from 'fs';
import os from 'os';

export async function runRateLimitTests() {
  const needsLocalIsolation = !process.env.DATA_STORE_DIR;
  if (needsLocalIsolation) {
    setupTestIsolation();
  }

  try {
    console.log('\n--- Running Rate Limiting, Audit Logging & Isolation Tests ---');

  // Test 1: In-Memory / Window Limit Enforcement
  console.log('Test 1: Request Rate Limit Enforcement');
  const limiter = RateLimiter.getInstance();
  limiter.setStore(new MemoryRateLimitStore());

  const options = {
    windowMs: 1000,
    max: 3,
    endpointName: 'test-endpoint'
  };

  const client = '192.168.1.100';

  const res1 = await limiter.checkLimit(client, options);
  assert.strictEqual(res1.allowed, true);
  assert.strictEqual(res1.remaining, 2);

  const res2 = await limiter.checkLimit(client, options);
  assert.strictEqual(res2.allowed, true);
  assert.strictEqual(res2.remaining, 1);

  const res3 = await limiter.checkLimit(client, options);
  assert.strictEqual(res3.allowed, true);
  assert.strictEqual(res3.remaining, 0);

  // 4th request exceeds max
  const res4 = await limiter.checkLimit(client, options);
  assert.strictEqual(res4.allowed, false);
  assert.strictEqual(res4.remaining, 0);
  console.log('  ✓ 4th request successfully rate-limited (HTTP 429 triggered)');

  // Test 2: File-Based Persistence Store Across Process Instances
  console.log('Test 2: Multi-Instance File-Based Persistent Rate Limit Store');
  const tempDir = path.resolve(os.tmpdir(), `procurepilot-test-rate-limits-${Date.now()}`);
  const fileStoreInstance1 = new FileRateLimitStore(tempDir);
  const fileStoreInstance2 = new FileRateLimitStore(tempDir); // Simulates second worker process

  const testKey = 'worker-test-key';
  const entry1 = await fileStoreInstance1.increment(testKey, 5000);
  assert.strictEqual(entry1.count, 1);

  // Second instance reads and increments the same persistent key
  const entry2 = await fileStoreInstance2.increment(testKey, 5000);
  assert.strictEqual(entry2.count, 2, 'Second process instance must coordinate and increment persistent count to 2');

  console.log('  ✓ Persistent store coordinates rate-limiting across multi-instance workers');

  // Cleanup test dir
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // --- DATA_STORE_DIR Isolation Tests ---
  const savedDataStoreDir = process.env.DATA_STORE_DIR;
  const uniqueIsolationDir = path.resolve(
    os.tmpdir(),
    `procurepilot-isolation-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  try {
    // Capture baseline mtime of authoritative .data/ if it exists
    const baselineAuditFile = path.resolve(process.cwd(), '.data', 'audit', 'audit.log');
    const baselineAuditMtime = fs.existsSync(baselineAuditFile)
      ? fs.statSync(baselineAuditFile).mtimeMs
      : null;
    const baselineRateLimitsDir = path.resolve(process.cwd(), '.data', 'rate-limits');
    const baselineRateLimitFiles = fs.existsSync(baselineRateLimitsDir)
      ? fs.readdirSync(baselineRateLimitsDir)
      : [];

    process.env.DATA_STORE_DIR = uniqueIsolationDir;

    // Test 3: AuditLogger respects DATA_STORE_DIR and writes to isolated directory
    console.log('Test 3: AuditLogger respects DATA_STORE_DIR and isolates writes');
    const isolatedLogger = new AuditLogger();
    assert.strictEqual(
      isolatedLogger.getLogDir(),
      path.resolve(uniqueIsolationDir, 'audit'),
      'AuditLogger logDir must resolve under DATA_STORE_DIR/audit'
    );
    assert.strictEqual(
      isolatedLogger.getLogFile(),
      path.resolve(uniqueIsolationDir, 'audit', 'audit.log'),
      'AuditLogger logFile must resolve to DATA_STORE_DIR/audit/audit.log'
    );

    isolatedLogger.log('APPROVAL_CHALLENGE_CREATED', 'INFO', 'Isolation verification test event', {
      sessionId: 'iso-session-123',
      details: { testAttr: 'verification_value' }
    });

    const writtenLogFile = isolatedLogger.getLogFile();
    assert.strictEqual(fs.existsSync(writtenLogFile), true, 'Isolated audit log file must exist');
    const logContents = fs.readFileSync(writtenLogFile, 'utf8');
    assert.match(logContents, /Isolation verification test event/);
    assert.match(logContents, /verification_value/);
    console.log('  ✓ AuditLogger wrote strictly under DATA_STORE_DIR/audit/audit.log');

    // Test 4: FileRateLimitStore respects DATA_STORE_DIR and isolates writes
    console.log('Test 4: FileRateLimitStore respects DATA_STORE_DIR and isolates writes');
    const isolatedStore = new FileRateLimitStore();
    assert.strictEqual(
      isolatedStore.getStoreDir(),
      path.resolve(uniqueIsolationDir, 'rate-limits'),
      'FileRateLimitStore storeDir must resolve under DATA_STORE_DIR/rate-limits'
    );

    const rateEntry = await isolatedStore.increment('iso-test-client', 10000);
    assert.strictEqual(rateEntry.count, 1);

    const writtenRateFiles = fs.readdirSync(path.resolve(uniqueIsolationDir, 'rate-limits'));
    assert.strictEqual(writtenRateFiles.length, 1, 'Exactly one rate-limit file must be written in isolated directory');
    console.log('  ✓ FileRateLimitStore wrote strictly under DATA_STORE_DIR/rate-limits/');

    // Test 5: Verify authoritative .data/ was NOT written to or modified
    console.log('Test 5: Neither service wrote into authoritative .data/ during isolation');
    if (baselineAuditMtime !== null) {
      const currentAuditMtime = fs.statSync(baselineAuditFile).mtimeMs;
      assert.strictEqual(
        currentAuditMtime,
        baselineAuditMtime,
        'Authoritative .data/audit/audit.log was mutated during isolated logging!'
      );
    }
    if (fs.existsSync(baselineRateLimitsDir)) {
      const currentRateLimitFiles = fs.readdirSync(baselineRateLimitsDir);
      assert.deepStrictEqual(
        currentRateLimitFiles,
        baselineRateLimitFiles,
        'Authoritative .data/rate-limits/ directory files changed during isolated test!'
      );
    }
    console.log('  ✓ Authoritative .data/ directory completely untouched during isolated operations');

    // Test 6: Default path fallback when DATA_STORE_DIR is absent
    console.log('Test 6: Existing default path behavior preserved when DATA_STORE_DIR is absent');
    delete process.env.DATA_STORE_DIR;

    const defaultLogger = new AuditLogger();
    assert.strictEqual(
      defaultLogger.getLogDir(),
      path.resolve(process.cwd(), '.data', 'audit'),
      'Default AuditLogger logDir must resolve to project .data/audit when DATA_STORE_DIR is unset'
    );

    const defaultStore = new FileRateLimitStore();
    assert.strictEqual(
      defaultStore.getStoreDir(),
      path.resolve(process.cwd(), '.data', 'rate-limits'),
      'Default FileRateLimitStore storeDir must resolve to project .data/rate-limits when DATA_STORE_DIR is unset'
    );
    console.log('  ✓ Default paths resolve to project .data/audit and .data/rate-limits when DATA_STORE_DIR is absent');

    // Test 7: Secret redaction in AuditLogger
    console.log('Test 7: Secret sanitization in AuditLogger details and messages');
    const secretTestDir = path.resolve(uniqueIsolationDir, 'secret-audit');
    const secretLogger = new AuditLogger(secretTestDir);
    secretLogger.log('APPROVAL_UNAUTHORIZED', 'WARN', 'Test with secret in URL: https://api.example.com?key=supersecret123', {
      details: {
        password: 'PlainTextPassword123',
        client_secret: 'paypal_secret_val',
        publicField: 'safe_value'
      }
    });

    const secretLogContent = fs.readFileSync(path.join(secretTestDir, 'audit.log'), 'utf8');
    assert.doesNotMatch(secretLogContent, /supersecret123/);
    assert.doesNotMatch(secretLogContent, /PlainTextPassword123/);
    assert.doesNotMatch(secretLogContent, /paypal_secret_val/);
    assert.match(secretLogContent, /\[REDACTED\]/);
    assert.match(secretLogContent, /safe_value/);
    console.log('  ✓ Secrets in audit log fields and URLs are strictly redacted');
  } finally {
    // Teardown: restore environment and delete temporary isolation directory
    if (savedDataStoreDir !== undefined) {
      process.env.DATA_STORE_DIR = savedDataStoreDir;
    } else {
      delete process.env.DATA_STORE_DIR;
    }

    try {
      if (fs.existsSync(uniqueIsolationDir)) {
        fs.rmSync(uniqueIsolationDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  }

  console.log('✅ ALL RATE LIMITING, AUDIT LOGGING & ISOLATION TESTS PASSED');
  } finally {
    if (needsLocalIsolation) {
      teardownTestIsolation();
    }
  }
}

if (require.main === module) {
  runRateLimitTests()
    .then(() => console.log('✅ All rate limit and isolation tests executed successfully'))
    .catch((err) => {
      console.error('❌ Rate limit and isolation test suite failed:', err);
      process.exit(1);
    });
}
