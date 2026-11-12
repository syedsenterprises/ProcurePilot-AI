import { NextRequest, NextResponse } from 'next/server';
import { payPalOrderStore, hashSessionToken } from '@/services/paypal/paypal-order-store';
import { payPalService } from '@/services/paypal/paypal.service';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0'
};

const PENDING_ORDER_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours validity for pending checkout
const RECENT_RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours for recent completed receipt

export async function GET(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (30 requests/min for session state polling/hydration)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 30,
    endpointName: 'paypal-session-state'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded. Please wait.' },
      {
        status: 429,
        headers: {
          ...NO_CACHE_HEADERS,
          'Retry-After': Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
          'X-RateLimit-Limit': rateLimit.limit.toString(),
          'X-RateLimit-Remaining': rateLimit.remaining.toString()
        }
      }
    );
  }

  const sessionCookie = request.cookies.get('procurepilot_session')?.value;
  if (!sessionCookie || typeof sessionCookie !== 'string' || sessionCookie.trim().length === 0) {
    return NextResponse.json(
      {
        success: true,
        hasSession: false,
        pendingOrder: null,
        recentReceipt: null
      },
      {
        status: 200,
        headers: NO_CACHE_HEADERS
      }
    );
  }

  try {
    const sessionHash = hashSessionToken(sessionCookie);
    const sessionOrders = payPalOrderStore.getOrdersBySessionHash(sessionHash);

    const now = Date.now();

    // 1. Locate latest pending PayPal order
    const pending = sessionOrders.find((ord) => {
      if (ord.status !== 'CREATED') return false;
      const orderAge = now - new Date(ord.createdAt).getTime();
      return orderAge >= 0 && orderAge <= PENDING_ORDER_MAX_AGE_MS;
    });

    let safePendingOrder = null;
    if (pending) {
      safePendingOrder = {
        orderId: pending.orderId,
        ticketId: pending.ticketId,
        status: pending.status,
        authorizedTotal: pending.authorizedTotal,
        authorizedSubtotal: pending.authorizedSubtotal,
        authorizedTax: pending.authorizedTax,
        authorizedShipping: pending.authorizedShipping,
        currency: pending.currency,
        approverName: pending.approverName,
        approverDepartment: pending.approverDepartment,
        items: pending.items,
        createdAt: pending.createdAt,
        approvalUrl: pending.approvalUrl,
        isSimulated: Boolean(pending.isSimulated)
      };
    }

    // 2. Locate latest completed order receipt
    const completed = sessionOrders.find((ord) => {
      if (ord.status !== 'CAPTURED') return false;
      const captureTime = ord.capturedAt ? new Date(ord.capturedAt).getTime() : new Date(ord.createdAt).getTime();
      const age = now - captureTime;
      return age >= 0 && age <= RECENT_RECEIPT_MAX_AGE_MS;
    });

    let safeRecentReceipt = null;
    if (completed) {
      safeRecentReceipt = {
        success: true,
        orderId: completed.orderId,
        captureId: completed.captureId,
        status: 'COMPLETED',
        isSimulated: Boolean(completed.isSimulated),
        simulationNotice: completed.isSimulated
          ? 'DEVELOPMENT/TEST SIMULATION: Order captured in development simulation mode.'
          : undefined,
        orderDetails: payPalService.formatOrderDetails(completed)
      };
    }

    return NextResponse.json(
      {
        success: true,
        hasSession: true,
        pendingOrder: safePendingOrder,
        recentReceipt: safeRecentReceipt
      },
      {
        status: 200,
        headers: NO_CACHE_HEADERS
      }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to retrieve session checkout state'
      },
      {
        status: 500,
        headers: NO_CACHE_HEADERS
      }
    );
  }
}
