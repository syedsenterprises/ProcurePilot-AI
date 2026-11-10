import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import assert from 'node:assert';
import { ApprovalService } from '../src/services/approval/approval.service';
import { PayPalOrderStore } from '../src/services/paypal/paypal-order-store';

export interface DataInventorySnapshot {
  ordersCount: number;
  approvalsCount: number;
  orderHashes: Record<string, string>;
  approvalHashes: Record<string, string>;
}

let activeTestDir: string | null = null;
let registeredExitHook = false;
let testSecretInjected = false;

/**
 * Captures an exact cryptographic fingerprint (SHA-256) and count of all records
 * in the persistent developer `.data/` directory.
 */
export function capturePersistentDataInventory(baseDir = process.cwd()): DataInventorySnapshot {
  const ordersDir = path.resolve(baseDir, '.data', 'orders');
  const approvalsDir = path.resolve(baseDir, '.data', 'approvals');

  const orderHashes: Record<string, string> = {};
  if (fs.existsSync(ordersDir)) {
    for (const file of fs.readdirSync(ordersDir).filter((f) => f.endsWith('.json')).sort()) {
      const fullPath = path.join(ordersDir, file);
      const content = fs.readFileSync(fullPath);
      orderHashes[file] = crypto.createHash('sha256').update(content).digest('hex');
    }
  }

  const approvalHashes: Record<string, string> = {};
  if (fs.existsSync(approvalsDir)) {
    for (const file of fs.readdirSync(approvalsDir).filter((f) => f.endsWith('.json')).sort()) {
      const fullPath = path.join(approvalsDir, file);
      const content = fs.readFileSync(fullPath);
      approvalHashes[file] = crypto.createHash('sha256').update(content).digest('hex');
    }
  }

  return {
    ordersCount: Object.keys(orderHashes).length,
    approvalsCount: Object.keys(approvalHashes).length,
    orderHashes,
    approvalHashes,
  };
}

/**
 * Asserts that the persistent `.data/` directory has not been modified, added to,
 * or deleted in any way during test execution.
 */
export function assertDataInventoryUnchanged(
  before: DataInventorySnapshot,
  after: DataInventorySnapshot
): void {
  assert.strictEqual(
    after.ordersCount,
    before.ordersCount,
    `Persistent .data/orders count changed! Before: ${before.ordersCount}, After: ${after.ordersCount}`
  );
  assert.strictEqual(
    after.approvalsCount,
    before.approvalsCount,
    `Persistent .data/approvals count changed! Before: ${before.approvalsCount}, After: ${after.approvalsCount}`
  );

  for (const [file, hash] of Object.entries(before.orderHashes)) {
    assert.strictEqual(
      after.orderHashes[file],
      hash,
      `Persistent order file ${file} was mutated during tests!`
    );
  }

  for (const [file, hash] of Object.entries(before.approvalHashes)) {
    assert.strictEqual(
      after.approvalHashes[file],
      hash,
      `Persistent approval file ${file} was mutated during tests!`
    );
  }
}

/**
 * Initializes an isolated temporary directory in os.tmpdir() for all test-created
 * orders and approvals. Ensures test data never touches the developer's `.data/` directory.
 */
export function setupTestIsolation(): { testDir: string; approvalsDir: string; ordersDir: string } {
  const uniqueId = `procurepilot-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeTestDir = path.resolve(os.tmpdir(), uniqueId);

  const approvalsDir = path.join(activeTestDir, 'approvals');
  const ordersDir = path.join(activeTestDir, 'orders');

  fs.mkdirSync(approvalsDir, { recursive: true });
  fs.mkdirSync(ordersDir, { recursive: true });

  process.env.DATA_STORE_DIR = activeTestDir;

  if (!process.env.APPROVAL_SECRET && !process.env.NEXTAUTH_SECRET) {
    process.env.APPROVAL_SECRET = `test_ephemeral_secret_${crypto.randomBytes(16).toString('hex')}`;
    testSecretInjected = true;
  }

  ApprovalService.getInstance().setStoreDir(approvalsDir);
  PayPalOrderStore.getInstance().setStoreDir(ordersDir);

  if (!registeredExitHook) {
    const cleanupOnExit = () => {
      teardownTestIsolation();
    };
    process.on('exit', cleanupOnExit);
    process.on('SIGINT', () => {
      cleanupOnExit();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanupOnExit();
      process.exit(143);
    });
    registeredExitHook = true;
  }

  return { testDir: activeTestDir, approvalsDir, ordersDir };
}

/**
 * Safely removes only the test run's isolated temporary directory and restores
 * production store directory paths.
 */
export function teardownTestIsolation(): void {
  if (activeTestDir && fs.existsSync(activeTestDir)) {
    try {
      fs.rmSync(activeTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on process termination
    }
  }

  activeTestDir = null;
  delete process.env.DATA_STORE_DIR;

  if (testSecretInjected) {
    delete process.env.APPROVAL_SECRET;
    testSecretInjected = false;
  }

  ApprovalService.getInstance().resetStoreDir();
  PayPalOrderStore.getInstance().resetStoreDir();
}
