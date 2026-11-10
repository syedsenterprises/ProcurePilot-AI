import { NextRequest, NextResponse } from 'next/server';
import { geminiService } from '@/services/gemini/gemini.service';
import { ProcurementRequestSchema } from '@/lib/validation/schemas';
import { rateLimiter, getClientIdentifier } from '@/lib/security/rate-limiter';
import { auditLogger } from '@/lib/security/audit-logger';

export async function POST(request: NextRequest) {
  const clientId = getClientIdentifier(request);

  // Rate Limiting (10 requests/min for AI procurement)
  const rateLimit = await rateLimiter.checkLimit(clientId, {
    windowMs: 60 * 1000,
    max: 10,
    endpointName: 'procure'
  });

  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        error: 'Too many procurement requests. Rate limit is 10 requests per minute.'
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
    const parseResult = ProcurementRequestSchema.safeParse(rawBody);

    if (!parseResult.success) {
      auditLogger.log('INPUT_VALIDATION_FAILED', 'WARN', 'Invalid procurement request payload', {
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

    const { query, budgetLimit, department } = parseResult.data;
    const result = await geminiService.analyzeProcurementRequest(query, budgetLimit, department);

    return NextResponse.json({
      success: true,
      messageId: `proc-msg-${Date.now()}`,
      summary: result.summary,
      extractedBudget: result.detectedBudget,
      recommendations: result.recommendations,
      bundleTotal: result.bundleTotal,
      reasoningSteps: result.reasoningSteps,
      provider: result.provider,
      isAiConnected: result.isAiConnected,
      aiStatus: result.aiStatus,
      aiError: result.aiError,
      modelUsed: result.modelUsed,
      toolCallsExecuted: result.toolCallsExecuted,
      warnings: result.warningNote ? [result.warningNote] : []
    });
  } catch (error) {
    auditLogger.log('GEMINI_CALL_FAILED', 'ERROR', 'Procurement processing internal error', {
      ipAddress: clientId,
      details: { error: error instanceof Error ? error.message : 'Unknown' }
    });
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal error processing procurement request'
      },
      { status: 500 }
    );
  }
}
