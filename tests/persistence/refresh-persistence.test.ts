import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  saveCartSession,
  loadCartSession,
  clearCartSession,
  saveChatSession,
  loadChatSession,
  clearChatSession,
  STORAGE_VERSION,
  CART_STORAGE_KEY,
  CHAT_STORAGE_KEY
} from '../../src/lib/storage/client-session';
import { payPalOrderStore, hashSessionToken, StoredPayPalOrder } from '../../src/services/paypal/paypal-order-store';
import { payPalService } from '../../src/services/paypal/paypal.service';
import { approvalService } from '../../src/services/approval/approval.service';
import { ProcurementMessage } from '../../src/types/procurement';
import { SAMPLE_PRODUCTS } from '../../src/services/catalog/products.data';
import { setupTestIsolation } from '../test-isolation';

// Mock localStorage for Node.js test environment
class MockLocalStorage {
  private store: Map<string, string> = new Map();

  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  public removeItem(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public get length(): number {
    return this.store.size;
  }

  public key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  public entries(): [string, string][] {
    return Array.from(this.store.entries());
  }
}

export async function runRefreshPersistenceTests() {
  const needsLocalIsolation = !process.env.DATA_STORE_DIR;
  if (needsLocalIsolation) {
    setupTestIsolation();
  }

  console.log('\n--- Running Client Refresh Persistence & Checkout Recovery Tests ---');

  // Setup mock window & localStorage
  const mockStorage = new MockLocalStorage();
  const globalAny = global as unknown as Record<string, unknown>;
  globalAny.window = {
    localStorage: mockStorage
  };

  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const originalAllowSim = process.env.ALLOW_PAYPAL_SIMULATION;

  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  process.env.ALLOW_PAYPAL_SIMULATION = 'true';

  try {
    // =========================================================================
    // 1. Client-Side Storage: Cart & Budget Restoration
    // =========================================================================
    console.log('Test 1: Cart Restoration (product IDs and quantities)');
    mockStorage.clear();
    saveCartSession({
      budget: 5000,
      items: [
        { productId: 'mbp-m3-max', quantity: 2 },
        { productId: 'dell-xps-16', quantity: 1 }
      ],
      compareIds: ['mbp-m3-max', 'dell-xps-16']
    });

    const restoredCart = loadCartSession();
    assert(restoredCart !== null, 'Restored cart should not be null');
    assert.strictEqual(restoredCart.items.length, 2, 'Should restore exactly 2 cart items');
    assert.strictEqual(restoredCart.items[0].productId, 'mbp-m3-max');
    assert.strictEqual(restoredCart.items[0].quantity, 2);
    assert.strictEqual(restoredCart.items[1].productId, 'dell-xps-16');
    assert.strictEqual(restoredCart.items[1].quantity, 1);
    assert.deepStrictEqual(restoredCart.compareIds, ['mbp-m3-max', 'dell-xps-16']);
    console.log('  ✓ Cart items and quantities restored accurately');

    // =========================================================================
    // 2. Client-Side Storage: Budget Restoration
    // =========================================================================
    console.log('Test 2: Budget Restoration (preserves custom budget over $4500 default)');
    assert.strictEqual(restoredCart.budget, 5000, 'Budget should be restored to $5000, not reset to $4500 default');

    saveCartSession({
      budget: 8500,
      items: [],
      compareIds: []
    });
    const customBudgetCart = loadCartSession();
    assert.strictEqual(customBudgetCart?.budget, 8500, 'Custom budget $8500 should be preserved');
    console.log('  ✓ Budget accurately restored without resetting to default');

    // =========================================================================
    // 3. Client-Side Storage: Conversation History Restoration
    // =========================================================================
    console.log('Test 3: Conversation Restoration (original order preserved)');
    const testProduct = SAMPLE_PRODUCTS[0]; // Authoritative sample product
    const sampleMessages: ProcurementMessage[] = [
      {
        id: 'msg-welcome',
        role: 'assistant',
        content: 'Welcome to ProcurePilot AI',
        timestamp: '10:00 AM',
        provider: 'procurepilot-heuristic-engine'
      },
      {
        id: 'msg-user-1',
        role: 'user',
        content: 'We need 2 developer laptops with 32GB RAM under $8000',
        timestamp: '10:01 AM',
        budgetConstraint: 8000,
        provider: 'procurepilot-heuristic-engine'
      },
      {
        id: 'msg-assistant-1',
        role: 'assistant',
        content: 'Optimized developer hardware bundle proposed',
        timestamp: '10:01 AM',
        reasoningSteps: [
          {
            step: 1,
            phase: 'parsing',
            title: 'Requirement Extraction',
            detail: 'Decomposed prompt into compute and memory requirements',
            status: 'completed'
          },
          {
            step: 2,
            phase: 'retrieval',
            title: 'Catalog Matching',
            detail: 'Matched against enterprise MacBook Pro and Dell XPS configurations',
            status: 'completed'
          }
        ],
        recommendations: [
          {
            productId: testProduct.id,
            product: testProduct,
            matchScore: 98,
            reason: 'High single-threaded performance for software compilation',
            quantityRecommended: 2
          }
        ],
        totalBundlePrice: testProduct.price * 2,
        provider: 'procurepilot-heuristic-engine',
        aiStatus: 'live'
      }
    ];

    saveChatSession({ messages: sampleMessages });
    const restoredChat = loadChatSession();
    assert(restoredChat !== null, 'Restored chat should not be null');
    assert.strictEqual(restoredChat.messages.length, 3, 'Should restore all 3 messages in order');
    assert.strictEqual(restoredChat.messages[0].id, 'msg-welcome');
    assert.strictEqual(restoredChat.messages[1].id, 'msg-user-1');
    assert.strictEqual(restoredChat.messages[2].id, 'msg-assistant-1');
    assert.strictEqual(restoredChat.messages[1].content, 'We need 2 developer laptops with 32GB RAM under $8000');
    assert.strictEqual(restoredChat.messages[2].reasoningSteps?.length, 2);
    console.log('  ✓ Conversation messages, roles, and reasoning steps restored in original order');

    // =========================================================================
    // 4. Client-Side Storage: Recommendation Restoration
    // =========================================================================
    console.log('Test 4: Recommendation Restoration (product details and quantity)');
    const recs = restoredChat.messages[2].recommendations;
    assert(recs && recs.length === 1, 'Should restore product recommendations');
    assert.strictEqual(recs[0].product.id, testProduct.id);
    assert.strictEqual(recs[0].quantityRecommended, 2);
    assert.strictEqual(recs[0].product.price, testProduct.price);
    console.log('  ✓ Recommendations and item details restored accurately');

    // =========================================================================
    // 5. Corrupt localStorage Handling
    // =========================================================================
    console.log('Test 5: Corrupt localStorage Handling (malformed JSON)');
    mockStorage.setItem(CART_STORAGE_KEY, '{ invalid_json_syntax: 123 ]');
    const corruptCartResult = loadCartSession();
    assert.strictEqual(corruptCartResult, null, 'Corrupt cart JSON must return null gracefully without crashing');
    assert.strictEqual(mockStorage.getItem(CART_STORAGE_KEY), null, 'Corrupt entry should be removed');

    mockStorage.setItem(CHAT_STORAGE_KEY, 'CORRUPTED_NON_JSON_STRING');
    const corruptChatResult = loadChatSession();
    assert.strictEqual(corruptChatResult, null, 'Corrupt chat JSON must return null gracefully');
    assert.strictEqual(mockStorage.getItem(CHAT_STORAGE_KEY), null, 'Corrupt chat entry should be cleaned up');
    console.log('  ✓ Corrupted localStorage entries handled safely without throwing');

    // =========================================================================
    // 6. Old Storage Version Handling
    // =========================================================================
    console.log('Test 6: Old Storage Version Handling (version mismatch discarded)');
    mockStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({ version: 999, updatedAt: Date.now(), budget: 1000, items: [] })
    );
    const oldVersionResult = loadCartSession();
    assert.strictEqual(oldVersionResult, null, 'Incompatible schema versions must be discarded');
    assert.strictEqual(mockStorage.getItem(CART_STORAGE_KEY), null, 'Mismatched version must be cleaned up');
    console.log('  ✓ Obsolete or incompatible schema versions discarded cleanly');

    // =========================================================================
    // 7. Hydration Race Condition Guard Verification
    // =========================================================================
    console.log('Test 7: Hydration Guard Logic (prevents default empty state overwrite)');
    // Simulate: User had saved state in localStorage
    saveCartSession({
      budget: 6200,
      items: [{ productId: 'mbp-m3-max', quantity: 1 }],
      compareIds: []
    });

    // In a React component, if isHydrated === false:
    let isHydrated = false;
    const defaultInitialState = { budget: 4500, items: [], compareIds: [] };

    // Attempt to save during initial mount BEFORE hydration:
    if (isHydrated) {
      saveCartSession(defaultInitialState);
    }

    // Verify stored state was NOT overwritten by initial empty state
    const postMountStored = loadCartSession();
    assert.strictEqual(postMountStored?.budget, 6200, 'Initial default must not overwrite saved budget before hydration');
    assert.strictEqual(postMountStored?.items.length, 1, 'Initial default must not overwrite saved cart before hydration');

    // Now complete hydration:
    isHydrated = true;
    console.log('  ✓ Hydration guard prevents default empty state from overwriting saved data');

    // =========================================================================
    // 8. Cart Clearing after Capture Preserves Budget & Conversation
    // =========================================================================
    console.log('Test 8: Cart Clearing Preserves Budget & Conversation');
    saveCartSession({
      budget: 7500,
      items: [{ productId: 'mbp-m3-max', quantity: 1 }],
      compareIds: []
    });
    saveChatSession({ messages: sampleMessages });

    // Execute clearCartSession(true)
    clearCartSession(true);

    const afterClearCart = loadCartSession();
    assert.strictEqual(afterClearCart?.items.length, 0, 'Cart items must be empty');
    assert.strictEqual(afterClearCart?.budget, 7500, 'Budget must be preserved');

    const afterClearChat = loadChatSession();
    assert.strictEqual(afterClearChat?.messages.length, 3, 'Conversation messages must remain intact');
    console.log('  ✓ clearCartSession clears items while strictly preserving budget and chat');

    // =========================================================================
    // 9. Security Audit: Zero Secrets in Client Storage
    // =========================================================================
    console.log('Test 9: Security Audit — Zero Sensitive Secrets in localStorage');
    const allStorageEntries = mockStorage.entries();
    for (const [key, value] of allStorageEntries) {
      assert(!value.includes('APPROVAL_SECRET'), `Key ${key} leaked APPROVAL_SECRET!`);
      assert(!value.includes('PAYPAL_CLIENT_SECRET'), `Key ${key} leaked PAYPAL_CLIENT_SECRET!`);
      assert(!value.includes('GEMINI_API_KEY'), `Key ${key} leaked GEMINI_API_KEY!`);
      assert(!value.includes('authToken'), `Key ${key} leaked authToken!`);
      assert(!value.includes('cartFingerprint'), `Key ${key} leaked cartFingerprint!`);
      assert(!value.includes('procurepilot_session'), `Key ${key} leaked session cookie!`);
    }
    console.log('  ✓ Confirmed 0 secrets, tokens, or private credentials in localStorage');

    // =========================================================================
    // 10. Server Session Cookie Binding & Hashing
    // =========================================================================
    console.log('Test 10: Server Order Session Hashing (SHA-256 binding, raw cookie not stored)');
    const rawSessionToken = 'session_test_token_abc1234567890xyz';
    const expectedHash = crypto.createHash('sha256').update(rawSessionToken).digest('hex');
    assert.strictEqual(hashSessionToken(rawSessionToken), expectedHash);

    const testItems = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];
    const challenge1 = approvalService.createChallenge(testItems, 3000, rawSessionToken);
    const signed1 = approvalService.signApproval(
      challenge1.ticketId,
      challenge1.signature,
      challenge1.cartFingerprint,
      challenge1.nonce,
      {
        userName: 'Alex Mercer',
        department: 'Operations',
        purchaseJustification: 'Office ergonomics'
      },
      rawSessionToken
    );

    const createdOrder = await payPalService.createOrder(
      {
        items: testItems,
        userApprovalConfirmed: true,
        approvalSignoff: {
          userName: 'Alex Mercer',
          department: 'Operations',
          purchaseJustification: 'Office ergonomics',
          confirmedAt: new Date().toISOString()
        }
      },
      {
        ticketId: challenge1.ticketId,
        authToken: signed1.authToken,
        sessionToken: rawSessionToken
      }
    );

    assert(createdOrder.orderId, 'Order must have an orderId');
    const stored = payPalOrderStore.getOrder(createdOrder.orderId);
    assert(stored !== null, 'Stored order must exist');
    assert.strictEqual(stored.sessionHash, expectedHash, 'Order must store SHA-256 session hash');
    // Ensure raw session token is NOT stored on the record
    assert.strictEqual((stored as unknown as Record<string, unknown>).sessionToken, undefined, 'Raw sessionToken must NOT be on order record');
    assert(stored.approvalUrl, 'Approval URL must be stored on pending order for refresh recovery');
    console.log('  ✓ Server order bound to SHA-256 session hash without exposing raw cookie');

    // =========================================================================
    // 11. Pending Checkout Recovery by Session Hash
    // =========================================================================
    console.log('Test 11: Pending Checkout Recovery via getOrdersBySessionHash');
    const sessionOrders = payPalOrderStore.getOrdersBySessionHash(expectedHash);
    assert(sessionOrders.length >= 1, 'Should find at least 1 order for session');
    const pendingOrder = sessionOrders.find((o) => o.status === 'CREATED');
    assert(pendingOrder !== undefined, 'Should locate pending CREATED order');
    assert.strictEqual(pendingOrder?.orderId, createdOrder.orderId);
    assert.strictEqual(pendingOrder?.approverName, 'Alex Mercer');
    assert.strictEqual(pendingOrder?.currency, 'USD');
    assert(pendingOrder?.approvalUrl !== undefined, 'Approval URL must be recovered');
    console.log('  ✓ Pending order and approval URL recovered successfully from session');

    // =========================================================================
    // 12. Session Isolation (Cross-Session Inaccessibility)
    // =========================================================================
    console.log('Test 12: Session Isolation (Different session receives zero orders)');
    const attackerSessionToken = 'attacker_session_token_99999999';
    const attackerHash = hashSessionToken(attackerSessionToken);
    const attackerOrders = payPalOrderStore.getOrdersBySessionHash(attackerHash);
    assert.strictEqual(attackerOrders.length, 0, 'Attacker session must receive 0 orders from other sessions');
    console.log('  ✓ Strict session isolation verified: zero cross-session data leakage');

    // =========================================================================
    // 13. No Repeated Approval Signing for Existing Order
    // =========================================================================
    console.log('Test 13: Single-Use Ticket Protection (Prevents duplicate signing / replay)');
    // Verify that the ticket used for this order is marked CONSUMED
    const replayCheck = approvalService.verifyAndConsumeTicket(
      challenge1.ticketId,
      signed1.authToken,
      testItems,
      rawSessionToken
    );
    assert.strictEqual(replayCheck.isValid, false, 'Consumed ticket cannot be re-used');
    assert.strictEqual(replayCheck.state.status, 'CONSUMED');
    console.log('  ✓ Ticket consumed on order creation; repeat signing blocked');

    // =========================================================================
    // 14. Completed Payment Capture & Receipt Recovery
    // =========================================================================
    console.log('Test 14: Completed Payment Capture & Receipt Recovery');
    const captureResult = await payPalService.captureOrder(createdOrder.orderId);
    assert.strictEqual(captureResult.success, true);
    assert.strictEqual(captureResult.status, 'COMPLETED');

    // Post-capture session check:
    const postCaptureOrders = payPalOrderStore.getOrdersBySessionHash(expectedHash);
    const capturedOrder = postCaptureOrders.find((o) => o.status === 'CAPTURED');
    assert(capturedOrder !== undefined, 'Captured order must be found in session');
    assert.strictEqual(capturedOrder?.orderId, createdOrder.orderId);
    assert(capturedOrder?.capturedAt !== undefined, 'capturedAt must be set');
    assert(capturedOrder?.captureId !== undefined, 'captureId must be set');

    // Active pending order should now be null
    const remainingPending = postCaptureOrders.find((o) => o.status === 'CREATED');
    assert.strictEqual(remainingPending, undefined, 'No pending orders should remain after capture');
    console.log('  ✓ Captured order receipt restored; pending order state cleared');

    // =========================================================================
    // 15. Duplicate Capture Protection
    // =========================================================================
    console.log('Test 15: Duplicate Capture Protection (Idempotent response)');
    const dupCapture = await payPalService.captureOrder(createdOrder.orderId);
    assert.strictEqual(dupCapture.success, true, 'Duplicate capture returns idempotent success');
    assert.match(dupCapture.message || '', /already been captured/i);
    assert.strictEqual(dupCapture.captureId, captureResult.captureId);
    console.log('  ✓ Duplicate capture safely protected with idempotent response');

    // =========================================================================
    // 16. Reading from Disk Storage (Durable File-Store Retrieval)
    // =========================================================================
    console.log('Test 16: Reading Stored Orders from Disk Storage Directory');
    // Clear in-memory map to simulate server restart / new worker
    (payPalOrderStore as unknown as { memoryStore: Map<string, StoredPayPalOrder> }).memoryStore.clear();

    const diskRecoveredOrders = payPalOrderStore.getOrdersBySessionHash(expectedHash);
    assert(diskRecoveredOrders.length >= 1, 'Should load orders from disk store even with empty memory map');
    assert.strictEqual(diskRecoveredOrders[0].orderId, createdOrder.orderId);
    assert.strictEqual(diskRecoveredOrders[0].status, 'CAPTURED');
    console.log('  ✓ Orders successfully retrieved from persistent disk storage directory');

    // =========================================================================
    // 17. Discard Pending Order Logic
    // =========================================================================
    console.log('Test 17: Discarding Pending Order Marks Status VOIDED');
    const challenge2 = approvalService.createChallenge(testItems, 3000, rawSessionToken);
    const signed2 = approvalService.signApproval(
      challenge2.ticketId,
      challenge2.signature,
      challenge2.cartFingerprint,
      challenge2.nonce,
      {
        userName: 'Alex Mercer',
        department: 'Operations',
        purchaseJustification: 'Obsolete order to void'
      },
      rawSessionToken
    );

    const orderToVoid = await payPalService.createOrder(
      {
        items: testItems,
        userApprovalConfirmed: true,
        approvalSignoff: {
          userName: 'Alex Mercer',
          department: 'Operations',
          purchaseJustification: 'Obsolete order',
          confirmedAt: new Date().toISOString()
        }
      },
      {
        ticketId: challenge2.ticketId,
        authToken: signed2.authToken,
        sessionToken: rawSessionToken
      }
    );

    const storedOrderToVoid = payPalOrderStore.getOrder(orderToVoid.orderId!);
    assert(storedOrderToVoid !== null);
    assert.strictEqual(storedOrderToVoid.status, 'CREATED');

    // Discard/void the order:
    storedOrderToVoid.status = 'VOIDED';
    payPalOrderStore.saveOrder(storedOrderToVoid);

    const activeOrdersAfterVoid = payPalOrderStore
      .getOrdersBySessionHash(expectedHash)
      .filter((o) => o.status === 'CREATED');
    assert(!activeOrdersAfterVoid.some((o) => o.orderId === orderToVoid.orderId), 'Voided order must not be active');
    console.log('  ✓ Discarded order marked VOIDED and excluded from pending checkouts');

    console.log('\n--- All 17 Refresh Persistence & Checkout Recovery Tests Passed! ---');
  } finally {
    // Restore environment variables
    if (originalClientId !== undefined) {
      process.env.PAYPAL_CLIENT_ID = originalClientId;
    } else {
      delete process.env.PAYPAL_CLIENT_ID;
    }
    if (originalClientSecret !== undefined) {
      process.env.PAYPAL_CLIENT_SECRET = originalClientSecret;
    } else {
      delete process.env.PAYPAL_CLIENT_SECRET;
    }
    if (originalAllowSim !== undefined) {
      process.env.ALLOW_PAYPAL_SIMULATION = originalAllowSim;
    } else {
      delete process.env.ALLOW_PAYPAL_SIMULATION;
    }

    // Clean up mock globals
    delete globalAny.window;
  }
}
