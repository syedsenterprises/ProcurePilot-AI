import { NextRequest, NextResponse } from 'next/server';
import { approvalService } from '@/services/approval/approval.service';
import { ApprovalSignRequestSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (15 requests/min)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 15,
    endpointName: 'approval-sign'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded. Please wait before signing approval.' },
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
    const parseResult = ApprovalSignRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Invalid approval signing payload', {
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

    const { ticketId, signature, cartFingerprint, nonce, signoff } = parseResult.data;
    const sessionToken = request.cookies.get('procurepilot_session')?.value;

    const result = approvalService.signApproval(
      ticketId,
      signature,
      cartFingerprint,
      nonce,
      signoff,
      sessionToken
    );

    return NextResponse.json({
      success: true,
      data: result
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Approval signing failed';
    const isSecurityError = message.toLowerCase().includes('security') || message.toLowerCase().includes('mismatch');

    return NextResponse.json(
      {
        success: false,
        error: message
      },
      { status: isSecurityError ? 403 : 400 }
    );
  }
}
