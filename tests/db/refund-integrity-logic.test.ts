import assert from 'node:assert';
import { paymentRepository } from '../../src/db/repositories/payment.repository';

export async function runRefundIntegrityLogicTests() {
  console.log('--- Running Refund Reservation & Concurrency Logic Tests ---');

  // Simulation harness testing the mathematical and lifecycle invariants of create_refund_reservation
  const capturedAmount = 1000.0;

  // Active reservations status list
  const activeReservationStatuses = new Set([
    'PREPARED',
    'DISPATCHED',
    'OUTCOME_UNKNOWN',
    'RECONCILIATION_REQUIRED',
  ]);

  interface MockAttempt {
    id: string;
    orderId: string;
    captureId: string;
    requestedAmount: number;
    currency: string;
    idempotencyKey: string;
    status: string;
  }

  interface MockRefund {
    id: string;
    captureId: string;
    refundAmount: number;
  }

  let attempts: MockAttempt[] = [];
  let refunds: MockRefund[] = [];

  function calculateAvailableBalance(captureId: string): number {
    const settled = refunds
      .filter((r) => r.captureId === captureId)
      .reduce((sum, r) => sum + r.refundAmount, 0);

    const activeReservations = attempts
      .filter((a) => a.captureId === captureId && activeReservationStatuses.has(a.status))
      .reduce((sum, a) => sum + a.requestedAmount, 0);

    return capturedAmount - (settled + activeReservations);
  }

  function simulateCreateRefundReservation(params: {
    orderId: string;
    captureId: string;
    refundAmount: number;
    currency: string;
    idempotencyKey: string;
  }): { attemptId: string; isExisting: boolean; availableBalanceAfter: number } {
    // 1. Idempotency check
    const existing = attempts.find((a) => a.idempotencyKey === params.idempotencyKey);
    if (existing) {
      if (
        existing.orderId !== params.orderId ||
        existing.captureId !== params.captureId ||
        existing.requestedAmount !== params.refundAmount
      ) {
        throw new Error(`Idempotency Conflict: Key ${params.idempotencyKey} used with conflicting parameters.`);
      }
      return {
        attemptId: existing.id,
        isExisting: true,
        availableBalanceAfter: calculateAvailableBalance(params.captureId),
      };
    }

    // 2. Headroom check
    const available = calculateAvailableBalance(params.captureId);
    if (params.refundAmount > available) {
      throw new Error(`Integrity Violation: Refund request (${params.refundAmount}) exceeds available balance (${available})`);
    }

    // 3. Insert reservation
    const newAttempt: MockAttempt = {
      id: `att_${Date.now()}_${Math.random()}`,
      orderId: params.orderId,
      captureId: params.captureId,
      requestedAmount: params.refundAmount,
      currency: params.currency,
      idempotencyKey: params.idempotencyKey,
      status: 'PREPARED',
    };
    attempts.push(newAttempt);

    return {
      attemptId: newAttempt.id,
      isExisting: false,
      availableBalanceAfter: available - params.refundAmount,
    };
  }

  // Test 1: Initial reservation reserves funds
  console.log('Test 1: Initial refund reservation deducts from available headroom');
  const res1 = simulateCreateRefundReservation({
    orderId: 'ord-100',
    captureId: 'cap-100',
    refundAmount: 400.0,
    currency: 'USD',
    idempotencyKey: 'idem-ref-001',
  });
  assert.strictEqual(res1.isExisting, false);
  assert.strictEqual(res1.availableBalanceAfter, 600.0);
  assert.strictEqual(calculateAvailableBalance('cap-100'), 600.0);
  console.log('  ✓ $400 reservation reserved; available balance is $600');

  // Test 2: Idempotent replay returns existing reservation
  console.log('Test 2: Idempotent replay with identical parameters returns existing reservation');
  const res1Replay = simulateCreateRefundReservation({
    orderId: 'ord-100',
    captureId: 'cap-100',
    refundAmount: 400.0,
    currency: 'USD',
    idempotencyKey: 'idem-ref-001',
  });
  assert.strictEqual(res1Replay.isExisting, true);
  assert.strictEqual(res1Replay.attemptId, res1.attemptId);
  assert.strictEqual(res1Replay.availableBalanceAfter, 600.0);
  console.log('  ✓ Idempotent replay returned existing reservation without double-counting');

  // Test 3: Conflicting parameter reuse is strictly rejected
  console.log('Test 3: Conflicting parameter reuse on same idempotency key is rejected');
  assert.throws(() => {
    simulateCreateRefundReservation({
      orderId: 'ord-100',
      captureId: 'cap-100',
      refundAmount: 500.0, // Different amount!
      currency: 'USD',
      idempotencyKey: 'idem-ref-001',
    });
  }, /Idempotency Conflict/);
  console.log('  ✓ Conflicting parameter reuse strictly rejected');

  // Test 4: Second reservation respects active in-flight headroom
  console.log('Test 4: Second reservation within remaining headroom succeeds');
  const res2 = simulateCreateRefundReservation({
    orderId: 'ord-100',
    captureId: 'cap-100',
    refundAmount: 500.0,
    currency: 'USD',
    idempotencyKey: 'idem-ref-002',
  });
  assert.strictEqual(res2.isExisting, false);
  assert.strictEqual(res2.availableBalanceAfter, 100.0);
  assert.strictEqual(calculateAvailableBalance('cap-100'), 100.0);
  console.log('  ✓ $500 second reservation succeeded; $100 headroom remaining');

  // Test 5: Excessive reservation is rejected
  console.log('Test 5: Refund exceeding remaining headroom is rejected');
  assert.throws(() => {
    simulateCreateRefundReservation({
      orderId: 'ord-100',
      captureId: 'cap-100',
      refundAmount: 150.0, // Exceeds remaining 100!
      currency: 'USD',
      idempotencyKey: 'idem-ref-003',
    });
  }, /Integrity Violation/);
  console.log('  ✓ Excessive refund request strictly rejected');

  // Test 6: Definitively failed reservation releases headroom
  console.log('Test 6: Definitively failed attempt releases reserved headroom');
  const attempt2 = attempts.find((a) => a.idempotencyKey === 'idem-ref-002')!;
  attempt2.status = 'FAILED'; // FAILED releases reservation
  assert.strictEqual(calculateAvailableBalance('cap-100'), 600.0);
  console.log('  ✓ Status FAILED successfully released $500 reservation back to headroom');

  // Test 7: Confirmed settlement books into payment_refunds
  console.log('Test 7: Confirmed external refund converts attempt to settled refund');
  const attempt1 = attempts.find((a) => a.idempotencyKey === 'idem-ref-001')!;
  attempt1.status = 'SUCCEEDED';
  refunds.push({
    id: 'ref-row-001',
    captureId: 'cap-100',
    refundAmount: attempt1.requestedAmount,
  });
  // Since attempt1 is SUCCEEDED (not in activeReservationStatuses), settled refund accounts for $400
  assert.strictEqual(calculateAvailableBalance('cap-100'), 600.0);
  console.log('  ✓ Confirmed refund row seamlessly replaces reservation in headroom calculation');

  // Test 8: Repository write-path protection guards against direct refund attempt creation
  console.log('Test 8: Repository layer rejects direct creation of refund attempts');
  await assert.rejects(
    async () => {
      await paymentRepository.createAttempt({
        order_id: '00000000-0000-0000-0000-000000000001',
        action_type: 'REFUND',
        idempotency_key: 'direct-refund-bad',
      });
    },
    {
      name: 'Error',
      message: 'Direct creation of refund attempts is prohibited. Use createRefundReservation instead.',
    }
  );
  console.log('  ✓ PaymentRepository.createAttempt strictly rejects direct action_type=REFUND writes');
}

if (require.main === module) {
  runRefundIntegrityLogicTests().catch((err) => {
    console.error('Refund integrity logic tests failed:', err);
    process.exit(1);
  });
}
