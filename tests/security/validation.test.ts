import assert from 'node:assert';
import {
  ProcurementRequestSchema,
  CartValidateRequestSchema,
  ApprovalChallengeRequestSchema,
  ApprovalSignRequestSchema,
  PayPalCreateOrderSchema,
  PayPalCaptureOrderSchema
} from '../../src/lib/validation/schemas';

export async function runValidationTests() {
  console.log('\n--- Running Zod Strict Schema Validation Tests ---');

  // Test 1: Procurement Request Validation
  console.log('Test 1: Procurement Request Strict Schema');
  const validProc = ProcurementRequestSchema.safeParse({
    query: 'Need 2 developer laptops',
    budgetLimit: 5000,
    department: 'Engineering'
  });
  assert.strictEqual(validProc.success, true);

  // Rejection of empty query
  const emptyQuery = ProcurementRequestSchema.safeParse({ query: '   ' });
  assert.strictEqual(emptyQuery.success, false);

  // Rejection of query > 1000 chars
  const longQuery = ProcurementRequestSchema.safeParse({ query: 'a'.repeat(1001) });
  assert.strictEqual(longQuery.success, false);

  // Rejection of negative budget
  const negativeBudget = ProcurementRequestSchema.safeParse({ query: 'Laptops', budgetLimit: -100 });
  assert.strictEqual(negativeBudget.success, false);

  // Rejection of unexpected fields (strictness)
  const unexpectedField = ProcurementRequestSchema.safeParse({
    query: 'Laptops',
    injectedField: 'malicious payload'
  });
  assert.strictEqual(unexpectedField.success, false);
  console.log('  ✓ Procurement schema strictly rejects invalid, oversized, or unexpected payloads');

  // Test 2: Cart Validation Schema
  console.log('Test 2: Cart Validation Strict Schema');
  const validCart = CartValidateRequestSchema.safeParse({
    items: [{ productId: 'prod-hm-aeron-01', quantity: 2 }],
    budgetCap: 4000
  });
  assert.strictEqual(validCart.success, true);

  // Invalid quantity (0 or negative)
  const zeroQty = CartValidateRequestSchema.safeParse({
    items: [{ productId: 'prod-hm-aeron-01', quantity: 0 }]
  });
  assert.strictEqual(zeroQty.success, false);

  // Invalid product ID with malicious characters
  const badId = CartValidateRequestSchema.safeParse({
    items: [{ productId: '../../../etc/passwd', quantity: 1 }]
  });
  assert.strictEqual(badId.success, false);
  console.log('  ✓ Cart schema strictly enforces positive quantities and safe IDs');

  // Test 3: Approval Challenge & Sign Schemas
  console.log('Test 3: Approval Challenge & Sign Schemas');
  const validChallenge = ApprovalChallengeRequestSchema.safeParse({
    items: [{ productId: 'prod-hm-aeron-01', quantity: 1 }],
    budgetCap: 2500
  });
  assert.strictEqual(validChallenge.success, true);

  const validSign = ApprovalSignRequestSchema.safeParse({
    ticketId: 'appr_tk_1234567890',
    cartFingerprint: 'a'.repeat(64),
    nonce: 'b'.repeat(64),
    signature: 'c'.repeat(64),
    signoff: {
      userName: 'Alex Mercer',
      department: 'Engineering',
      purchaseJustification: 'Workstation upgrade justification'
    }
  });
  assert.strictEqual(validSign.success, true);

  // Test 4: Currency Mismatch Rejection
  console.log('Test 4: Currency Mismatch Rejection');
  const currencyMismatch = PayPalCreateOrderSchema.safeParse({
    ticketId: 'appr_tk_1234567890',
    authToken: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    items: [{ productId: 'prod-hm-aeron-01', quantity: 1 }],
    approvalSignoff: {
      userName: 'Alex Mercer',
      department: 'DevOps',
      purchaseJustification: 'Valid justify'
    },
    currency: 'EUR' // Non-USD currency!
  });
  assert.strictEqual(currencyMismatch.success, false, 'Non-USD currency must be rejected');
  console.log('  ✓ Currency mismatch strictly rejected by schema');

  // Test 4: Capture Order ID Injection Protection
  console.log('Test 4: Capture Order ID Sanitization');
  const sqlInjectionOrderId = PayPalCaptureOrderSchema.safeParse({
    orderId: "'; DROP TABLE orders; --"
  });
  assert.strictEqual(sqlInjectionOrderId.success, false, 'Injection string in orderId must be rejected');

  const validOrderId = PayPalCaptureOrderSchema.safeParse({
    orderId: '5O190127TN364715T'
  });
  assert.strictEqual(validOrderId.success, true);
  console.log('  ✓ Capture order schema strictly validates format and blocks injection attempts');
}
