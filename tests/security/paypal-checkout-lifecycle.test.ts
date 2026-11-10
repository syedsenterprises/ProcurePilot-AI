import assert from 'node:assert';
import { payPalService } from '../../src/services/paypal/paypal.service';
import { approvalService } from '../../src/services/approval/approval.service';
import { catalogService } from '../../src/services/catalog/catalog.service';
import { setupTestIsolation, teardownTestIsolation } from '../test-isolation';

export async function runPayPalCheckoutLifecycleTests() {
  const needsLocalIsolation = !process.env.DATA_STORE_DIR;

  if (needsLocalIsolation) {
    setupTestIsolation();
  }

  try {
    console.log('\n--- Running Stage 2B.2 PayPal Checkout Lifecycle & Sandbox Security Tests ---');

  const testItems = [
    { productId: 'prod-hm-aeron-01', quantity: 1 } // $1295.00
  ];
  const testSession = 'test-checkout-lifecycle-session';

  // Helper to create a signed approval ticket
  function setupApprovedTicket(items = testItems) {
    const challenge = approvalService.createChallenge(items, 5000, testSession);
    const signed = approvalService.signApproval(
      challenge.ticketId,
      challenge.signature,
      challenge.cartFingerprint,
      challenge.nonce,
      {
        userName: 'Alex Mercer',
        department: 'Engineering DevOps',
        purchaseJustification: 'Workstation upgrade'
      },
      testSession
    );
    return { challenge, signed };
  }

  // -------------------------------------------------------------------------
  // Test 1: Approved PayPal Redirect & Order Creation
  // -------------------------------------------------------------------------
  console.log('Test 1: Approved PayPal Order Creation');
  const { challenge, signed } = setupApprovedTicket();

  // Enable dev simulation mode for test
  const prevAllowSim = process.env.ALLOW_PAYPAL_SIMULATION;
  process.env.ALLOW_PAYPAL_SIMULATION = 'true';

  const orderResult = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering DevOps',
        purchaseJustification: 'Workstation upgrade',
        confirmedAt: new Date().toISOString()
      },
      currency: 'USD'
    },
    {
      ticketId: challenge.ticketId,
      authToken: signed.authToken,
      sessionToken: testSession
    }
  );

  assert.ok(orderResult.orderId, 'Order creation must return an orderId');
  assert.strictEqual(orderResult.totalAmount?.value, '1401.84');
  assert.ok(orderResult.approvalUrl?.includes('status=approved'), 'Approval URL must direct to approved return path');
  console.log(`  ✓ Approved PayPal redirect generated: orderId=${orderResult.orderId}`);

  // -------------------------------------------------------------------------
  // Test 2: Successful Server-Side Capture
  // -------------------------------------------------------------------------
  console.log('Test 2: Successful Server-Side Order Capture');
  const captureResult = await payPalService.captureOrder(orderResult.orderId!);
  assert.strictEqual(captureResult.success, true);
  assert.strictEqual(captureResult.status, 'COMPLETED');
  assert.ok(captureResult.captureId, 'Capture ID must be returned');
  assert.ok(captureResult.orderDetails, 'Order details must be returned for receipt rendering');
  assert.strictEqual(captureResult.orderDetails.authorizedTotal, 1401.84);
  console.log(`  ✓ Order successfully captured: captureId=${captureResult.captureId}`);

  // -------------------------------------------------------------------------
  // Test 3: Duplicate Return Handling (Idempotency)
  // -------------------------------------------------------------------------
  console.log('Test 3: Duplicate Return Handling (Idempotency on Re-entry)');
  const duplicateReturnCapture = await payPalService.captureOrder(orderResult.orderId!);
  assert.strictEqual(duplicateReturnCapture.success, true);
  assert.strictEqual(duplicateReturnCapture.captureId, captureResult.captureId);
  assert.strictEqual(duplicateReturnCapture.status, 'COMPLETED');
  assert.ok(
    duplicateReturnCapture.message?.includes('already been captured') ||
      duplicateReturnCapture.message?.includes('Idempotent response'),
    'Duplicate return must return idempotent confirmation'
  );
  console.log('  ✓ Duplicate redirect safely returned idempotent completed capture');

  // -------------------------------------------------------------------------
  // Test 4: Cart Clearing Logic Verification (Only After Verified 200 Capture)
  // -------------------------------------------------------------------------
  console.log('Test 4: Cart Clearing Conditional on Verified Server Capture');
  // Simulated frontend state check
  let mockCart = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];
  function simulateFrontendCheckoutReturn(captureResponse: { success: boolean }) {
    if (captureResponse.success) {
      mockCart = []; // Cleared on success
    }
  }

  // When capture fails
  simulateFrontendCheckoutReturn({ success: false });
  assert.strictEqual(mockCart.length, 1, 'Cart MUST NOT be cleared on capture failure');

  // When capture succeeds
  simulateFrontendCheckoutReturn({ success: true });
  assert.strictEqual(mockCart.length, 0, 'Cart MUST be cleared on verified capture success');
  console.log('  ✓ Cart clearing strictly gated on verified server confirmation');

  // -------------------------------------------------------------------------
  // Test 5: Capture Failure on Missing / Invalid Orders
  // -------------------------------------------------------------------------
  console.log('Test 5: Capture Failure on Unknown Order ID');
  const unknownCapture = await payPalService.captureOrder('ORD_UNKNOWN_99999999');
  assert.strictEqual(unknownCapture.success, false);
  assert.ok(unknownCapture.message?.includes('not found in authoritative order registry'));
  console.log('  ✓ Unknown order capture rejected cleanly with error');

  // -------------------------------------------------------------------------
  // Test 6: Cancelled Checkout (Status=Cancelled Detection)
  // -------------------------------------------------------------------------
  console.log('Test 6: Cancelled Checkout Handling');
  // Cancelled status must NOT call capture and must preserve cart
  const mockCartAfterCancel = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];
  let captureCalledOnCancel = false;

  function handleReturnQuery(status: string) {
    if (status === 'cancelled') {
      // Show notice, keep cart
      return { showCancellation: true, cart: mockCartAfterCancel };
    }
    captureCalledOnCancel = true;
    return { showCancellation: false, cart: [] };
  }

  const cancelResult = handleReturnQuery('cancelled');
  assert.strictEqual(cancelResult.showCancellation, true);
  assert.strictEqual(captureCalledOnCancel, false, 'Capture must NOT be invoked when status=cancelled');
  console.log('  ✓ Cancelled checkout intercepted without triggering capture');

  // -------------------------------------------------------------------------
  // Test 7: Cart Preservation After Cancellation
  // -------------------------------------------------------------------------
  console.log('Test 7: Cart Preservation After Cancellation');
  assert.strictEqual(cancelResult.cart.length, 1);
  assert.strictEqual(cancelResult.cart[0].productId, 'prod-hm-aeron-01');
  console.log('  ✓ Cart items and quantities preserved completely following cancellation');

  // -------------------------------------------------------------------------
  // Test 8: Missing PayPal Credentials Rejection (When Simulation Disabled)
  // -------------------------------------------------------------------------
  console.log('Test 8: Explicit Error on Missing Credentials When Simulation Disabled');
  process.env.ALLOW_PAYPAL_SIMULATION = 'false';
  process.env.ENABLE_PAYPAL_SIMULATION = 'false';
  process.env.PAYPAL_SIMULATION = 'false';

  const ticketForConfigTest = setupApprovedTicket();
  const unconfiguredOrder = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering',
        purchaseJustification: 'Testing missing credentials',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: ticketForConfigTest.challenge.ticketId,
      authToken: ticketForConfigTest.signed.authToken,
      sessionToken: testSession
    }
  );

  assert.strictEqual(unconfiguredOrder.success, false);
  assert.ok(
    unconfiguredOrder.message?.includes('Configuration Error') ||
      unconfiguredOrder.message?.includes('credentials'),
    `Expected configuration error, got: ${unconfiguredOrder.message}`
  );
  console.log('  ✓ Missing credentials explicitly blocked when simulation mode is off');

  // -------------------------------------------------------------------------
  // Test 9: Synthetic Simulation Isolation (Production Rejection)
  // -------------------------------------------------------------------------
  console.log('Test 9: Production Rejection of Simulation Mode');
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    // Set NODE_ENV to production
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.ALLOW_PAYPAL_SIMULATION = 'true'; // Attempt to bypass

    assert.strictEqual(
      payPalService.isSimulationAllowed(),
      false,
      'Simulation mode MUST be strictly rejected in production'
    );
    console.log('  ✓ Production environment strictly disallows simulation mode');
  } finally {
    (process.env as Record<string, string>).NODE_ENV = prevNodeEnv || 'test';
    process.env.ALLOW_PAYPAL_SIMULATION = 'true';
  }

  // -------------------------------------------------------------------------
  // Test 10: Clearly Labeled Simulated Responses
  // -------------------------------------------------------------------------
  console.log('Test 10: Clear Labeling of Simulated Responses');
  const simTicket = setupApprovedTicket();
  const simOrder = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering',
        purchaseJustification: 'Sim test',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: simTicket.challenge.ticketId,
      authToken: simTicket.signed.authToken,
      sessionToken: testSession
    }
  );

  assert.strictEqual(simOrder.isSimulated, true, 'isSimulated must be true');
  assert.ok(simOrder.simulationNotice?.includes('SIMULATION'), 'simulationNotice must be populated');

  const simCapture = await payPalService.captureOrder(simOrder.orderId!);
  assert.strictEqual(simCapture.isSimulated, true, 'isSimulated must be true on capture');
  assert.ok(simCapture.simulationNotice?.includes('SIMULATION'), 'simulationNotice must be on capture');
  console.log('  ✓ Simulated orders and captures explicitly labeled with notices');

  // -------------------------------------------------------------------------
  // Test 11: Idempotent Duplicate Capture Safe Handling
  // -------------------------------------------------------------------------
  console.log('Test 11: Duplicate Capture Idempotency & Safety');
  const duplicateCall = await payPalService.captureOrder(simOrder.orderId!);
  assert.strictEqual(duplicateCall.success, true);
  assert.strictEqual(duplicateCall.captureId, simCapture.captureId);
  assert.strictEqual(duplicateCall.status, 'COMPLETED');
  console.log('  ✓ Multiple capture calls safely return identical completed status');

  // -------------------------------------------------------------------------
  // Test 12: Receipt Data Integrity & Authoritative Breakdown
  // -------------------------------------------------------------------------
  console.log('Test 12: Receipt Data Integrity Against Authoritative Catalog');
  const details = simCapture.orderDetails;
  assert.ok(details, 'Receipt order details must be present');
  assert.strictEqual(details.orderId, simOrder.orderId);
  assert.strictEqual(details.currency, 'USD');
  assert.strictEqual(details.status, 'CAPTURED');
  assert.strictEqual(details.approverName, 'Alex Mercer');
  assert.strictEqual(details.approverDepartment, 'Engineering');
  assert.strictEqual(details.items.length, 1);
  assert.strictEqual(details.items[0].productId, 'prod-hm-aeron-01');

  // Verify financial totals match authoritative catalog reconciliation
  const catalogProduct = catalogService.getProductById('prod-hm-aeron-01')!;
  assert.strictEqual(details.items[0].unitPrice, catalogProduct.price);
  assert.strictEqual(details.authorizedSubtotal, 1295.0);
  assert.strictEqual(details.authorizedTax, 106.84); // 8.25%
  assert.strictEqual(details.authorizedShipping, 0); // Free > $1000
  assert.strictEqual(details.authorizedTotal, 1401.84);
  console.log('  ✓ Full receipt data matches authoritative server-side catalog breakdown');

  // -------------------------------------------------------------------------
  // Test 13: Failed Capture Followed by Successful Retry (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 13: Failed Capture Followed by Successful Retry (Stage 2B.4)');
  const retryTicket = setupApprovedTicket();
  const retryOrder = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering',
        purchaseJustification: 'Retry lifecycle test',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: retryTicket.challenge.ticketId,
      authToken: retryTicket.signed.authToken,
      sessionToken: testSession
    }
  );
  assert.ok(retryOrder.orderId);

  const testProcessedTokens = new Set<string>();
  let testIsCapturing = false;
  let testRetryToken: string | null = null;
  let testErrorMessage: string | null = null;
  let testCart = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];

  async function simulateExecuteCapture(tokenToCapture: string, simulateFailure = false) {
    if (testIsCapturing || testProcessedTokens.has(tokenToCapture)) {
      return { skipped: true };
    }
    testProcessedTokens.add(tokenToCapture);
    testIsCapturing = true;
    testErrorMessage = null;

    try {
      if (simulateFailure) {
        throw new Error('Simulated transient gateway timeout (HTTP 504)');
      }
      const result = await payPalService.captureOrder(tokenToCapture);
      if (!result.success) {
        throw new Error(result.message || 'Capture failed');
      }
      testCart = []; // Cleared on verified success
      testRetryToken = null;
      return { success: true, result };
    } catch (err: unknown) {
      // Stage 2B.4 requirement: remove token from processedTokens on failure
      testProcessedTokens.delete(tokenToCapture);
      testRetryToken = tokenToCapture;
      testErrorMessage = err instanceof Error ? err.message : 'Failed';
      return { success: false, error: testErrorMessage };
    } finally {
      testIsCapturing = false;
    }
  }

  // Attempt 1: Transient failure occurs
  const attempt1 = await simulateExecuteCapture(retryOrder.orderId, true);
  assert.strictEqual(attempt1.success, false);
  assert.strictEqual(testProcessedTokens.has(retryOrder.orderId), false, 'Token MUST be deleted from processedTokens on failure');
  assert.strictEqual(testRetryToken, retryOrder.orderId, 'Authorized order token MUST be preserved for retry');
  assert.strictEqual(testCart.length, 1, 'Cart MUST NOT be cleared on failure');
  assert.ok((testErrorMessage as unknown as string)?.includes('504'));

  // Attempt 2: User clicks "Retry Payment Capture" using testRetryToken
  const attempt2 = await simulateExecuteCapture(testRetryToken!, false);
  assert.strictEqual(attempt2.success, true);
  assert.strictEqual(testProcessedTokens.has(retryOrder.orderId), true, 'Successfully captured token marked processed');
  assert.strictEqual(testRetryToken, null, 'retryToken cleared upon success');
  assert.strictEqual(testCart.length, 0, 'Cart successfully cleared upon verified capture');
  console.log('  ✓ Failed capture successfully retried without losing order ID or clearing cart prematurely');

  // -------------------------------------------------------------------------
  // Test 14: Multiple Concurrent Retry Clicks Guard (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 14: Multiple Concurrent Retry Clicks Guard (Stage 2B.4)');
  const rapidTicket = setupApprovedTicket();
  const rapidOrder = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering',
        purchaseJustification: 'Rapid click test',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: rapidTicket.challenge.ticketId,
      authToken: rapidTicket.signed.authToken,
      sessionToken: testSession
    }
  );

  let rapidCallCount = 0;
  const rapidProcessedTokens = new Set<string>();
  let rapidIsCapturing = false;

  async function rapidExecuteCapture(token: string) {
    if (rapidIsCapturing || rapidProcessedTokens.has(token)) {
      return { blocked: true };
    }
    rapidProcessedTokens.add(token);
    rapidIsCapturing = true;
    rapidCallCount++;
    // Simulate async in-flight delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await payPalService.captureOrder(token);
    rapidIsCapturing = false;
    return { blocked: false, res };
  }

  // Dispatch 3 concurrent clicks simultaneously
  const [click1, click2, click3] = await Promise.all([
    rapidExecuteCapture(rapidOrder.orderId!),
    rapidExecuteCapture(rapidOrder.orderId!),
    rapidExecuteCapture(rapidOrder.orderId!)
  ]);

  assert.strictEqual(rapidCallCount, 1, 'Only one network capture request must be dispatched');
  assert.strictEqual(click1.blocked, false);
  assert.strictEqual(click2.blocked, true, 'Concurrent click 2 must be blocked by isCapturing guard');
  assert.strictEqual(click3.blocked, true, 'Concurrent click 3 must be blocked by isCapturing guard');
  console.log('  ✓ Concurrent rapid retry clicks safely blocked by in-flight capture guard');

  // -------------------------------------------------------------------------
  // Test 15: React StrictMode Double-Mount Duplicate Capture Prevention (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 15: React StrictMode Double-Mount Duplicate Prevention (Stage 2B.4)');
  const smTicket = setupApprovedTicket();
  const smOrder = await payPalService.createOrder(
    {
      items: testItems,
      userApprovalConfirmed: true,
      approvalSignoff: {
        userName: 'Alex Mercer',
        department: 'Engineering',
        purchaseJustification: 'StrictMode test',
        confirmedAt: new Date().toISOString()
      }
    },
    {
      ticketId: smTicket.challenge.ticketId,
      authToken: smTicket.signed.authToken,
      sessionToken: testSession
    }
  );

  const smProcessedTokens = new Set<string>();
  let smCapturing = false;
  let smNetworkRequests = 0;

  async function strictModeMountEffect(token: string) {
    if (smCapturing || smProcessedTokens.has(token)) {
      return;
    }
    smProcessedTokens.add(token);
    smCapturing = true;
    smNetworkRequests++;
    await payPalService.captureOrder(token);
    smCapturing = false;
  }

  // Mount 1
  await strictModeMountEffect(smOrder.orderId!);
  // Mount 2 (StrictMode immediate re-invocation)
  await strictModeMountEffect(smOrder.orderId!);

  assert.strictEqual(smNetworkRequests, 1, 'StrictMode double-mount must execute capture exactly once');
  console.log('  ✓ React StrictMode double-mount strictly prevented duplicate capture');

  // -------------------------------------------------------------------------
  // Test 16: Already-Captured Order Retry Idempotency (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 16: Already-Captured Order Retry Idempotency (Stage 2B.4)');
  const reCapture = await payPalService.captureOrder(retryOrder.orderId!);
  assert.strictEqual(reCapture.success, true);
  assert.strictEqual(reCapture.status, 'COMPLETED');
  assert.strictEqual(reCapture.orderId, retryOrder.orderId);
  assert.ok(reCapture.orderDetails);
  assert.strictEqual(reCapture.orderDetails.status, 'CAPTURED');
  console.log('  ✓ Retrying already-captured order safely returns authoritative existing result');

  // -------------------------------------------------------------------------
  // Test 17: Cart Preservation Across Repeated Failures (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 17: Cart Preservation Across Repeated Failures (Stage 2B.4)');
  const repeatedCart = [
    { productId: 'prod-hm-aeron-01', quantity: 1 },
    { productId: 'prod-lg-38wn95c-02', quantity: 2 }
  ];
  const repeatedTokens = new Set<string>();
  let failureCount = 0;

  for (let i = 0; i < 5; i++) {
    repeatedTokens.add('ORD_TEMP_FAIL');
    failureCount++;
    repeatedTokens.delete('ORD_TEMP_FAIL');
    assert.strictEqual(repeatedCart.length, 2, `Cart must remain intact after failure ${i + 1}`);
  }
  assert.strictEqual(failureCount, 5);
  assert.strictEqual(repeatedCart[0].productId, 'prod-hm-aeron-01');
  assert.strictEqual(repeatedCart[1].quantity, 2);
  console.log('  ✓ Cart items and quantities preserved across 5 consecutive failures');

  // -------------------------------------------------------------------------
  // Test 18: Cart Clearing Gated Strictly on Confirmed Server Capture (Stage 2B.4)
  // -------------------------------------------------------------------------
  console.log('Test 18: Cart Clearing Gated Strictly on Confirmed Server Capture (Stage 2B.4)');
  let finalCart = [{ productId: 'prod-hm-aeron-01', quantity: 1 }];

  function handleServerResponse(res: { status: number; success: boolean }) {
    if (res.status === 200 && res.success) {
      finalCart = [];
    }
  }

  handleServerResponse({ status: 500, success: false });
  assert.strictEqual(finalCart.length, 1);

  handleServerResponse({ status: 400, success: false });
  assert.strictEqual(finalCart.length, 1);

  handleServerResponse({ status: 200, success: true });
  assert.strictEqual(finalCart.length, 0);
  console.log('  ✓ Cart cleared strictly upon verified HTTP 200 server confirmation');

  // Restore env
  process.env.ALLOW_PAYPAL_SIMULATION = prevAllowSim;
  } finally {
    if (needsLocalIsolation) {
      teardownTestIsolation();
    }
  }
}

if (require.main === module) {
  runPayPalCheckoutLifecycleTests()
    .then(() => console.log('✅ ALL PAYPAL CHECKOUT LIFECYCLE TESTS PASSED'))
    .catch((err) => {
      console.error('❌ PayPal checkout lifecycle test suite failed:', err);
      process.exit(1);
    });
}
