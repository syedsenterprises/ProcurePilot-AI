import assert from 'node:assert';
import { payPalService } from '../../src/services/paypal/paypal.service';
import { approvalService } from '../../src/services/approval/approval.service';
import { setupTestIsolation, teardownTestIsolation } from '../test-isolation';

export async function runPayPalTests() {
  const needsLocalIsolation = !process.env.DATA_STORE_DIR;

  if (needsLocalIsolation) {
    setupTestIsolation();
  }

  try {
    console.log('\n--- Running PayPal Payment Integrity & Idempotency Tests ---');
  process.env.ALLOW_PAYPAL_SIMULATION = 'true';

  const items = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];

  // Setup valid approval challenge & sign it
  const challenge = approvalService.createChallenge(items, 3000, 'paypal-test-session');
  const signed = approvalService.signApproval(
    challenge.ticketId,
    challenge.signature,
    challenge.cartFingerprint,
    challenge.nonce,
    {
      userName: 'Alex Mercer',
      department: 'Finance',
      purchaseJustification: 'Hardware purchase'
    },
    'paypal-test-session'
  );

  // Test 1: Missing Authorization / Missing Ticket
  console.log('Test 1: Order Creation without Valid Authorization Ticket');
  const unauthOrder = await payPalService.createOrder(
    {
      items,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Finance',
        purchaseJustification: 'Purchase',
        confirmedAt: new Date().toISOString()
      }
    },
    undefined as unknown as { ticketId: string; authToken: string } // Missing security context
  );
  assert.strictEqual(unauthOrder.success, false);
  assert.match(unauthOrder.message || '', /Security Policy Violation/);
  console.log('  ✓ Missing ticket strictly blocked');

  // Test 2: Valid Order Creation with Consumed Ticket
  console.log('Test 2: Valid Order Creation with Ticket Consumption');
  const validOrder = await payPalService.createOrder(
    {
      items,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Finance',
        purchaseJustification: 'Hardware purchase',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: challenge.ticketId,
      authToken: signed.authToken,
      sessionToken: 'paypal-test-session'
    }
  );

  // In sandbox unconfigured mode, requiresManualReview is true, order is registered in local store
  assert.ok(validOrder.orderId, 'Order must return orderId');
  assert.strictEqual(validOrder.totalAmount?.value, '1401.84');
  console.log('  ✓ Order successfully created and registered with authoritative total');

  // Test 3: Duplicate Order Request (Replay Attack with Consumed Ticket)
  console.log('Test 3: Duplicate Order Request / Replay Attempt with Consumed Ticket');
  const replayOrder = await payPalService.createOrder(
    {
      items,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Finance',
        purchaseJustification: 'Hardware purchase',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: challenge.ticketId,
      authToken: signed.authToken,
      sessionToken: 'paypal-test-session'
    }
  );
  assert.strictEqual(replayOrder.success, false);
  assert.match(replayOrder.message || '', /Replay Blocked/);
  console.log('  ✓ Duplicate order creation replaying consumed ticket strictly blocked');

  // Test 4: Capture of Authoritative Stored Order
  console.log('Test 4: Capture of Authoritative Stored Order');
  const captureResult = await payPalService.captureOrder(validOrder.orderId!);
  assert.strictEqual(captureResult.success, true);
  assert.strictEqual(captureResult.status, 'COMPLETED');
  console.log('  ✓ First capture attempt completed successfully');

  // Test 5: Safe Duplicate Capture Handling (Idempotency)
  console.log('Test 5: Duplicate Capture Attempt Handling (Idempotency)');
  const duplicateCapture = await payPalService.captureOrder(validOrder.orderId!);
  assert.strictEqual(duplicateCapture.success, true);
  assert.strictEqual(duplicateCapture.status, 'COMPLETED');
  assert.match(duplicateCapture.message || '', /already been captured successfully/);
  console.log('  ✓ Duplicate capture handled safely and idempotently without errors');

  // Test 6: Capture of Non-Existent Unknown Order
  console.log('Test 6: Capture of Non-Existent Unknown Order');
  const unknownCapture = await payPalService.captureOrder('ORD_NON_EXISTENT_99999');
  assert.strictEqual(unknownCapture.success, false);
  assert.match(unknownCapture.message || '', /not found in authoritative order registry/);
  console.log('  ✓ Unknown order capture rejected');
  } finally {
    if (needsLocalIsolation) {
      teardownTestIsolation();
    }
  }
}

if (require.main === module) {
  runPayPalTests()
    .then(() => console.log('✅ ALL PAYPAL TESTS PASSED'))
    .catch((err) => {
      console.error('❌ PayPal test suite failed:', err);
      process.exit(1);
    });
}
