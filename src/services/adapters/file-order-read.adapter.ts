import { payPalOrderStore, StoredPayPalOrder } from '../paypal/paypal-order-store';
import { IOrderReadStore, OrderCaptureInfo, ReadOnlyLineItem } from './read-store.interface';
import { parseExactDecimalToCents } from '@/db/legacy-preflight';

/**
 * File-backed read adapter wrapping legacy JSON file storage (.data/orders).
 * Strictly preserves existing runtime semantics, not-found behavior, and file isolation.
 */
export class FileOrderReadAdapter implements IOrderReadStore {
  public async getOrder(sourceOrderId: string): Promise<StoredPayPalOrder | null> {
    const order = payPalOrderStore.getOrder(sourceOrderId);
    return order || null;
  }

  public async getOrderByExternalId(externalOrderId: string): Promise<StoredPayPalOrder | null> {
    // In legacy file store, filename is identical to orderId/externalOrderId
    const order = payPalOrderStore.getOrder(externalOrderId);
    return order || null;
  }

  public async getOrderItems(sourceOrderId: string): Promise<ReadOnlyLineItem[] | null> {
    const order = payPalOrderStore.getOrder(sourceOrderId);
    if (!order) return null;
    return (order.items || []).map((it) => ({
      productId: it.productId,
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: (it as any).lineTotal !== undefined ? (it as any).lineTotal : it.quantity * it.unitPrice,
    }));
  }

  public async getCaptureInfo(sourceOrderId: string): Promise<OrderCaptureInfo | null> {
    const order = payPalOrderStore.getOrder(sourceOrderId);
    if (!order || !order.captureId) return null;

    const isSimulated = Boolean(order.isSimulated || order.captureId.startsWith('CAP_SANDBOX_STAGE2_'));
    const amountStr = order.authorizedTotal.toFixed(2);
    const amountCents = parseExactDecimalToCents(amountStr, `fileOrder[${sourceOrderId}].authorizedTotal`);

    return {
      orderId: order.orderId,
      externalCaptureId: order.captureId,
      capturedAmount: amountStr,
      capturedAmountCents: amountCents,
      currency: order.currency || 'USD',
      captureOrigin: isSimulated ? 'LOCAL_SYNTHETIC_TEST' : 'PAYPAL_API',
      isSimulated,
      capturedAt: order.capturedAt || null,
    };
  }
}

export const fileOrderReadAdapter = new FileOrderReadAdapter();
