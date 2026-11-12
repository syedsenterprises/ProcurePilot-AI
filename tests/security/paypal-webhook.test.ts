import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/paypal/webhook/route';
import { payPalService } from '../../src/services/paypal/paypal.service';
import { payPalOrderStore, StoredPayPalOrder } from '../../src/services/paypal/paypal-order-store';

export async function runPayPalWebhookTests() {
  console.log('\n--- Running Stage 2C.5-B PayPal Webhook Signature Verification Security Tests ---');

  const originalFetch = globalThis.fetch;
  const originalWebhookId = process.env.PAYPAL_WEBHOOK_ID;
  const originalClientId = process.env.PAYPAL_CLIENT_ID;
  const originalClientSecret = process.env.PAYPAL_CLIENT_SECRET;

  // Set mock environment variables for test execution
  process.env.PAYPAL_CLIENT_ID = 'test-client-id';
  process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret-12345';
  process.env.PAYPAL_WEBHOOK_ID = 'WH-MOCK-ID-987654';

  const defaultHeaders = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360-MOCK',
    'paypal-transmission-id': 'mock-trans-id-001',
    'paypal-transmission-sig': 'mock-base64-sig-bytes',
    'paypal-transmission-time': '2026-11-07T05:00:00Z',
    'content-type': 'application/json'
  };

  const defaultEvent = {
    id: 'WH-EVENT-001',
    event_version: '1.0',
    create_time: '2026-11-07T05:00:00Z',
    resource_type: 'capture',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: '3D2952419L1477011',
      status: 'COMPLETED',
      amount: { value: '294.54', currency_code: 'USD' }
    }
  };

  function createRequest(body: unknown, customHeaders: Record<string, string> = {}) {
    const headers = { ...defaultHeaders, ...customHeaders };
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    return new NextRequest('http://localhost:3000/api/paypal/webhook', {
      method: 'POST',
      headers,
      body: rawBody
    });
  }

  try {
    // -------------------------------------------------------------------------
    // Test 1: Valid signature + unpersisted event returns HTTP 503 (Stage 2C.5-B.1)
    // -------------------------------------------------------------------------
    console.log('Test 1: Valid Webhook Signature + No Durable Storage Returns HTTP 503 (Stage 2C.5-B.1)');
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const req1 = createRequest(defaultEvent);
    const res1 = await POST(req1);
    const data1 = await res1.json();

    assert.strictEqual(res1.status, 503, 'Valid signature without durable persistence must return HTTP 503');
    assert.strictEqual(res1.headers.get('retry-after'), '60', 'Response must include Retry-After header');
    assert.strictEqual(data1.received, true);
    assert.strictEqual(data1.verified, true);
    assert.strictEqual(data1.persisted, false);
    assert.strictEqual(data1.processed, false);
    assert.strictEqual(data1.eventId, 'WH-EVENT-001');
    assert.strictEqual(data1.eventType, 'PAYMENT.CAPTURE.COMPLETED');
    assert.match(data1.message, /durable event persistence is not yet implemented/);
    console.log('  ✓ Valid signature without durable storage safely returns retryable HTTP 503');

    // -------------------------------------------------------------------------
    // Test 2: Invalid signature rejection (FAILURE)
    // -------------------------------------------------------------------------
    console.log('Test 2: Invalid Webhook Signature Rejection (FAILURE)');
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        return new Response(JSON.stringify({ verification_status: 'FAILURE' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const req2 = createRequest(defaultEvent);
    const res2 = await POST(req2);
    const data2 = await res2.json();

    assert.strictEqual(res2.status, 400, 'Invalid signature must return HTTP 400');
    assert.strictEqual(data2.received, false);
    assert.strictEqual(data2.verified, false);
    assert.strictEqual(data2.errorCategory, 'SIGNATURE_INVALID');
    console.log('  ✓ Invalid signature strictly rejected with HTTP 400 SIGNATURE_INVALID');

    // -------------------------------------------------------------------------
    // Test 3: Missing transmission headers
    // -------------------------------------------------------------------------
    console.log('Test 3: Missing PayPal Transmission Headers');
    const req3 = new NextRequest('http://localhost:3000/api/paypal/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA'
        // Missing cert-url, transmission-id, transmission-sig, transmission-time
      },
      body: JSON.stringify(defaultEvent)
    });
    const res3 = await POST(req3);
    const data3 = await res3.json();

    assert.strictEqual(res3.status, 400, 'Missing headers must return HTTP 400');
    assert.strictEqual(data3.received, false);
    assert.match(data3.message, /Missing required PayPal transmission headers/);
    console.log('  ✓ Request with missing headers immediately rejected with HTTP 400');

    // -------------------------------------------------------------------------
    // Test 4: Missing webhook ID configuration
    // -------------------------------------------------------------------------
    console.log('Test 4: Unconfigured Webhook ID (Fail-Closed)');
    delete process.env.PAYPAL_WEBHOOK_ID;

    const req4 = createRequest(defaultEvent);
    const res4 = await POST(req4);
    const data4 = await res4.json();

    assert.strictEqual(res4.status, 500, 'Missing webhook ID configuration must return HTTP 500');
    assert.strictEqual(data4.received, false);
    assert.match(data4.message, /PayPal Webhook ID is not configured/);
    console.log('  ✓ Unconfigured webhook ID fails closed with HTTP 500');

    // Restore webhook ID
    process.env.PAYPAL_WEBHOOK_ID = 'WH-MOCK-ID-987654';

    // -------------------------------------------------------------------------
    // Test 5: Malformed JSON payload
    // -------------------------------------------------------------------------
    console.log('Test 5: Malformed JSON Payload');
    const req5 = createRequest('{"id": "WH-1", "bad-json: broken');
    const res5 = await POST(req5);
    const data5 = await res5.json();

    assert.strictEqual(res5.status, 400, 'Malformed JSON must return HTTP 400');
    assert.strictEqual(data5.received, false);
    assert.match(data5.message, /Malformed JSON payload/);
    console.log('  ✓ Malformed JSON rejected with HTTP 400');

    // -------------------------------------------------------------------------
    // Test 6: PayPal API timeout handling
    // -------------------------------------------------------------------------
    console.log('Test 6: PayPal Verification API Timeout Handling');
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        const timeoutError = new Error('The operation was aborted due to timeout');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      return new Response('Not Found', { status: 404 });
    };

    const req6 = createRequest(defaultEvent);
    const res6 = await POST(req6);
    const data6 = await res6.json();

    assert.strictEqual(res6.status, 502, 'API timeout must return HTTP 502');
    assert.strictEqual(res6.headers.get('retry-after'), '30', 'Timeout response must include Retry-After header');
    assert.strictEqual(data6.received, false);
    assert.strictEqual(data6.verified, false);
    assert.strictEqual(data6.errorCategory, 'TIMEOUT');
    console.log('  ✓ Verification timeout handled cleanly with retryable HTTP 502 TIMEOUT');

    // -------------------------------------------------------------------------
    // Test 7: PayPal API 5xx error handling
    // -------------------------------------------------------------------------
    console.log('Test 7: PayPal Verification API 5xx Error Handling');
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        return new Response('PayPal Internal Server Error', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const req7 = createRequest(defaultEvent);
    const res7 = await POST(req7);
    const data7 = await res7.json();

    assert.strictEqual(res7.status, 502, 'API 5xx must return HTTP 502');
    assert.strictEqual(res7.headers.get('retry-after'), '30', '5xx response must include Retry-After header');
    assert.strictEqual(data7.received, false);
    assert.strictEqual(data7.errorCategory, 'PAYPAL_API_5XX');
    console.log('  ✓ Verification API 5xx handled cleanly with retryable HTTP 502 PAYPAL_API_5XX');

    // -------------------------------------------------------------------------
    // Test 8: Unexpected verification response format
    // -------------------------------------------------------------------------
    console.log('Test 8: Unexpected Verification Response Format');
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        return new Response(JSON.stringify({ verification_status: 'UNKNOWN_OR_MALFORMED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const req8 = createRequest(defaultEvent);
    const res8 = await POST(req8);
    const data8 = await res8.json();

    assert.strictEqual(res8.status, 500, 'Unexpected verification format must return HTTP 500');
    assert.strictEqual(data8.received, false);
    assert.strictEqual(data8.errorCategory, 'UNEXPECTED_RESPONSE');
    console.log('  ✓ Unexpected verification format handled safely with HTTP 500 UNEXPECTED_RESPONSE');

    // -------------------------------------------------------------------------
    // Test 9: Invalid event structure missing id or event_type
    // -------------------------------------------------------------------------
    console.log('Test 9: Invalid Event Structure (Missing id or event_type)');
    const req9a = createRequest({ event_type: 'CHECKOUT.ORDER.APPROVED' }); // missing id
    const res9a = await POST(req9a);
    assert.strictEqual(res9a.status, 400);

    const req9b = createRequest({ id: 'WH-123' }); // missing event_type
    const res9b = await POST(req9b);
    assert.strictEqual(res9b.status, 400);
    console.log('  ✓ Events missing mandatory id or event_type rejected with HTTP 400');

    // -------------------------------------------------------------------------
    // Test 10: No payment state mutations on verified event
    // -------------------------------------------------------------------------
    console.log('Test 10: No Payment State Mutations on Verified Event');
    // Seed an order into payPalOrderStore
    const testOrderId = 'TEST-ORDER-MUTATION-CHECK-01';
    const initialOrder: StoredPayPalOrder = {
      orderId: testOrderId,
      ticketId: 'TICKET-TEST-10',
      authorizedTotal: 500,
      authorizedSubtotal: 450,
      authorizedTax: 50,
      authorizedShipping: 0,
      currency: 'USD',
      status: 'CREATED',
      approverName: 'Alex Mercer',
      approverDepartment: 'DevOps',
      items: [{ productId: 'prod-hm-aeron-01', name: 'Herman Miller Aeron Chair', quantity: 1, unitPrice: 450 }],
      createdAt: '2026-11-07T04:00:00Z',
      idempotencyKey: 'req-test-10'
    };
    payPalOrderStore.saveOrder(initialOrder);

    // Mock fetch for successful verification
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token-xyz' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/v1/notifications/verify-webhook-signature')) {
        return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const webhookEventForOrder = {
      id: 'WH-MUTATION-TEST-001',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      resource: {
        id: 'CAPTURE-ID-999',
        supplementary_data: {
          related_ids: {
            order_id: testOrderId
          }
        }
      }
    };

    const req10 = createRequest(webhookEventForOrder);
    const res10 = await POST(req10);
    assert.strictEqual(res10.status, 503, 'Valid unpersisted event must return HTTP 503');
    assert.strictEqual(res10.headers.get('retry-after'), '60');
    const data10 = await res10.json();
    assert.strictEqual(data10.persisted, false);
    assert.strictEqual(data10.processed, false);

    // Verify stored order remains completely untouched
    const orderAfterWebhook = payPalOrderStore.getOrder(testOrderId);
    assert.ok(orderAfterWebhook, 'Order must still exist in store');
    assert.strictEqual(orderAfterWebhook.status, 'CREATED', 'Order status must NOT be mutated by webhook');
    assert.strictEqual(orderAfterWebhook.capturedAt, undefined, 'Order capturedAt must remain undefined');
    assert.strictEqual(orderAfterWebhook.captureId, undefined, 'Order captureId must remain undefined');
    assert.strictEqual(orderAfterWebhook.authorizedTotal, 500);
    console.log('  ✓ Stored order strictly unmutated after receiving verified webhook event');

    // -------------------------------------------------------------------------
    // Test 11: No automatic capture executed
    // -------------------------------------------------------------------------
    console.log('Test 11: No Automatic Capture Executed');
    let captureCalled = false;
    const origCaptureOrder = payPalService.captureOrder.bind(payPalService);
    payPalService.captureOrder = async (...args) => {
      captureCalled = true;
      return origCaptureOrder(...args);
    };

    try {
      const req11 = createRequest(defaultEvent);
      const res11 = await POST(req11);
      assert.strictEqual(res11.status, 503, 'Webhook returns HTTP 503');
      assert.strictEqual(captureCalled, false, 'Webhook handler must NOT call captureOrder');
      console.log('  ✓ Webhook processing guarantees zero automatic capture execution');
    } finally {
      payPalService.captureOrder = origCaptureOrder;
    }

    // -------------------------------------------------------------------------
    // Test 12: No secrets or access tokens leaked in audit logs
    // -------------------------------------------------------------------------
    console.log('Test 12: No Secrets or Access Tokens Leaked in Audit Logs');
    const auditFilePath = path.resolve(process.cwd(), '.data', 'audit', 'audit.log');
    if (fs.existsSync(auditFilePath)) {
      const logContent = fs.readFileSync(auditFilePath, 'utf-8');
      assert.strictEqual(
        logContent.includes('test-client-secret-12345'),
        false,
        'Client secret must never appear in audit log'
      );
      assert.strictEqual(
        logContent.includes('mock-access-token-xyz'),
        false,
        'OAuth access token must never appear in audit log'
      );
      assert.strictEqual(
        /Bearer\s+mock-access-token/i.test(logContent),
        false,
        'Bearer authorization tokens must never appear in audit log'
      );
      console.log('  ✓ Audit logs verified clean of client secrets, access tokens, and bearer credentials');
    } else {
      console.log('  ✓ Audit log file not yet created; no leakage possible');
    }

    console.log('\n✅ All 12 PayPal Webhook Signature Verification Security Tests Passed (0 Failures)');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhookId !== undefined) {
      process.env.PAYPAL_WEBHOOK_ID = originalWebhookId;
    } else {
      delete process.env.PAYPAL_WEBHOOK_ID;
    }
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
  }
}
