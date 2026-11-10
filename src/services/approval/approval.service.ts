import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { catalogService } from '../catalog/catalog.service';
import { auditLogger } from '@/lib/security/audit-logger';

export interface VerifiedItemSummary {
  productId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface ApprovalChallengeState {
  ticketId: string;
  nonce: string;
  cartFingerprint: string;
  verifiedItems: VerifiedItemSummary[];
  verifiedSubtotal: number;
  verifiedTax: number;
  verifiedShipping: number;
  verifiedTotal: number;
  currency: 'USD';
  createdAt: number;
  expiresAt: number;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'CONSUMED';
  sessionToken?: string;
  signoff?: {
    userName: string;
    department: string;
    purchaseJustification: string;
    signedAt: string;
    identityTier: 'SELF_ATTESTED_REQUISITIONER'; // Transparent identity tier
  };
  consumedAt?: string;
  sourceOrigin?: 'RUNTIME' | 'LEGACY_JSON_IMPORT';
  integrityStatus?: 'VERIFIED' | 'UNVERIFIABLE_LEGACY';
}

export interface ChallengeCreationResult {
  ticketId: string;
  cartFingerprint: string;
  nonce: string;
  expiresAt: number;
  signature: string;
  verifiedTotal: number;
  currency: 'USD';
  verifiedItems: VerifiedItemSummary[];
}

export interface TicketSigningResult {
  success: boolean;
  ticketId: string;
  authToken: string;
  expiresAt: number;
  message?: string;
}

export class ApprovalService {
  private static instance: ApprovalService;
  private readonly injectedSecret?: string;
  private storeDir: string;
  private memoryStore: Map<string, ApprovalChallengeState> = new Map();

  public constructor(injectedSecret?: string) {
    this.injectedSecret = injectedSecret;
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    this.storeDir = path.resolve(baseDir, 'approvals');
    this.ensureDirectory();
  }

  private getSecret(): string {
    const s =
      this.injectedSecret !== undefined
        ? this.injectedSecret
        : process.env.APPROVAL_SECRET || process.env.NEXTAUTH_SECRET;
    if (!s || s.trim().length === 0) {
      throw new Error(
        'Cryptographic configuration error: Approval HMAC secret is missing or empty. Server must configure APPROVAL_SECRET or NEXTAUTH_SECRET.'
      );
    }
    return s.trim();
  }

  public setStoreDir(newDir: string): void {
    this.storeDir = newDir;
    this.ensureDirectory();
  }

  public resetStoreDir(): void {
    const baseDir = process.env.DATA_STORE_DIR || path.resolve(process.cwd(), '.data');
    this.storeDir = path.resolve(baseDir, 'approvals');
    this.ensureDirectory();
  }

  public static getInstance(injectedSecret?: string): ApprovalService {
    if (!ApprovalService.instance) {
      ApprovalService.instance = new ApprovalService(injectedSecret);
    }
    return ApprovalService.instance;
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

  private getFilePath(ticketId: string): string {
    const safe = ticketId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storeDir, `${safe}.json`);
  }

  private saveState(state: ApprovalChallengeState) {
    this.memoryStore.set(state.ticketId, state);
    try {
      this.ensureDirectory();
      fs.writeFileSync(this.getFilePath(state.ticketId), JSON.stringify(state), 'utf8');
    } catch {
      // Memory fallback continues to work
    }
  }

  private getState(ticketId: string): ApprovalChallengeState | null {
    if (this.memoryStore.has(ticketId)) {
      return this.memoryStore.get(ticketId)!;
    }
    try {
      const file = this.getFilePath(ticketId);
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const state = JSON.parse(raw) as ApprovalChallengeState;
        this.memoryStore.set(ticketId, state);
        return state;
      }
    } catch {
      // Fallback
    }
    return null;
  }

  public calculateCartFingerprint(
    items: Array<{ productId: string; quantity: number; unitPrice: number }>,
    total: number,
    currency: string
  ): string {
    const sorted = [...items].sort((a, b) => a.productId.localeCompare(b.productId));
    const canonical = JSON.stringify({
      items: sorted.map((i) => ({ id: i.productId, q: i.quantity, p: i.unitPrice.toFixed(2) })),
      total: total.toFixed(2),
      currency
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  public signChallenge(ticketId: string, fingerprint: string, nonce: string, expiresAt: number): string {
    const payload = `${ticketId}:${fingerprint}:${nonce}:${expiresAt}`;
    return crypto.createHmac('sha256', this.getSecret()).update(payload).digest('hex');
  }

  public signAuthToken(ticketId: string, fingerprint: string, nonce: string, expiresAt: number): string {
    const payload = `${ticketId}:APPROVED:${fingerprint}:${nonce}:${expiresAt}`;
    return crypto.createHmac('sha256', this.getSecret()).update(payload).digest('hex');
  }

  /**
   * STAGE 1: Server generates challenge bound to authoritative items & total with 10m TTL
   */
  public createChallenge(
    items: Array<{ productId: string; quantity: number }>,
    budgetCap?: number,
    sessionToken?: string
  ): ChallengeCreationResult {
    // Authoritative recalculation (never trusting client)
    const reconciliation = catalogService.reconcileCart(items, budgetCap, false);
    if (!reconciliation.isValid) {
      throw new Error(`Cart reconciliation failed: ${reconciliation.discrepancies.join('; ')}`);
    }

    const verifiedItems: VerifiedItemSummary[] = reconciliation.verifiedItems.map((i) => ({
      productId: i.productId,
      name: i.name,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
      lineTotal: i.lineTotal
    }));

    const cartFingerprint = this.calculateCartFingerprint(
      verifiedItems.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })),
      reconciliation.verifiedTotal,
      'USD'
    );

    const nonce = crypto.randomBytes(32).toString('hex');
    const ticketId = `appr_tk_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes TTL

    const signature = this.signChallenge(ticketId, cartFingerprint, nonce, expiresAt);

    const state: ApprovalChallengeState = {
      ticketId,
      nonce,
      cartFingerprint,
      verifiedItems,
      verifiedSubtotal: reconciliation.verifiedSubtotal,
      verifiedTax: reconciliation.verifiedTax,
      verifiedShipping: reconciliation.verifiedShipping,
      verifiedTotal: reconciliation.verifiedTotal,
      currency: 'USD',
      createdAt: now,
      expiresAt,
      status: 'PENDING_APPROVAL',
      sessionToken,
      sourceOrigin: 'RUNTIME',
      integrityStatus: 'VERIFIED'
    };

    this.saveState(state);

    auditLogger.log(
      'APPROVAL_CHALLENGE_CREATED',
      'INFO',
      `Approval challenge created for total $${reconciliation.verifiedTotal}`,
      {
        sessionId: sessionToken,
        details: { ticketId, cartFingerprint, expiresAt, total: reconciliation.verifiedTotal }
      }
    );

    return {
      ticketId,
      cartFingerprint,
      nonce,
      expiresAt,
      signature,
      verifiedTotal: reconciliation.verifiedTotal,
      currency: 'USD',
      verifiedItems
    };
  }

  /**
   * STAGE 2: Approver signs challenge and receives single-use authorization token
   */
  public signApproval(
    ticketId: string,
    signature: string,
    cartFingerprint: string,
    nonce: string,
    signoff: {
      userName: string;
      department: string;
      purchaseJustification: string;
    },
    sessionToken?: string
  ): TicketSigningResult {
    const state = this.getState(ticketId);
    if (!state) {
      auditLogger.log('APPROVAL_UNAUTHORIZED', 'WARN', `Unknown ticket signing attempt: ${ticketId}`);
      throw new Error('Approval ticket not found or already purged.');
    }

    if (state.sourceOrigin === 'LEGACY_JSON_IMPORT' || state.integrityStatus === 'UNVERIFIABLE_LEGACY') {
      auditLogger.log('APPROVAL_UNAUTHORIZED', 'ERROR', `Signing attempt on legacy ticket: ${ticketId}`);
      throw new Error('Security Error: Historical legacy approval tickets cannot be signed for new checkout.');
    }

    if (state.status !== 'PENDING_APPROVAL') {
      auditLogger.log(
        'APPROVAL_TICKET_REPLAY_ATTEMPT',
        'WARN',
        `Replay signing attempt for ticket in status ${state.status}: ${ticketId}`
      );
      throw new Error(`Ticket is not in pending state (Current status: ${state.status}).`);
    }

    if (Date.now() > state.expiresAt) {
      auditLogger.log('APPROVAL_TICKET_EXPIRED', 'WARN', `Expired ticket signing attempt: ${ticketId}`);
      throw new Error('Approval challenge has expired (10-minute limit exceeded). Please regenerate approval.');
    }

    // Fail-closed session binding verification for runtime tickets
    const isRuntime = state.sourceOrigin === 'RUNTIME' || !state.sourceOrigin;
    if (isRuntime) {
      if (!state.sessionToken) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Signing attempt on runtime challenge missing session token: ${ticketId}`);
        throw new Error('Security Error: Approval ticket is missing required session binding. Reauthentication or challenge regeneration required.');
      }

      if (!sessionToken) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Signing attempt without active session token for: ${ticketId}`);
        throw new Error('Security Error: Active session token is required to sign approval challenge.');
      }

      const isSha256Hash = (tok: string) => tok.length === 64 && /^[0-9a-fA-F]{64}$/.test(tok);
      if (isSha256Hash(sessionToken) || isSha256Hash(state.sessionToken)) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Session hash presented as plaintext token for ${ticketId}`);
        throw new Error('Security Error: Session hash cannot be used as a plaintext session token. Reauthentication required.');
      }

      if (state.sessionToken !== sessionToken) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Session mismatch on approval signing for ${ticketId}`);
        throw new Error('Security Error: Approval session mismatch.');
      }
    }

    // Verify fingerprint and nonce match
    if (state.cartFingerprint !== cartFingerprint || state.nonce !== nonce) {
      auditLogger.log('APPROVAL_TICKET_MISMATCH', 'ERROR', `Tampered fingerprint or nonce for ${ticketId}`);
      throw new Error('Security Error: Cart fingerprint or cryptographic nonce mismatch.');
    }

    // Verify HMAC signature
    const expectedSig = this.signChallenge(ticketId, cartFingerprint, nonce, state.expiresAt);
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      auditLogger.log('APPROVAL_TICKET_MISMATCH', 'ERROR', `Invalid signature for ${ticketId}`);
      throw new Error('Security Error: Invalid cryptographic challenge signature.');
    }

    // Update state to APPROVED
    state.status = 'APPROVED';
    state.signoff = {
      ...signoff,
      signedAt: new Date().toISOString(),
      identityTier: 'SELF_ATTESTED_REQUISITIONER'
    };
    this.saveState(state);

    const authToken = this.signAuthToken(ticketId, cartFingerprint, nonce, state.expiresAt);

    auditLogger.log(
      'APPROVAL_TICKET_SIGNED',
      'INFO',
      `Approval ticket successfully signed by ${signoff.userName}`,
      {
        sessionId: sessionToken,
        details: { ticketId, approver: signoff.userName, department: signoff.department }
      }
    );

    return {
      success: true,
      ticketId,
      authToken,
      expiresAt: state.expiresAt
    };
  }

  /**
   * STAGE 3: Order consumption verification (single-use enforcement)
   */
  public verifyAndConsumeTicket(
    ticketId: string,
    authToken: string,
    itemsToCheckout: Array<{ productId: string; quantity: number }>,
    sessionToken?: string
  ): {
    isValid: boolean;
    state: ApprovalChallengeState;
    error?: string;
  } {
    const state = this.getState(ticketId);
    if (!state) {
      return { isValid: false, state: null as unknown as ApprovalChallengeState, error: 'Approval ticket not found.' };
    }

    if (state.sourceOrigin === 'LEGACY_JSON_IMPORT' || state.integrityStatus === 'UNVERIFIABLE_LEGACY') {
      auditLogger.log('APPROVAL_UNAUTHORIZED', 'ERROR', `Attempted checkout authorization with legacy ticket ${ticketId}`, {
        sessionId: sessionToken,
        details: { ticketId, sourceOrigin: state.sourceOrigin, integrityStatus: state.integrityStatus }
      });
      return {
        isValid: false,
        state,
        error: 'Security Policy Violation: Historical legacy approval tickets cannot authorize new checkout transactions.'
      };
    }

    if (state.status === 'CONSUMED') {
      auditLogger.log('APPROVAL_TICKET_REPLAY_ATTEMPT', 'CRITICAL', `Replay order attempt with ticket ${ticketId}`, {
        sessionId: sessionToken,
        details: { ticketId, consumedAt: state.consumedAt }
      });
      return { isValid: false, state, error: 'Security Policy Violation: Approval ticket has already been consumed (Replay Blocked).' };
    }

    if (state.status !== 'APPROVED') {
      return { isValid: false, state, error: `Ticket has not been approved yet (Status: ${state.status}).` };
    }

    if (Date.now() > state.expiresAt) {
      return { isValid: false, state, error: 'Approval ticket has expired (10-minute limit exceeded).' };
    }

    // Fail-closed session binding verification for runtime tickets
    const isRuntime = state.sourceOrigin === 'RUNTIME' || !state.sourceOrigin;
    if (isRuntime) {
      if (!state.sessionToken) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Consumption attempt on runtime ticket missing session token: ${ticketId}`);
        return {
          isValid: false,
          state,
          error: 'Security Policy Violation: Approval ticket is missing required session binding. Reauthentication required.'
        };
      }

      if (!sessionToken) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Consumption attempt without active session token for: ${ticketId}`);
        return {
          isValid: false,
          state,
          error: 'Security Violation: Active session token is required for checkout.'
        };
      }

      const isSha256Hash = (tok: string) => tok.length === 64 && /^[0-9a-fA-F]{64}$/.test(tok);
      if (isSha256Hash(sessionToken) || isSha256Hash(state.sessionToken)) {
        auditLogger.log('CSRF_VIOLATION', 'ERROR', `Session hash presented as plaintext token for ${ticketId}`);
        return {
          isValid: false,
          state,
          error: 'Security Violation: Session hash cannot be used as a plaintext session token. Reauthentication required.'
        };
      }

      if (state.sessionToken !== sessionToken) {
        return { isValid: false, state, error: 'Security Violation: Checkout session mismatch.' };
      }
    }

    // Verify authToken signature
    const expectedAuth = this.signAuthToken(ticketId, state.cartFingerprint, state.nonce, state.expiresAt);
    try {
      if (!crypto.timingSafeEqual(Buffer.from(authToken, 'hex'), Buffer.from(expectedAuth, 'hex'))) {
        return { isValid: false, state, error: 'Security Violation: Invalid authorization token.' };
      }
    } catch {
      return { isValid: false, state, error: 'Security Violation: Invalid token encoding.' };
    }

    // Reconcile items to ensure exact match with approved challenge items
    const approvedItemMap = new Map(state.verifiedItems.map((i) => [i.productId, i.quantity]));
    if (itemsToCheckout.length !== state.verifiedItems.length) {
      return { isValid: false, state, error: 'Cart Tampering Detected: Checkout item count does not match approved ticket.' };
    }

    for (const item of itemsToCheckout) {
      const approvedQty = approvedItemMap.get(item.productId);
      if (approvedQty === undefined || approvedQty !== item.quantity) {
        return {
          isValid: false,
          state,
          error: `Cart Tampering Detected: Product ${item.productId} quantity (${item.quantity}) does not match approved quantity (${approvedQty}).`
        };
      }
    }

    // Atomically consume ticket
    state.status = 'CONSUMED';
    state.consumedAt = new Date().toISOString();
    this.saveState(state);

    auditLogger.log('APPROVAL_TICKET_SIGNED', 'INFO', `Approval ticket consumed for order creation: ${ticketId}`);

    return { isValid: true, state };
  }

  public getChallenge(ticketId: string): ApprovalChallengeState | null {
    return this.getState(ticketId);
  }
}

export const approvalService = ApprovalService.getInstance();
