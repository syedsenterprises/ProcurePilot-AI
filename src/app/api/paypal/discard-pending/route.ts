import { NextRequest, NextResponse } from 'next/server';
import { payPalOrderStore, hashSessionToken } from '@/services/paypal/paypal-order-store';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 15,
    endpointName: 'paypal-discard-pending'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded.' },
      { status: 429 }
    );
  }

  const sessionCookie = request.cookies.get('procurepilot_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json(
      { success: false, error: 'No active session found.' },
      { status: 400 }
    );
  }

  const sessionHash = hashSessionToken(sessionCookie);
  const sessionOrders = payPalOrderStore.getOrdersBySessionHash(sessionHash);

  const pending = sessionOrders.find((ord) => ord.status === 'CREATED');
  if (pending) {
    pending.status = 'VOIDED';
    payPalOrderStore.saveOrder(pending);
    auditLogger.log('PAYPAL_ORDER_CREATED', 'INFO', `Pending order ${pending.orderId} voided by user session`);
  }

  return NextResponse.json({
    success: true,
    message: 'Pending order successfully discarded.'
  });
}
