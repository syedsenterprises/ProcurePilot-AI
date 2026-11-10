import fs from 'fs';
import path from 'path';
import { auditLogger } from './audit-logger';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number; // epoch ms
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  endpointName: string;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; firstSeen: number }>;
  reset(key: string): Promise<void>;
}

/**
 * File-based persistent store that works across Node process restarts
 * and multi-worker clusters on the same instance.
 */
export class FileRateLimitStore implements RateLimitStore {
  private customDir?: string;

  constructor(customDir?: string) {
    this.customDir = customDir;
    this.ensureDirectory();
  }

  public getStoreDir(): string {
    if (this.customDir) {
      return path.resolve(this.customDir);
    }
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    return path.resolve(baseDir, 'rate-limits');
  }

  private ensureDirectory(): void {
    try {
      const dir = this.getStoreDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // Ignore directory creation error
    }
  }

  private getFilePath(key: string): string {
    const safeKey = Buffer.from(key).toString('hex').slice(0, 64);
    return path.join(this.getStoreDir(), `${safeKey}.json`);
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; firstSeen: number }> {
    this.ensureDirectory();
    const file = this.getFilePath(key);
    const now = Date.now();
    let data = { count: 0, firstSeen: now };

    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (now - parsed.firstSeen < windowMs) {
          data = { count: parsed.count + 1, firstSeen: parsed.firstSeen };
        } else {
          data = { count: 1, firstSeen: now };
        }
      } else {
        data = { count: 1, firstSeen: now };
      }
    } catch {
      data = { count: 1, firstSeen: now };
    }

    try {
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    } catch {
      // Ignore write errors in restricted sandboxes
    }

    return data;
  }

  async reset(key: string): Promise<void> {
    try {
      const file = this.getFilePath(key);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Ignore
    }
  }
}

/**
 * In-memory fallback store for environments without filesystem write permissions.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; firstSeen: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; firstSeen: number }> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now - entry.firstSeen >= windowMs) {
      const newEntry = { count: 1, firstSeen: now };
      this.store.set(key, newEntry);
      return newEntry;
    }

    entry.count += 1;
    return entry;
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class RateLimiter {
  private static instance: RateLimiter;
  private store: RateLimitStore;

  private constructor() {
    this.store = this.createDefaultStore();
  }

  public createDefaultStore(): RateLimitStore {
    const isTest = process.env.NODE_ENV === 'test';
    if (isTest || process.env.RATE_LIMIT_STORE === 'memory') {
      return new MemoryRateLimitStore();
    }
    return new FileRateLimitStore();
  }

  public static getInstance(): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter();
    }
    return RateLimiter.instance;
  }

  public setStore(store: RateLimitStore) {
    this.store = store;
  }

  public resetStore(): void {
    this.store = this.createDefaultStore();
  }

  public getStore(): RateLimitStore {
    return this.store;
  }

  public async checkLimit(
    identifier: string,
    options: RateLimitOptions
  ): Promise<RateLimitResult> {
    const key = `${options.endpointName}:${identifier}`;
    const { count, firstSeen } = await this.store.increment(key, options.windowMs);

    const resetTime = firstSeen + options.windowMs;
    const remaining = Math.max(0, options.max - count);
    const allowed = count <= options.max;

    if (!allowed) {
      auditLogger.log(
        'RATE_LIMIT_EXCEEDED',
        'WARN',
        `Rate limit exceeded for endpoint ${options.endpointName}`,
        {
          ipAddress: identifier,
          details: {
            endpoint: options.endpointName,
            attemptedCount: count,
            limit: options.max,
            windowMs: options.windowMs
          }
        }
      );
    }

    return {
      allowed,
      limit: options.max,
      remaining,
      resetTime
    };
  }
}

export const rateLimiter = RateLimiter.getInstance();

export function getClientIdentifier(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const clientIp = forwardedFor.split(',')[0].trim();
    if (clientIp) return clientIp;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  // Session cookie fallback
  const cookie = request.headers.get('cookie') || '';
  const sessionMatch = cookie.match(/procurepilot_session=([a-zA-Z0-9_-]+)/);
  if (sessionMatch) return sessionMatch[1];

  return 'anonymous_client';
}
