import { NextRequest, NextResponse } from 'next/server';
import { payPalService } from '@/services/paypal/paypal.service';
import { PayPalCaptureOrderSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (10 requests/min for payment capture)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 10,
    endpointName: 'paypal-capture-order'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, message: 'Too many capture attempts. Please wait.' },
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

  try {
    const rawBody = await request.json();
    const parseResult = PayPalCaptureOrderSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Invalid PayPal capture payload', {
        ipAddress: clientId,
        details: { issues: parseResult.error.issues }
      });
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid capture request: ' + parseResult.error.issues.map((i) => i.message).join('; ')
        },
        { status: 400 }
      );
    }

    const { orderId } = parseResult.data;
    const captureResult = await payPalService.captureOrder(orderId);

    return NextResponse.json(captureResult, {
      status: captureResult.success ? 200 : 400
    });
  } catch (error) {
    auditLogger.log('PAYPAL_ORDER_CAPTURED', 'ERROR', 'Exception during PayPal capture', {
      ipAddress: clientId,
      details: { error: error instanceof Error ? error.message : 'Unknown' }
    });
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to capture PayPal order'
      },
      { status: 500 }
    );
  }
}
