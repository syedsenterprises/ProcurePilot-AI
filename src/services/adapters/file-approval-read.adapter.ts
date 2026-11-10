import { approvalService, ApprovalChallengeState } from '../approval/approval.service';
import { IApprovalReadStore, TicketStatusInfo, ReadOnlyLineItem } from './read-store.interface';

/**
 * File-backed read adapter wrapping legacy JSON approval storage (.data/approvals).
 * Strictly preserves existing runtime semantics, not-found behavior, and file isolation.
 */
export class FileApprovalReadAdapter implements IApprovalReadStore {
  public async getChallenge(ticketId: string): Promise<ApprovalChallengeState | null> {
    const ticket = approvalService.getChallenge(ticketId);
    return ticket || null;
  }

  public async getTicketStatus(ticketId: string): Promise<TicketStatusInfo | null> {
    const ticket = approvalService.getChallenge(ticketId);
    if (!ticket) return null;

    const sourceOrigin = ticket.sourceOrigin || 'LEGACY_JSON_IMPORT';
    const integrityStatus = ticket.integrityStatus || 'UNVERIFIABLE_LEGACY';
    const isVerifiable = integrityStatus === 'VERIFIED';

    return {
      ticketId: ticket.ticketId,
      status: ticket.status,
      integrityStatus,
      sourceOrigin,
      isVerifiable,
    };
  }

  public async getTicketItems(ticketId: string): Promise<ReadOnlyLineItem[] | null> {
    const ticket = approvalService.getChallenge(ticketId);
    if (!ticket || !Array.isArray(ticket.verifiedItems)) return null;

    return ticket.verifiedItems.map((it) => ({
      productId: it.productId,
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal !== undefined ? it.lineTotal : it.quantity * it.unitPrice,
    }));
  }
}

export const fileApprovalReadAdapter = new FileApprovalReadAdapter();
