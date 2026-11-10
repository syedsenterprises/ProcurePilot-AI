import assert from 'node:assert';
import { approvalService } from '../../src/services/approval/approval.service';
import { setupTestIsolation, teardownTestIsolation } from '../test-isolation';

export async function runApprovalTests() {
  const needsLocalIsolation = !process.env.DATA_STORE_DIR;

  if (needsLocalIsolation) {
    setupTestIsolation();
  }

  try {
    console.log('\n--- Running Approval Security & Anti-Tampering Tests ---');

  const sampleItems = [
    { productId: 'prod-hm-aeron-01', quantity: 1 },
    { productId: 'prod-jarvis-desk-60', quantity: 1 }
  ];

  // Test 1: Challenge generation and HMAC signature verification
  console.log('Test 1: Challenge Generation & HMAC Signature Integrity');
  const challenge = approvalService.createChallenge(sampleItems, 5000, 'test-session-123');
  assert.ok(challenge.ticketId.startsWith('appr_tk_'), 'Ticket ID must start with appr_tk_');
  assert.ok(challenge.signature.length === 64, 'Signature must be 64-char HMAC-SHA256 hex');
  assert.strictEqual(challenge.currency, 'USD');
  assert.ok(challenge.verifiedTotal > 0, 'Total must be positive');

  // Verify signature math matches
  const expectedSig = approvalService.signChallenge(
    challenge.ticketId,
    challenge.cartFingerprint,
    challenge.nonce,
    challenge.expiresAt
  );
  assert.strictEqual(challenge.signature, expectedSig, 'Challenge signature must match cryptographic HMAC');
  console.log('  ✓ Challenge created and verified');

  // Test 2: Invalid HMAC Signature Rejection
  console.log('Test 2: Tampered HMAC Signature Rejection');
  assert.throws(
    () => {
      approvalService.signApproval(
        challenge.ticketId,
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        challenge.cartFingerprint,
        challenge.nonce,
        {
          userName: 'Alex Mercer',
          department: 'Engineering',
          purchaseJustification: 'Valid upgrade'
        },
        'test-session-123'
      );
    },
    /Invalid cryptographic challenge signature/,
    'Tampered HMAC signature must be rejected'
  );
  console.log('  ✓ Tampered HMAC signature correctly rejected');

  // Test 3: Valid Signing
  console.log('Test 3: Valid Approval Signing');
  const signed = approvalService.signApproval(
    challenge.ticketId,
    challenge.signature,
    challenge.cartFingerprint,
    challenge.nonce,
    {
      userName: 'Alex Mercer',
      department: 'Engineering',
      purchaseJustification: 'Workstation renewal'
    },
    'test-session-123'
  );
  assert.strictEqual(signed.success, true);
  assert.ok(signed.authToken.length === 64, 'Auth token must be 64-char HMAC hex');
  console.log('  ✓ Ticket successfully signed with auth token');

  // Test 4: Single-Use Consumption & Replay Prevention
  console.log('Test 4: Single-Use Ticket Consumption & Replay Prevention');
  const firstConsumption = approvalService.verifyAndConsumeTicket(
    challenge.ticketId,
    signed.authToken,
    sampleItems,
    'test-session-123'
  );
  assert.strictEqual(firstConsumption.isValid, true, 'First consumption must succeed');
  assert.strictEqual(firstConsumption.state.status, 'CONSUMED');

  // Replay attempt with same ticket and auth token
  const replayAttempt = approvalService.verifyAndConsumeTicket(
    challenge.ticketId,
    signed.authToken,
    sampleItems,
    'test-session-123'
  );
  assert.strictEqual(replayAttempt.isValid, false, 'Replay attempt must be rejected');
  assert.match(replayAttempt.error || '', /Replay Blocked/, 'Error must indicate replay attempt was blocked');
  console.log('  ✓ Ticket consumed on first use; replay attempt strictly blocked');

  // Test 5: Cart Tampering Detection (Altered Product ID)
  console.log('Test 5: Cart Tampering (Product ID Swapping)');
  const challenge2 = approvalService.createChallenge(sampleItems, 5000, 'test-session-456');
  const signed2 = approvalService.signApproval(
    challenge2.ticketId,
    challenge2.signature,
    challenge2.cartFingerprint,
    challenge2.nonce,
    {
      userName: 'Alex Mercer',
      department: 'Engineering',
      purchaseJustification: 'Justification'
    },
    'test-session-456'
  );

  const tamperedItems = [
    { productId: 'prod-hm-aeron-01', quantity: 1 },
    { productId: 'prod-apple-mbp-16', quantity: 1 } // Swapped product!
  ];
  const tamperResult = approvalService.verifyAndConsumeTicket(
    challenge2.ticketId,
    signed2.authToken,
    tamperedItems,
    'test-session-456'
  );
  assert.strictEqual(tamperResult.isValid, false);
  assert.match(tamperResult.error || '', /Cart Tampering Detected/, 'Must detect altered products');
  console.log('  ✓ Altered product ID tampering detected and blocked');

  // Test 6: Quantity Manipulation Detection
  console.log('Test 6: Quantity Manipulation Detection');
  const manipulatedQty = [
    { productId: 'prod-hm-aeron-01', quantity: 1 },
    { productId: 'prod-jarvis-desk-60', quantity: 5 } // Increased quantity from 1 to 5
  ];
  const qtyResult = approvalService.verifyAndConsumeTicket(
    challenge2.ticketId,
    signed2.authToken,
    manipulatedQty,
    'test-session-456'
  );
  assert.strictEqual(qtyResult.isValid, false);
  assert.match(qtyResult.error || '', /does not match approved quantity/, 'Must detect manipulated quantity');
  console.log('  ✓ Quantity manipulation detected and blocked');

  // Test 7: Ticket Expiration Enforcement
  console.log('Test 7: Ticket Expiration Enforcement (10-minute TTL)');
  const expiredChallenge = approvalService.createChallenge(sampleItems, 5000, 'test-session-789');
  // Mutate expiresAt to simulate passage of 11 minutes
  const rawState = approvalService.getChallenge(expiredChallenge.ticketId)!;
  rawState.expiresAt = Date.now() - 60 * 1000; // expired 1 minute ago

  assert.throws(
    () => {
      approvalService.signApproval(
        expiredChallenge.ticketId,
        expiredChallenge.signature,
        expiredChallenge.cartFingerprint,
        expiredChallenge.nonce,
        {
          userName: 'Alex Mercer',
          department: 'Engineering',
          purchaseJustification: 'Expired sign'
        },
        'test-session-789'
      );
    },
    /Approval challenge has expired/,
    'Signing expired challenge must throw'
  );
  console.log('  ✓ Expired challenge rejected cleanly');

  // Test 8: Session Mismatch / CSRF Violation
  console.log('Test 8: Session Mismatch / Cross-Session Violation');
  const sessionChallenge = approvalService.createChallenge(sampleItems, 5000, 'victim-session-abc');
  assert.throws(
    () => {
      approvalService.signApproval(
        sessionChallenge.ticketId,
        sessionChallenge.signature,
        sessionChallenge.cartFingerprint,
        sessionChallenge.nonce,
        {
          userName: 'Attacker',
          department: 'Unknown',
          purchaseJustification: 'Unauthorized hijack'
        },
        'attacker-session-xyz' // Different session!
      );
    },
    /session mismatch/,
    'Session mismatch must be rejected'
  );
  console.log('  ✓ Session hijacking attempt rejected');

  // Test 9: Runtime approval with missing session token fails closed
  console.log('Test 9: Runtime approval with missing session token fails closed');
  const missingSessionChallenge = approvalService.createChallenge(sampleItems, 5000, 'valid-session-123');
  // Attempt signing with omitted/undefined session token
  assert.throws(
    () => {
      approvalService.signApproval(
        missingSessionChallenge.ticketId,
        missingSessionChallenge.signature,
        missingSessionChallenge.cartFingerprint,
        missingSessionChallenge.nonce,
        {
          userName: 'Alex Mercer',
          department: 'Engineering',
          purchaseJustification: 'Missing token sign'
        },
        undefined // Missing incoming token!
      );
    },
    /Active session token is required to sign approval challenge/,
    'Signing without active session token must fail closed'
  );

  // Sign properly first
  const signedValid = approvalService.signApproval(
    missingSessionChallenge.ticketId,
    missingSessionChallenge.signature,
    missingSessionChallenge.cartFingerprint,
    missingSessionChallenge.nonce,
    {
      userName: 'Alex Mercer',
      department: 'Engineering',
      purchaseJustification: 'Proper sign'
    },
    'valid-session-123'
  );

  // Attempt consumption without session token
  const consumeWithoutSession = approvalService.verifyAndConsumeTicket(
    missingSessionChallenge.ticketId,
    signedValid.authToken,
    sampleItems,
    undefined // Missing session token!
  );
  assert.strictEqual(consumeWithoutSession.isValid, false);
  assert.match(consumeWithoutSession.error || '', /Active session token is required for checkout/);
  console.log('  ✓ Missing session token strictly fails closed for signing and consumption');

  // Test 10: SHA-256 hash placed in sessionToken is rejected
  console.log('Test 10: SHA-256 hash placed in sessionToken is rejected');
  const hashChallenge = approvalService.createChallenge(sampleItems, 5000, 'valid-session-hash-test');
  const hashString = 'a'.repeat(64); // 64-hex SHA-256 hash
  assert.throws(
    () => {
      approvalService.signApproval(
        hashChallenge.ticketId,
        hashChallenge.signature,
        hashChallenge.cartFingerprint,
        hashChallenge.nonce,
        {
          userName: 'Attacker',
          department: 'Engineering',
          purchaseJustification: 'Hash injection'
        },
        hashString
      );
    },
    /Session hash cannot be used as a plaintext session token/,
    'SHA-256 hash passed as sessionToken must be rejected'
  );
  console.log('  ✓ SHA-256 hash in sessionToken strictly rejected');

  // Test 11: Reauthentication-required recovery state cannot authorize checkout
  console.log('Test 11: Reauthentication-required recovery state cannot authorize checkout');
  const recoveryChallenge = approvalService.createChallenge(sampleItems, 5000, 'orig-token-999');
  const rawRecoveryState = approvalService.getChallenge(recoveryChallenge.ticketId)!;
  rawRecoveryState.sessionToken = undefined; // Simulate exported recovery state with absent plaintext token

  assert.throws(
    () => {
      approvalService.signApproval(
        recoveryChallenge.ticketId,
        recoveryChallenge.signature,
        recoveryChallenge.cartFingerprint,
        recoveryChallenge.nonce,
        {
          userName: 'Alex Mercer',
          department: 'Engineering',
          purchaseJustification: 'Recovery sign'
        },
        'any-incoming-token'
      );
    },
    /Approval ticket is missing required session binding. Reauthentication or challenge regeneration required/,
    'Ticket missing session binding must require reauthentication'
  );

  // Also verify consumption fails closed
  rawRecoveryState.status = 'APPROVED';
  rawRecoveryState.signoff = {
    userName: 'Alex Mercer',
    department: 'Engineering',
    purchaseJustification: 'Recovery sign',
    signedAt: new Date().toISOString(),
    identityTier: 'SELF_ATTESTED_REQUISITIONER'
  };
  const dummyAuthToken = approvalService.signAuthToken(
    recoveryChallenge.ticketId,
    rawRecoveryState.cartFingerprint,
    rawRecoveryState.nonce,
    rawRecoveryState.expiresAt
  );
  const recoveryConsumeResult = approvalService.verifyAndConsumeTicket(
    recoveryChallenge.ticketId,
    dummyAuthToken,
    sampleItems,
    'any-incoming-token'
  );
  assert.strictEqual(recoveryConsumeResult.isValid, false);
  assert.match(recoveryConsumeResult.error || '', /Approval ticket is missing required session binding. Reauthentication required/);
  console.log('  ✓ Reauthentication-required state strictly fails closed for both signing and consumption');

  // Test 12: Missing HMAC secret fails closed
  console.log('Test 12: ApprovalService throws when both APPROVAL_SECRET and NEXTAUTH_SECRET are absent');
  const origAppr = process.env.APPROVAL_SECRET;
  const origNext = process.env.NEXTAUTH_SECRET;
  try {
    delete process.env.APPROVAL_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    assert.throws(
      () => approvalService.signChallenge('tk1', 'fp1', 'nonce1', Date.now()),
      /Cryptographic configuration error: Approval HMAC secret is missing or empty/,
      'Must throw when both secrets are absent'
    );
    assert.throws(
      () => approvalService.createChallenge(sampleItems, 5000, 'test-session'),
      /Cryptographic configuration error: Approval HMAC secret is missing or empty/,
      'Must throw when creating challenge without secret'
    );
    console.log('  ✓ ApprovalService fails closed when secrets are absent');

    // Test 13: Explicit empty secret via secure constructor injection fails closed
    console.log('Test 13: Explicit empty secret via constructor injection throws in ApprovalService');
    const { ApprovalService } = await import('../../src/services/approval/approval.service');
    const emptySecretService = new ApprovalService('');
    assert.throws(
      () => emptySecretService.signChallenge('tk1', 'fp1', 'nonce1', Date.now()),
      /Cryptographic configuration error: Approval HMAC secret is missing or empty/,
      'Must throw when injected secret is empty string'
    );
    console.log('  ✓ Explicit empty secret via constructor injection fails closed');

    // Test 14: Explicit valid secret via constructor injection succeeds
    console.log('Test 14: Explicit valid secret via constructor injection accepted');
    const dedicatedSecret = `dedicated_injected_secret_${Date.now()}`;
    const customService = new ApprovalService(dedicatedSecret);
    const customSig = customService.signChallenge('tk_custom', 'fp_custom', 'nonce_custom', 123456);
    assert.strictEqual(typeof customSig, 'string');
    assert.strictEqual(customSig.length, 64);
    console.log('  ✓ Explicit valid secret via constructor injection accepted');

    // Test 15: Secret is never exposed via public getter or runtime mutation
    console.log('Test 15: Secret is never exposed through public getter or runtime mutation');
    assert.strictEqual((approvalService as any).configuredSecret, undefined, 'configuredSecret must not be public');
    assert.strictEqual((approvalService as any).secret, undefined, 'secret property must not be public');
    assert.strictEqual((approvalService as any).setSecret, undefined, 'setSecret method must not exist');
    console.log('  ✓ Secret encapsulation strictly enforced (zero public getters or setters)');
  } finally {
    if (origAppr !== undefined) process.env.APPROVAL_SECRET = origAppr;
    if (origNext !== undefined) process.env.NEXTAUTH_SECRET = origNext;
  }
  } finally {
    if (needsLocalIsolation) {
      teardownTestIsolation();
    }
  }
}

if (require.main === module) {
  runApprovalTests()
    .then(() => console.log('✅ ALL APPROVAL SECURITY TESTS PASSED'))
    .catch((err) => {
      console.error('❌ Approval security test suite failed:', err);
      process.exit(1);
    });
}
