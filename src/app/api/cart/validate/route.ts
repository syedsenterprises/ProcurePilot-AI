import { NextRequest, NextResponse } from 'next/server';
import { catalogService } from '@/services/catalog/catalog.service';
import { CartValidateRequestSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (30 requests/min for cart validation)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 30,
    endpointName: 'cart-validate'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: 'Too many cart validation requests. Please slow down.'
      },
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
    const parseResult = CartValidateRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Cart validation payload rejected', {
        ipAddress: clientId,
        details: { issues: parseResult.error.issues }
      });
      return NextResponse.json(
        {
          success: false,
          error: 'Validation failed',
          details: parseResult.error.issues.map((i) => i.message)
        },
        { status: 400 }
      );
    }

    const { items, budgetCap, userApprovalConfirmed } = parseResult.data;
    const reconciliation = catalogService.reconcileCart(items, budgetCap, Boolean(userApprovalConfirmed));

    return NextResponse.json({
      success: true,
      data: reconciliation
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Cart reconciliation error'
      },
      { status: 500 }
    );
  }
}
