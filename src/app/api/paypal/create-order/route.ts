import { NextRequest, NextResponse } from 'next/server';
import { payPalService } from '@/services/paypal/paypal.service';
import { PayPalCreateOrderSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (10 requests/min for payment order creation)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 10,
    endpointName: 'paypal-create-order'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, message: 'Too many order requests. Please wait before creating another order.' },
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
    const parseResult = PayPalCreateOrderSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Invalid PayPal create-order payload', {
        ipAddress: clientId,
        details: { issues: parseResult.error.issues }
      });
      return NextResponse.json(
        {
          success: false,
          message: 'Order creation validation failed: ' + parseResult.error.issues.map((i) => i.message).join('; ')
        },
        { status: 400 }
      );
    }

    const { ticketId, authToken, items, approvalSignoff, clientReferenceId, currency } = parseResult.data;
    const sessionToken = request.cookies.get('procurepilot_session')?.value;

    const orderResult = await payPalService.createOrder(
      {
        items,
        userApprovalConfirmed: true,
        approvalSignoff: {
          userName: approvalSignoff.userName,
          department: approvalSignoff.department,
          purchaseJustification: approvalSignoff.purchaseJustification,
          confirmedAt: new Date().toISOString()
        },
        clientReferenceId,
        currency
      },
      {
        ticketId,
        authToken,
        sessionToken
      }
    );

    const isSecurityError =
      orderResult.message?.includes('Security') ||
      orderResult.message?.includes('Replay') ||
      orderResult.message?.includes('Mismatch') ||
      orderResult.message?.includes('Tampering');

    return NextResponse.json(orderResult, {
      status: orderResult.success ? 200 : orderResult.requiresManualReview ? 200 : isSecurityError ? 403 : 400
    });
  } catch (error) {
    auditLogger.log('PAYPAL_ORDER_CREATED', 'ERROR', 'Exception during PayPal create-order', {
      ipAddress: clientId,
      details: { error: error instanceof Error ? error.message : 'Unknown' }
    });
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to process PayPal order creation'
      },
      { status: 500 }
    );
  }
}
