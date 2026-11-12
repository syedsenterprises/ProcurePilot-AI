import fs from 'fs';
import path from 'path';

export type SecurityEventType =
  | 'APPROVAL_CHALLENGE_CREATED'
  | 'APPROVAL_TICKET_SIGNED'
  | 'APPROVAL_TICKET_REPLAY_ATTEMPT'
  | 'APPROVAL_TICKET_MISMATCH'
  | 'APPROVAL_TICKET_EXPIRED'
  | 'APPROVAL_UNAUTHORIZED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'PAYPAL_ORDER_CREATED'
  | 'PAYPAL_ORDER_CAPTURED'
  | 'PAYPAL_DUPLICATE_CAPTURE_ATTEMPT'
  | 'PAYPAL_AMOUNT_MISMATCH'
  | 'GEMINI_CALL_SUCCESS'
  | 'GEMINI_CALL_RETRY'
  | 'GEMINI_CALL_FAILED'
  | 'UNAUTHORIZED_TOOL_INVOCATION'
  | 'GEMINI_MODEL_FALLBACK_ATTEMPT'
  | 'GEMINI_UNKNOWN_PRODUCT_REJECTED'
  | 'GEMINI_BUDGET_OVERFLOW_REJECTED'
  | 'GEMINI_UNAVAILABLE_PRODUCT_REJECTED'
  | 'INPUT_VALIDATION_FAILED'
  | 'CSRF_VIOLATION'
  | 'PAYPAL_WEBHOOK_RECEIVED'
  | 'PAYPAL_WEBHOOK_VERIFIED'
  | 'PAYPAL_WEBHOOK_VERIFICATION_FAILED'
  | 'PAYPAL_WEBHOOK_REJECTED';

export type SecuritySeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface SecurityEvent {
  timestamp: string;
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  sessionId?: string;
  ipAddress?: string;
  message: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEYS = [
  'key',
  'apikey',
  'api_key',
  'gemini_api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'paypal_client_secret',
  'token',
  'access_token',
  'authorization',
  'bearer',
  'creditcard',
  'password'
];

export class AuditLogger {
  private static instance: AuditLogger;
  private customLogDir?: string;

  public constructor(customLogDir?: string) {
    this.customLogDir = customLogDir;
    this.ensureDirectory();
  }

  public static getInstance(customLogDir?: string): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger(customLogDir);
    }
    return AuditLogger.instance;
  }

  public setLogDir(newDir?: string): void {
    this.customLogDir = newDir;
    this.ensureDirectory();
  }

  public resetLogDir(): void {
    this.customLogDir = undefined;
    this.ensureDirectory();
  }

  public getLogDir(): string {
    if (this.customLogDir) {
      return path.resolve(this.customLogDir);
    }
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    return path.resolve(baseDir, 'audit');
  }

  public getLogFile(): string {
    return path.join(this.getLogDir(), 'audit.log');
  }

  private ensureDirectory() {
    try {
      const dir = this.getLogDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Graceful fallback if filesystem cannot be initialized
    }
  }

  private sanitizeValue(val: unknown): unknown {
    if (typeof val === 'string') {
      // Redact URLs containing ?key= or ?access_token=
      return val.replace(/([?&](?:key|access_token|token)=)[^&]+/gi, '$1[REDACTED]');
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.sanitizeValue(item));
    }
    if (typeof val === 'object' && val !== null) {
      const sanitizedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
          sanitizedObj[k] = '[REDACTED]';
        } else {
          sanitizedObj[k] = this.sanitizeValue(v);
        }
      }
      return sanitizedObj;
    }
    return val;
  }

  public log(
    eventType: SecurityEventType,
    severity: SecuritySeverity,
    message: string,
    metadata?: {
      sessionId?: string;
      ipAddress?: string;
      details?: Record<string, unknown>;
    }
  ) {
    const event: SecurityEvent = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      sessionId: metadata?.sessionId,
      ipAddress: metadata?.ipAddress,
      message: typeof message === 'string' ? (this.sanitizeValue(message) as string) : message,
      details: metadata?.details ? (this.sanitizeValue(metadata.details) as Record<string, unknown>) : undefined
    };

    const serialized = JSON.stringify(event);

    // Stdout for observability
    if (severity === 'CRITICAL' || severity === 'ERROR') {
      console.error(`[SECURITY_AUDIT] ${serialized}`);
    } else if (severity === 'WARN') {
      console.warn(`[SECURITY_AUDIT] ${serialized}`);
    } else {
      console.log(`[SECURITY_AUDIT] ${serialized}`);
    }

    // Append to file
    try {
      this.ensureDirectory();
      fs.appendFileSync(this.getLogFile(), serialized + '\n', 'utf8');
    } catch {
      // Do not crash the application if audit file write is restricted
    }
  }
}

export const auditLogger = AuditLogger.getInstance();
