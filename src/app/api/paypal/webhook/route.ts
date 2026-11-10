import { NextRequest, NextResponse } from 'next/server';
import { payPalService } from '@/services/paypal/paypal.service';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';
import { PayPalWebhookHeaders } from '@/types/paypal';

const MAX_WEBHOOK_PAYLOAD_BYTES = 128 * 1024; // 128 KB

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // 1. Rate Limiting (30 requests/min for webhook endpoint)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 30,
    endpointName: 'paypal-webhook'
  });

  if (!rateLimit.allowed) {
    auditLogger.log('RATE_LIMIT_EXCEEDED', 'WARN', 'PayPal webhook rate limit exceeded', {
      ipAddress: clientId,
      details: { endpoint: 'paypal-webhook' }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Too many webhook delivery attempts. Rate limit exceeded.' },
      {
        status: 429,
        headers: {
          'Retry-After': Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
          'X-RateLimit-Limit': rateLimit.limit.toString(),
          'X-RateLimit-Remaining': rateLimit.remaining.toString()
        }
      }
    );
  }

  // 2. Payload size check
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_WEBHOOK_PAYLOAD_BYTES) {
    auditLogger.log('PAYPAL_WEBHOOK_REJECTED', 'WARN', 'Webhook payload exceeds maximum size limit', {
      ipAddress: clientId,
      details: { contentLength }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Payload Too Large: Maximum webhook body size is 128KB.' },
      { status: 413 }
    );
  }

  // 3. Extract required transmission headers
  const authAlgo = request.headers.get('paypal-auth-algo');
  const certUrl = request.headers.get('paypal-cert-url');
  const transmissionId = request.headers.get('paypal-transmission-id');
  const transmissionSig = request.headers.get('paypal-transmission-sig');
  const transmissionTime = request.headers.get('paypal-transmission-time');

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    auditLogger.log('PAYPAL_WEBHOOK_REJECTED', 'WARN', 'Webhook request missing required PayPal transmission headers', {
      ipAddress: clientId,
      details: {
        hasAuthAlgo: Boolean(authAlgo),
        hasCertUrl: Boolean(certUrl),
        hasTransmissionId: Boolean(transmissionId),
        hasTransmissionSig: Boolean(transmissionSig),
        hasTransmissionTime: Boolean(transmissionTime)
      }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Missing required PayPal transmission headers.' },
      { status: 400 }
    );
  }

  const webhookHeaders: PayPalWebhookHeaders = {
    authAlgo,
    certUrl,
    transmissionId,
    transmissionSig,
    transmissionTime
  };

  // 4. Read and parse body text safely
  let rawBodyText: string;
  try {
    rawBodyText = await request.text();
  } catch (err: unknown) {
    auditLogger.log('PAYPAL_WEBHOOK_REJECTED', 'WARN', 'Failed to read webhook request body', {
      ipAddress: clientId,
      details: { error: err instanceof Error ? err.message : 'Unknown' }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Unable to read request payload.' },
      { status: 400 }
    );
  }

  if (rawBodyText.length > MAX_WEBHOOK_PAYLOAD_BYTES) {
    auditLogger.log('PAYPAL_WEBHOOK_REJECTED', 'WARN', 'Webhook raw text exceeds maximum size limit', {
      ipAddress: clientId,
      details: { size: rawBodyText.length }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Payload Too Large: Maximum webhook body size is 128KB.' },
      { status: 413 }
    );
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBodyText);
  } catch {
    auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Malformed JSON in PayPal webhook payload', {
      ipAddress: clientId,
      details: { transmissionId }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Malformed JSON payload.' },
      { status: 400 }
    );
  }

  // 5. Basic event structure validation
  if (!event || typeof event !== 'object' || !event.id || !event.event_type) {
    auditLogger.log('PAYPAL_WEBHOOK_REJECTED', 'WARN', 'Webhook event missing id or event_type', {
      ipAddress: clientId,
      details: { transmissionId }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'Invalid webhook event format: id and event_type are required.' },
      { status: 400 }
    );
  }

  const eventId = String(event.id);
  const eventType = String(event.event_type);

  auditLogger.log('PAYPAL_WEBHOOK_RECEIVED', 'INFO', `PayPal webhook received: ${eventType} (${eventId})`, {
    ipAddress: clientId,
    details: {
      eventId,
      eventType,
      transmissionId,
      transmissionTime
    }
  });

  // 6. Check Webhook ID configuration
  if (!payPalService.getWebhookId()) {
    auditLogger.log('PAYPAL_WEBHOOK_VERIFICATION_FAILED', 'ERROR', 'PayPal Webhook ID is not configured on the server', {
      ipAddress: clientId,
      details: { eventId, eventType }
    });
    return NextResponse.json(
      { received: false, processed: false, message: 'PayPal Webhook ID is not configured on the server.' },
      { status: 500 }
    );
  }

  // 7. Verify Webhook Signature with PayPal API
  const verificationResult = await payPalService.verifyWebhookSignature(webhookHeaders, event);

  if (!verificationResult.isValid) {
    const isError = verificationResult.status === 'ERROR';
    auditLogger.log(
      'PAYPAL_WEBHOOK_VERIFICATION_FAILED',
      isError ? 'ERROR' : 'WARN',
      `PayPal webhook signature verification failed for ${eventId}: ${verificationResult.message}`,
      {
        ipAddress: clientId,
        details: {
          eventId,
          eventType,
          transmissionId,
          errorCategory: verificationResult.errorCategory,
          status: verificationResult.status
        }
      }
    );

    const isRetryableError =
      verificationResult.errorCategory === 'PAYPAL_API_5XX' || verificationResult.errorCategory === 'TIMEOUT';

    const httpStatus = isError
      ? isRetryableError
        ? 502
        : 500
      : 400;

    const responseHeaders: Record<string, string> = {};
    if (isRetryableError) {
      responseHeaders['Retry-After'] = '30';
    }

    return NextResponse.json(
      {
        received: false,
        verified: false,
        processed: false,
        message: verificationResult.message,
        errorCategory: verificationResult.errorCategory
      },
      {
        status: httpStatus,
        headers: responseHeaders
      }
    );
  }

  // 8. Signature Verified Successfully
  auditLogger.log('PAYPAL_WEBHOOK_VERIFIED', 'INFO', `PayPal webhook verified successfully: ${eventType} (${eventId})`, {
    ipAddress: clientId,
    details: {
      eventId,
      eventType,
      transmissionId
    }
  });

  // Stage 2C.5-B.1 Safety Correction:
  // A valid signature alone must NOT result in HTTP 200 without durable event persistence.
  // Returning HTTP 503 Service Unavailable signals to PayPal that the event was not durably recorded/processed
  // and must be retried, preventing permanent silent loss of unpersisted webhook notifications.
  return NextResponse.json(
    {
      received: true,
      verified: true,
      persisted: false,
      processed: false,
      eventId,
      eventType,
      message: 'Webhook signature verified, but durable event persistence is not yet implemented. Event not processed.'
    },
    {
      status: 503,
      headers: {
        'Retry-After': '60'
      }
    }
  );
}
