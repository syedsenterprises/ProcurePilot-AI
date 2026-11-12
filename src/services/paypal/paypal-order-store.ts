import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function hashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

export interface StoredPayPalOrder {
  orderId: string;
  ticketId: string;
  authorizedTotal: number;
  authorizedSubtotal: number;
  authorizedTax: number;
  authorizedShipping: number;
  currency: 'USD';
  status: 'CREATED' | 'CAPTURED' | 'VOIDED';
  approverName: string;
  approverDepartment: string;
  items: Array<{ productId: string; name: string; quantity: number; unitPrice: number }>;
  createdAt: string;
  capturedAt?: string;
  captureId?: string;
  idempotencyKey?: string;
  isSimulated?: boolean;
  sessionHash?: string;
  approvalUrl?: string;
}

export class PayPalOrderStore {
  private static instance: PayPalOrderStore;
  private storeDir: string;
  private memoryStore: Map<string, StoredPayPalOrder> = new Map();

  private constructor() {
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    this.storeDir = path.resolve(baseDir, 'orders');
    this.ensureDirectory();
  }

  public setStoreDir(newDir: string): void {
    this.storeDir = newDir;
    this.ensureDirectory();
  }

  public resetStoreDir(): void {
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    this.storeDir = path.resolve(baseDir, 'orders');
    this.ensureDirectory();
  }

  public static getInstance(): PayPalOrderStore {
    if (!PayPalOrderStore.instance) {
      PayPalOrderStore.instance = new PayPalOrderStore();
    }
    return PayPalOrderStore.instance;
  }

  private ensureDirectory() {
    try {
      if (!fs.existsSync(this.storeDir)) {
        fs.mkdirSync(this.storeDir, { recursive: true });
      }
    } catch {
      // Ignore
    }
  }

  private getFilePath(orderId: string): string {
    const safe = orderId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storeDir, `${safe}.json`);
  }

  public saveOrder(order: StoredPayPalOrder): void {
    this.memoryStore.set(order.orderId, order);
    try {
      this.ensureDirectory();
      fs.writeFileSync(this.getFilePath(order.orderId), JSON.stringify(order), 'utf8');
    } catch {
      // Fallback in memory
    }
  }

  public getOrder(orderId: string): StoredPayPalOrder | null {
    if (this.memoryStore.has(orderId)) {
      return this.memoryStore.get(orderId)!;
    }
    try {
      const file = this.getFilePath(orderId);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const order = JSON.parse(raw) as StoredPayPalOrder;
        this.memoryStore.set(orderId, order);
        return order;
      }
    } catch {
      // Fallback
    }
    return null;
  }

  public getOrdersBySessionHash(sessionHash: string): StoredPayPalOrder[] {
    if (!sessionHash) return [];
    const ordersMap = new Map<string, StoredPayPalOrder>();

    // 1. Scan memory store
    for (const order of this.memoryStore.values()) {
      if (order.sessionHash === sessionHash) {
        ordersMap.set(order.orderId, order);
      }
    }

    // 2. Read from disk store to ensure persistence across server restarts / free instance reloads
    try {
      this.ensureDirectory();
      if (fs.existsSync(this.storeDir)) {
        const files = fs.readdirSync(this.storeDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const orderId = file.slice(0, -5);
          if (ordersMap.has(orderId)) continue;
          try {
            const filePath = path.join(this.storeDir, file);
            const raw = fs.readFileSync(filePath, 'utf8');
            const order = JSON.parse(raw) as StoredPayPalOrder;
            this.memoryStore.set(order.orderId, order);
            if (order.sessionHash === sessionHash) {
              ordersMap.set(order.orderId, order);
            }
          } catch {
            // Ignore invalid file
          }
        }
      }
    } catch {
      // Ignore read errors
    }

    return Array.from(ordersMap.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
}

export const payPalOrderStore = PayPalOrderStore.getInstance();
