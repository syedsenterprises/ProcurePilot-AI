import { NextRequest, NextResponse } from 'next/server';
import { approvalService } from '@/services/approval/approval.service';
import { ApprovalChallengeRequestSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';
import crypto from 'crypto';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (15 requests/min)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 15,
    endpointName: 'approval-challenge'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please wait before creating another approval challenge.' },
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
    const parseResult = ApprovalChallengeRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Invalid approval challenge payload', {
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

    const { items, budgetCap } = parseResult.data;

    // Get or initialize session token
    let sessionToken = request.cookies.get('procurepilot_session')?.value;
    let isNewSession = false;
    if (!sessionToken) {
      sessionToken = crypto.randomBytes(24).toString('hex');
      isNewSession = true;
    }

    const challenge = approvalService.createChallenge(items, budgetCap, sessionToken);

    const response = NextResponse.json({
      success: true,
      data: challenge
    });

    if (isNewSession) {
      response.cookies.set({
        name: 'procurepilot_session',
        value: sessionToken,
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 // 24 hours
      });
    }

    return response;
  } catch (error) {
    auditLogger.log('APPROVAL_UNAUTHORIZED', 'ERROR', 'Error creating approval challenge', {
      ipAddress: clientId,
      details: { error: error instanceof Error ? error.message : 'Unknown' }
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate approval challenge'
      },
      { status: 500 }
    );
  }
}
