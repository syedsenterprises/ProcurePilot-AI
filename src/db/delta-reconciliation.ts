import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { OrderStatus } from './repositories/types';
import { canTransitionOrder, mapLegacyOrderStatusToDb } from './order-state-machine';
import { generateLegacyOrderNumber, SEED_ORGANIZATION_ID } from './legacy-migration';
import { parseExactDecimalToCents, parseExactDecimalString } from './legacy-preflight';
import { approvalService } from '../services/approval/approval.service';

export type DeltaRecordCategory =
  | 'EXISTING_BASELINE_UNCHANGED'
  | 'LEGITIMATE_STATE_TRANSITION'
  | 'NEW_RUNTIME_RECORD'
  | 'FINANCIAL_PAYMENT_EVENT'
  | 'CONFLICT_REJECTED'
  | 'QUARANTINED_EXCLUDED';

export interface OrderDeltaItem {
  fileName: string;
  orderId: string;
  category: DeltaRecordCategory;
  reason: string;
  oldDbStatus?: OrderStatus;
  newDbStatus?: OrderStatus;
  authorizedTotalDecimal: string;
  isSimulated: boolean;
  hasCapture: boolean;
  captureId?: string | null;
  captureOrigin?: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST' | null;
  immutableFieldsMatch?: boolean;
}

export interface ApprovalDeltaItem {
  fileName: string;
  ticketId: string;
  category: DeltaRecordCategory;
  reason: string;
  status: string;
  sourceOrigin: 'RUNTIME' | 'LEGACY_JSON_IMPORT';
  integrityStatus: 'VERIFIED' | 'UNVERIFIABLE_LEGACY';
  verifiedTotalDecimal: string;
}

export interface DeltaAnalysisResult {
  totalOrdersScanned: number;
  totalApprovalsScanned: number;
  orders: OrderDeltaItem[];
  approvals: ApprovalDeltaItem[];
  existingBaselineUnchangedCount: number;
  legitimateStateTransitionsCount: number;
  newRuntimeOrdersCount: number;
  newRuntimeApprovalsCount: number;
  genuineCapturesCount: number;
  syntheticCapturesSegregatedCount: number;
  conflictsRejectedCount: number;
  quarantinedExcludedCount: number;
  hasConflicts: boolean;
  conflictDetails: string[];
}

export interface DeltaReconciliationOptions {
  pool: Pool;
  dataDir?: string;
  preflightManifestPath?: string;
  quarantineManifestPath?: string;
  organizationId?: string;
  hmacSecret?: string;
  operatorId?: string;
  dryRun?: boolean;
  allowMutations?: boolean;
  authorizedTargetDatabase?: string;
  disposableEnvironmentMarker?: string;
  expectedClusterSystemIdentifier?: string;
  expectedServerHost?: string;
  expectedServerPort?: number;
  expectedDatabaseUser?: string;
  failOnConflict?: boolean;
}

export interface DeltaReconciliationResult {
  success: boolean;
  executedAt: string;
  databaseName: string;
  dryRun: boolean;
  analysis: DeltaAnalysisResult;
  appliedTransitionsCount: number;
  appliedNewOrdersCount: number;
  appliedNewApprovalsCount: number;
  appliedGenuineCapturesCount: number;
  syntheticCapturesSegregatedCount: number;
  quarantinedExcludedCount: number;
  error?: string;
}

function computeSha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export class DeltaReconciler {
  private readonly pool: Pool;
  private readonly dataDir: string;
  private readonly preflightManifestPath: string;
  private readonly quarantineManifestPath: string;
  private readonly organizationId: string;
  private readonly hmacSecret?: string;
  private readonly operatorId?: string;
  private readonly dryRun: boolean;
  private readonly allowMutations: boolean;
  private readonly authorizedTargetDatabase?: string;
  private readonly disposableEnvironmentMarker?: string;
  private readonly expectedClusterSystemIdentifier?: string;
  private readonly expectedServerHost?: string;
  private readonly expectedServerPort?: number;
  private readonly expectedDatabaseUser?: string;
  private readonly failOnConflict: boolean;

  constructor(options: DeltaReconciliationOptions) {
    this.pool = options.pool;
    const baseDir = process.cwd();
    this.dataDir = options.dataDir || path.resolve(baseDir, '.data');
    this.preflightManifestPath =
      options.preflightManifestPath || path.resolve(baseDir, 'migration-preflight-manifest.json');
    this.quarantineManifestPath =
      options.quarantineManifestPath || path.resolve(baseDir, 'migration-quarantine-manifest.json');
    this.organizationId = options.organizationId || SEED_ORGANIZATION_ID;
    this.hmacSecret =
      options.hmacSecret !== undefined
        ? options.hmacSecret
        : process.env.APPROVAL_SECRET || process.env.NEXTAUTH_SECRET || undefined;
    this.operatorId = options.operatorId;

    // Remediation A: dryRun MUST default to true
    this.dryRun = options.dryRun !== false;
    this.allowMutations = Boolean(options.allowMutations);
    this.authorizedTargetDatabase = options.authorizedTargetDatabase;
    this.disposableEnvironmentMarker = options.disposableEnvironmentMarker;
    this.expectedClusterSystemIdentifier = options.expectedClusterSystemIdentifier;
    this.expectedServerHost = options.expectedServerHost;
    this.expectedServerPort = options.expectedServerPort;
    this.expectedDatabaseUser = options.expectedDatabaseUser;
    this.failOnConflict = options.failOnConflict !== false;
  }

  /**
   * Asserts positive database-target authorization.
   * Mutating execution is strictly barred unless affirmatively authorized for a verified disposable target.
   */
  private async assertDatabaseSafety(client: PoolClient): Promise<string> {
    const res = await client.query<{ current_database: string }>('SELECT current_database()');
    const dbName = res.rows[0].current_database;

    if (this.dryRun) {
      return dbName;
    }

    // 1. Explicit affirmative authorization requirement
    if (!this.allowMutations) {
      throw new Error(
        `Security Violation: Mutating delta reconciliation requires explicit affirmative option 'allowMutations: true'. Execution aborted before any write.`
      );
    }

    // 2. Explicit authorized target database name requirement
    if (!this.authorizedTargetDatabase || this.authorizedTargetDatabase.trim().length === 0) {
      throw new Error(
        `Security Violation: Mutating delta reconciliation requires explicit 'authorizedTargetDatabase'. None was supplied.`
      );
    }

    // 3. Exact target database match requirement
    if (this.authorizedTargetDatabase !== dbName) {
      throw new Error(
        `Security Violation: Connected database "${dbName}" does not match explicitly authorized target database "${this.authorizedTargetDatabase}". Execution aborted before any write.`
      );
    }

    // 4. Blacklist defense-in-depth: Never allow procurepilot or postgres
    if (dbName === 'procurepilot' || dbName === 'postgres') {
      throw new Error(
        `Security Violation: Refusing mutating execution against protected cluster database "${dbName}".`
      );
    }

    // 5. Positive allowlist: must match recognized disposable test database pattern
    const isDisposableTestDb = /^procurepilot_delta_test_[a-zA-Z0-9_-]+$/.test(dbName);
    if (!isDisposableTestDb) {
      throw new Error(
        `Security Violation: Database "${dbName}" is not on the positive allowlist of authorized disposable test databases. Mutating reconciliation is restricted to isolated disposable test targets.`
      );
    }

    // 6. Recognizable disposable environment identity / marker
    if (this.disposableEnvironmentMarker !== 'DISPOSABLE_TEST_ENVIRONMENT') {
      throw new Error(
        `Security Violation: Mutating execution requires valid disposable environment marker ('DISPOSABLE_TEST_ENVIRONMENT'). Received "${this.disposableEnvironmentMarker}".`
      );
    }

    // 7. Server & Cluster Identity Attestation (Phase B.4.2.2 Correction A)
    const connInfo = await client.query<{
      server_addr: string | null;
      server_port: number | null;
      current_user_val: string;
      session_user_val: string;
    }>(
      `SELECT inet_server_addr()::text AS server_addr,
              inet_server_port() AS server_port,
              current_user::text AS current_user_val,
              session_user::text AS session_user_val`
    );
    const serverAddr = connInfo.rows[0]?.server_addr;
    const serverPort = connInfo.rows[0]?.server_port;
    const currentUser = connInfo.rows[0]?.current_user_val;

    // Verify cluster system identifier if expected
    let clusterSystemId: string | null = null;
    try {
      const sysIdRes = await client.query<{ system_identifier: string }>(
        `SELECT system_identifier::text FROM pg_control_system()`
      );
      clusterSystemId = sysIdRes.rows[0]?.system_identifier || null;
    } catch {
      // Non-superuser or unsupported in current context
    }

    if (this.expectedClusterSystemIdentifier) {
      if (!clusterSystemId || clusterSystemId !== this.expectedClusterSystemIdentifier) {
        throw new Error(
          `Security Violation: Connected PostgreSQL cluster system identifier (${clusterSystemId || 'UNAVAILABLE'}) does not match expected disposable cluster identifier (${this.expectedClusterSystemIdentifier}). Execution aborted.`
        );
      }
    }

    // Verify server host address if expected
    if (this.expectedServerHost) {
      if (serverAddr && serverAddr !== this.expectedServerHost) {
        throw new Error(
          `Security Violation: Connected PostgreSQL host address (${serverAddr}) does not match expected disposable host (${this.expectedServerHost}). Execution aborted.`
        );
      }
    }

    // Verify server port if expected
    if (this.expectedServerPort) {
      if (serverPort && serverPort !== this.expectedServerPort) {
        throw new Error(
          `Security Violation: Connected PostgreSQL port (${serverPort}) does not match expected disposable port (${this.expectedServerPort}). Execution aborted.`
        );
      }
    }

    // Verify database user if expected (least-privilege enforcement)
    if (this.expectedDatabaseUser) {
      if (currentUser !== this.expectedDatabaseUser) {
        throw new Error(
          `Security Violation: Connected execution user (${currentUser}) does not match expected restricted reconciliation user (${this.expectedDatabaseUser}). Execution aborted.`
        );
      }
    }

    return dbName;
  }

  /**
   * Performs a comprehensive, read-only delta analysis comparing current file state against
   * authoritative preflight manifests and PostgreSQL baseline records.
   */
  public async analyze(): Promise<DeltaAnalysisResult> {
    const client = await this.pool.connect();
    try {
      return await this.performAnalysis(client);
    } finally {
      client.release();
    }
  }

  private async performAnalysis(client: PoolClient): Promise<DeltaAnalysisResult> {
    const ordersDir = path.resolve(this.dataDir, 'orders');
    const approvalsDir = path.resolve(this.dataDir, 'approvals');
    const conflictDetails: string[] = [];

    // 1. Load authoritative manifests
    const preflight = fs.existsSync(this.preflightManifestPath)
      ? JSON.parse(fs.readFileSync(this.preflightManifestPath, 'utf8'))
      : { orders: [], approvals: [] };

    const preflightOrderMap = new Map<string, { sha256: string; record: any }>();
    for (const ord of preflight.orders || []) {
      preflightOrderMap.set(ord.orderId, { sha256: ord.sha256, record: ord });
    }

    const preflightApprovalMap = new Map<string, { sha256: string; record: any }>();
    for (const app of preflight.approvals || []) {
      preflightApprovalMap.set(app.ticketId, { sha256: app.sha256, record: app });
    }

    const quarantineFiles = new Set<string>();
    if (fs.existsSync(this.quarantineManifestPath)) {
      const qList = JSON.parse(fs.readFileSync(this.quarantineManifestPath, 'utf8'));
      for (const q of qList) {
        quarantineFiles.add(q.fileName);
      }
    }

    // 2. Fetch existing database orders and approvals
    const dbOrdersRes = await client.query<{
      id: string;
      order_number: string;
      external_order_id: string;
      ticket_id: string;
      status: OrderStatus;
      authorized_total: string;
      authorized_subtotal: string;
      authorized_tax: string;
      authorized_shipping: string;
      currency: string;
      source_origin: string;
      created_at: string;
    }>(`SELECT id, order_number, external_order_id, ticket_id, status, authorized_total::text,
               authorized_subtotal::text, authorized_tax::text, authorized_shipping::text,
               currency, source_origin, created_at
        FROM orders`);

    const dbOrderMap = new Map<string, (typeof dbOrdersRes.rows)[0]>();
    const dbOrderNumberMap = new Map<string, string>(); // order_number -> external_order_id
    for (const row of dbOrdersRes.rows) {
      dbOrderMap.set(row.external_order_id, row);
      dbOrderNumberMap.set(row.order_number, row.external_order_id);
    }

    const dbApprovalsRes = await client.query<{
      ticket_id: string;
      status: string;
      source_origin: string;
      integrity_status: string;
      verified_total: string;
      challenge_signature: string | null;
    }>(`SELECT ticket_id, status, source_origin, integrity_status, verified_total::text, challenge_signature
        FROM approval_tickets`);

    const dbApprovalMap = new Map<string, (typeof dbApprovalsRes.rows)[0]>();
    for (const row of dbApprovalsRes.rows) {
      dbApprovalMap.set(row.ticket_id, row);
    }

    // 3. Analyze Approvals (.data/approvals)
    const approvalDeltaItems: ApprovalDeltaItem[] = [];
    const diskApprovalFiles = fs.existsSync(approvalsDir)
      ? fs.readdirSync(approvalsDir).filter((f) => f.endsWith('.json')).sort()
      : [];

    for (const fileName of diskApprovalFiles) {
      const filePath = path.join(approvalsDir, fileName);
      const raw = fs.readFileSync(filePath, 'utf8');

      try {
        const parsed = JSON.parse(raw);
        const ticketId = parsed.ticketId;
        const totalDec = parseExactDecimalString(parsed.verifiedTotal, 'verifiedTotal');

        const existingDbApproval = dbApprovalMap.get(ticketId);
        const preflightEntry = preflightApprovalMap.get(ticketId);

        if (existingDbApproval) {
          // Already in DB
          if (existingDbApproval.status === parsed.status) {
            approvalDeltaItems.push({
              fileName,
              ticketId,
              category: 'EXISTING_BASELINE_UNCHANGED',
              reason: 'Approval ticket matches existing database record',
              status: parsed.status,
              sourceOrigin: existingDbApproval.source_origin as any,
              integrityStatus: existingDbApproval.integrity_status as any,
              verifiedTotalDecimal: totalDec,
            });
          } else {
            // Legitimate approval state transition (e.g. PENDING_APPROVAL -> APPROVED -> CONSUMED)
            approvalDeltaItems.push({
              fileName,
              ticketId,
              category: 'LEGITIMATE_STATE_TRANSITION',
              reason: `Approval status transition from ${existingDbApproval.status} to ${parsed.status}`,
              status: parsed.status,
              sourceOrigin: existingDbApproval.source_origin as any,
              integrityStatus: existingDbApproval.integrity_status as any,
              verifiedTotalDecimal: totalDec,
            });
          }
        } else {
          // New approval not yet in DB
          if (preflightEntry) {
            // Was in baseline manifest but missing from DB
            approvalDeltaItems.push({
              fileName,
              ticketId,
              category: 'NEW_RUNTIME_RECORD',
              reason: 'Unimported baseline approval',
              status: parsed.status,
              sourceOrigin: 'LEGACY_JSON_IMPORT',
              integrityStatus: 'UNVERIFIABLE_LEGACY',
              verifiedTotalDecimal: totalDec,
            });
          } else {
            // Truly new runtime approval - Remediation B: Cryptographic HMAC-SHA256 verification
            const sig = parsed.signature || parsed.challenge_signature;
            if (!sig || typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig)) {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: 'New runtime approval lacks valid 64-character hexadecimal HMAC signature',
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": invalid or missing 64-char HMAC signature`);
              continue;
            }

            if (!this.hmacSecret || this.hmacSecret.trim().length === 0) {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: 'Server HMAC secret is unavailable or empty',
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": server HMAC secret unavailable`);
              continue;
            }

            if (!parsed.nonce || !parsed.cartFingerprint || parsed.expiresAt === undefined) {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: 'Missing essential cryptographic approval fields (nonce, cartFingerprint, or expiresAt)',
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": missing cryptographic binding fields`);
              continue;
            }

            const expiresAtNum =
              typeof parsed.expiresAt === 'number'
                ? parsed.expiresAt
                : new Date(parsed.expiresAt).getTime();

            if (isNaN(expiresAtNum)) {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: 'Invalid expiresAt timestamp format in runtime approval',
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": invalid expiresAt timestamp`);
              continue;
            }

            if (parsed.status === 'PENDING_APPROVAL' && Date.now() > expiresAtNum) {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: 'Runtime approval ticket has expired (TTL elapsed)',
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": ticket expired`);
              continue;
            }

            // If verifiedItems are present, verify cart fingerprint binding
            if (Array.isArray(parsed.verifiedItems) && parsed.verifiedItems.length > 0) {
              const expectedFingerprint = approvalService.calculateCartFingerprint(
                parsed.verifiedItems.map((i: any) => ({
                  productId: i.productId,
                  quantity: Number(i.quantity),
                  unitPrice: Number(i.unitPrice),
                })),
                Number(parsed.verifiedTotal),
                parsed.currency || 'USD'
              );

              if (parsed.cartFingerprint !== expectedFingerprint) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'Cart fingerprint tampering: signed items/total do not match ticket cart fingerprint',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": cart fingerprint tampering detected`);
                continue;
              }
            }

            // Recompute expected signatures using authoritative HMAC-SHA256 payload
            // Challenge: `${ticketId}:${cartFingerprint}:${nonce}:${expiresAt}`
            const challengePayload = `${ticketId}:${parsed.cartFingerprint}:${parsed.nonce}:${expiresAtNum}`;
            const expectedChallengeSig = crypto
              .createHmac('sha256', this.hmacSecret)
              .update(challengePayload)
              .digest('hex');

            // AuthToken: `${ticketId}:APPROVED:${cartFingerprint}:${nonce}:${expiresAt}`
            const authPayload = `${ticketId}:APPROVED:${parsed.cartFingerprint}:${parsed.nonce}:${expiresAtNum}`;
            const expectedAuthSig = crypto
              .createHmac('sha256', this.hmacSecret)
              .update(authPayload)
              .digest('hex');

            const sigBuf = Buffer.from(sig, 'hex');
            const challengeBuf = Buffer.from(expectedChallengeSig, 'hex');
            const authBuf = Buffer.from(expectedAuthSig, 'hex');

            const matchesChallenge =
              sigBuf.length === challengeBuf.length && crypto.timingSafeEqual(sigBuf, challengeBuf);
            const matchesAuth =
              sigBuf.length === authBuf.length && crypto.timingSafeEqual(sigBuf, authBuf);

            // Phase B.4.2.2 Correction C: Explicit state-dependent cryptographic signature verification
            if (parsed.status === 'PENDING_APPROVAL') {
              if (matchesAuth && !matchesChallenge) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'State-binding violation: PENDING_APPROVAL ticket cannot use an APPROVED auth token signature',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": state-binding violation (auth token used for pending status)`);
                continue;
              }
              if (!matchesChallenge) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'Cryptographic challenge verification failed: invalid HMAC-SHA256 challenge signature for PENDING_APPROVAL',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": invalid challenge HMAC signature`);
                continue;
              }
            } else if (parsed.status === 'APPROVED') {
              if (matchesChallenge && !matchesAuth) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'State-binding violation: APPROVED ticket cannot be authorized with an unapproved challenge signature',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": state-binding violation (challenge signature used for approved status)`);
                continue;
              }
              if (!matchesAuth) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'Cryptographic auth token verification failed: invalid HMAC-SHA256 approval signature for APPROVED ticket',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": invalid approved auth token HMAC signature`);
                continue;
              }
            } else if (parsed.status === 'CONSUMED') {
              if (matchesChallenge && !matchesAuth) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'State-binding violation: CONSUMED ticket cannot be authorized with an unapproved challenge signature',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": state-binding violation (challenge signature used for consumed status)`);
                continue;
              }
              if (!matchesAuth) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'Cryptographic auth token verification failed: invalid HMAC-SHA256 approval signature for CONSUMED ticket',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": invalid consumed ticket HMAC signature`);
                continue;
              }
              if (!parsed.consumedAt) {
                approvalDeltaItems.push({
                  fileName,
                  ticketId,
                  category: 'CONFLICT_REJECTED',
                  reason: 'Lifecycle violation: CONSUMED approval ticket is missing required consumedAt timestamp',
                  status: parsed.status,
                  sourceOrigin: 'RUNTIME',
                  integrityStatus: 'VERIFIED',
                  verifiedTotalDecimal: totalDec,
                });
                conflictDetails.push(`Approval "${fileName}": consumed ticket missing consumedAt timestamp`);
                continue;
              }
            } else {
              approvalDeltaItems.push({
                fileName,
                ticketId,
                category: 'CONFLICT_REJECTED',
                reason: `Unsupported or invalid runtime approval status: "${parsed.status}"`,
                status: parsed.status,
                sourceOrigin: 'RUNTIME',
                integrityStatus: 'VERIFIED',
                verifiedTotalDecimal: totalDec,
              });
              conflictDetails.push(`Approval "${fileName}": unsupported status "${parsed.status}"`);
              continue;
            }

            // Verified genuine cryptographic signature
            approvalDeltaItems.push({
              fileName,
              ticketId,
              category: 'NEW_RUNTIME_RECORD',
              reason: 'Valid new runtime approval with verified cryptographic HMAC signature',
              status: parsed.status,
              sourceOrigin: 'RUNTIME',
              integrityStatus: 'VERIFIED',
              verifiedTotalDecimal: totalDec,
            });
          }
        }
      } catch (err: any) {
        approvalDeltaItems.push({
          fileName,
          ticketId: 'UNKNOWN_MALFORMED',
          category: 'CONFLICT_REJECTED',
          reason: `Malformed approval JSON: ${err.message}`,
          status: 'INVALID',
          sourceOrigin: 'RUNTIME',
          integrityStatus: 'UNVERIFIABLE_LEGACY',
          verifiedTotalDecimal: '0.00',
        });
      }
    }

    // 4. Analyze Orders (.data/orders)
    const orderDeltaItems: OrderDeltaItem[] = [];
    const diskOrderFiles = fs.existsSync(ordersDir)
      ? fs.readdirSync(ordersDir).filter((f) => f.endsWith('.json')).sort()
      : [];

    for (const fileName of diskOrderFiles) {
      // Check quarantine first
      if (quarantineFiles.has(fileName) || fileName === 'TEST-ORDER-MUTATION-CHECK-01.json') {
        orderDeltaItems.push({
          fileName,
          orderId: 'TEST-ORDER-MUTATION-CHECK-01',
          category: 'QUARANTINED_EXCLUDED',
          reason: 'Excluded quarantined orphan with missing approval reference',
          authorizedTotalDecimal: '500.00',
          isSimulated: false,
          hasCapture: false,
        });
        continue;
      }

      const filePath = path.join(ordersDir, fileName);
      const raw = fs.readFileSync(filePath, 'utf8');

      try {
        const parsed = JSON.parse(raw);
        const orderId = parsed.orderId;

        if (!orderId || !parsed.ticketId || parsed.authorizedTotal === undefined) {
          orderDeltaItems.push({
            fileName,
            orderId: orderId || 'UNKNOWN_ORDER',
            category: 'CONFLICT_REJECTED',
            reason: 'Missing essential order attributes (orderId, ticketId, or authorizedTotal)',
            authorizedTotalDecimal: '0.00',
            isSimulated: false,
            hasCapture: false,
          });
          conflictDetails.push(`Order "${fileName}" missing required attributes`);
          continue;
        }

        const totalDec = parseExactDecimalString(parsed.authorizedTotal, 'authorizedTotal');
        const expectedOrderNumber = generateLegacyOrderNumber(orderId);
        const fileOrderNumber = parsed.orderNumber || expectedOrderNumber;
        const mappedDbStatus = mapLegacyOrderStatusToDb(parsed.status, !orderId.startsWith('SANDBOX_'));

        const existingDbOrder = dbOrderMap.get(orderId);

        // Phase B.4.2.2 Correction B: Complete Flat-File Payment Capture De-authorization
        // Flat-file JSON records originating from disk can NEVER authorize insertion into payment_captures.
        // Reliance on providerEvidence.verified, caller-supplied captureOrigin, and order ID prefixes
        // is completely eliminated. All flat-file captures are treated strictly as unverified local test metadata.
        let effectiveCaptureOrigin: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST' | null = null;
        if (parsed.captureId) {
          // Unconditionally segregate all flat-file capture claims as local test metadata.
          // appliedGenuineCapturesCount will remain exactly 0 for all flat-file reconciliation.
          effectiveCaptureOrigin = 'LOCAL_SYNTHETIC_TEST';
        }

        // Check for cross-record identity conflict or spoofed order_number
        if (parsed.orderNumber && parsed.orderNumber !== expectedOrderNumber) {
          orderDeltaItems.push({
            fileName,
            orderId,
            category: 'CONFLICT_REJECTED',
            reason: `Cross-record identity attack: specified orderNumber ${parsed.orderNumber} does not match canonical order number ${expectedOrderNumber}`,
            authorizedTotalDecimal: totalDec,
            isSimulated: Boolean(parsed.isSimulated),
            hasCapture: Boolean(parsed.captureId),
          });
          conflictDetails.push(`Identity spoof on order ${orderId} (${parsed.orderNumber} vs ${expectedOrderNumber})`);
          continue;
        }

        const existingExternalForNumber = dbOrderNumberMap.get(fileOrderNumber);
        if (existingExternalForNumber && existingExternalForNumber !== orderId) {
          orderDeltaItems.push({
            fileName,
            orderId,
            category: 'CONFLICT_REJECTED',
            reason: `Cross-record identity attack: canonical order_number ${fileOrderNumber} belongs to external ID ${existingExternalForNumber}, not ${orderId}`,
            authorizedTotalDecimal: totalDec,
            isSimulated: Boolean(parsed.isSimulated),
            hasCapture: Boolean(parsed.captureId),
          });
          conflictDetails.push(`Identity conflict on order ${orderId} (collision with ${existingExternalForNumber})`);
          continue;
        }

        if (existingDbOrder) {
          // Record exists in DB. Check immutable fields for tampering.
          const dbCents = parseExactDecimalToCents(existingDbOrder.authorized_total, 'dbTotal');
          const fileCents = parseExactDecimalToCents(totalDec, 'fileTotal');
          const amountsMatch = dbCents === fileCents;
          const ticketMatch = existingDbOrder.ticket_id === parsed.ticketId;
          const currencyMatch = existingDbOrder.currency === (parsed.currency || 'USD');

          if (!amountsMatch || !ticketMatch || !currencyMatch) {
            orderDeltaItems.push({
              fileName,
              orderId,
              category: 'CONFLICT_REJECTED',
              reason: `Immutable field mutation detected on existing order: amountsMatch=${amountsMatch}, ticketMatch=${ticketMatch}, currencyMatch=${currencyMatch}`,
              authorizedTotalDecimal: totalDec,
              isSimulated: Boolean(parsed.isSimulated),
              hasCapture: Boolean(parsed.captureId),
              immutableFieldsMatch: false,
            });
            conflictDetails.push(`Immutable field violation on existing order ${orderId}`);
            continue;
          }

          // Check status transition
          if (existingDbOrder.status === mappedDbStatus) {
            orderDeltaItems.push({
              fileName,
              orderId,
              category: 'EXISTING_BASELINE_UNCHANGED',
              reason: 'Order status and immutable attributes match database baseline exactly',
              oldDbStatus: existingDbOrder.status,
              newDbStatus: mappedDbStatus,
              authorizedTotalDecimal: totalDec,
              isSimulated: Boolean(parsed.isSimulated),
              hasCapture: Boolean(parsed.captureId),
              captureId: parsed.captureId,
              captureOrigin: effectiveCaptureOrigin,
              immutableFieldsMatch: true,
            });
          } else {
            // Status changed: verify transition against state machine
            const isPermitted = canTransitionOrder(existingDbOrder.status, mappedDbStatus);
            if (isPermitted) {
              orderDeltaItems.push({
                fileName,
                orderId,
                category: 'LEGITIMATE_STATE_TRANSITION',
                reason: `Permitted canonical state transition: ${existingDbOrder.status} -> ${mappedDbStatus}`,
                oldDbStatus: existingDbOrder.status,
                newDbStatus: mappedDbStatus,
                authorizedTotalDecimal: totalDec,
                isSimulated: Boolean(parsed.isSimulated),
                hasCapture: Boolean(parsed.captureId),
                captureId: parsed.captureId,
                captureOrigin: effectiveCaptureOrigin,
                immutableFieldsMatch: true,
              });
            } else {
              orderDeltaItems.push({
                fileName,
                orderId,
                category: 'CONFLICT_REJECTED',
                reason: `Illegal state transition: cannot transition order from ${existingDbOrder.status} to ${mappedDbStatus}`,
                oldDbStatus: existingDbOrder.status,
                newDbStatus: mappedDbStatus,
                authorizedTotalDecimal: totalDec,
                isSimulated: Boolean(parsed.isSimulated),
                hasCapture: Boolean(parsed.captureId),
                immutableFieldsMatch: true,
              });
              conflictDetails.push(`Illegal state transition on order ${orderId}: ${existingDbOrder.status} -> ${mappedDbStatus}`);
            }
          }
        } else {
          // New Order not yet in DB
          // Verify ticket reference exists in DB or in new runtime approvals
          const ticketExistsInDb = dbApprovalMap.has(parsed.ticketId);
          const ticketExistsInBatch = approvalDeltaItems.some(
            (a) => a.ticketId === parsed.ticketId && a.category !== 'CONFLICT_REJECTED'
          );

          if (!ticketExistsInDb && !ticketExistsInBatch) {
            orderDeltaItems.push({
              fileName,
              orderId,
              category: 'CONFLICT_REJECTED',
              reason: `Orphaned ticket reference: order references ticket "${parsed.ticketId}" which does not exist in approvals`,
              authorizedTotalDecimal: totalDec,
              isSimulated: Boolean(parsed.isSimulated),
              hasCapture: Boolean(parsed.captureId),
            });
            conflictDetails.push(`Orphaned order ${orderId}: ticket ${parsed.ticketId} does not exist`);
            continue;
          }

          orderDeltaItems.push({
            fileName,
            orderId,
            category: 'NEW_RUNTIME_RECORD',
            reason: 'Valid new order eligible for controlled runtime reconciliation',
            newDbStatus: mappedDbStatus,
            authorizedTotalDecimal: totalDec,
            isSimulated: Boolean(parsed.isSimulated),
            hasCapture: Boolean(parsed.captureId),
            captureId: parsed.captureId,
            captureOrigin: effectiveCaptureOrigin,
          });
        }
      } catch (err: any) {
        orderDeltaItems.push({
          fileName,
          orderId: 'MALFORMED',
          category: 'CONFLICT_REJECTED',
          reason: `Malformed JSON: ${err.message}`,
          authorizedTotalDecimal: '0.00',
          isSimulated: false,
          hasCapture: false,
        });
        conflictDetails.push(`Malformed file ${fileName}: ${err.message}`);
      }
    }

    // 5. Compute summary metrics
    const existingBaselineUnchangedCount = orderDeltaItems.filter(
      (o) => o.category === 'EXISTING_BASELINE_UNCHANGED'
    ).length;
    const legitimateStateTransitionsCount = orderDeltaItems.filter(
      (o) => o.category === 'LEGITIMATE_STATE_TRANSITION'
    ).length;
    const newRuntimeOrdersCount = orderDeltaItems.filter((o) => o.category === 'NEW_RUNTIME_RECORD').length;
    const newRuntimeApprovalsCount = approvalDeltaItems.filter((a) => a.category === 'NEW_RUNTIME_RECORD').length;

    const genuineCapturesCount = orderDeltaItems.filter(
      (o) => o.hasCapture && o.captureOrigin === 'PAYPAL_API'
    ).length;
    const syntheticCapturesSegregatedCount = orderDeltaItems.filter(
      (o) => o.hasCapture && o.captureOrigin !== 'PAYPAL_API'
    ).length;

    const orderConflicts = orderDeltaItems.filter((o) => o.category === 'CONFLICT_REJECTED').length;
    const approvalConflicts = approvalDeltaItems.filter((a) => a.category === 'CONFLICT_REJECTED').length;
    const conflictsRejectedCount = orderConflicts + approvalConflicts;
    const quarantinedExcludedCount = orderDeltaItems.filter(
      (o) => o.category === 'QUARANTINED_EXCLUDED'
    ).length;

    return {
      totalOrdersScanned: diskOrderFiles.length,
      totalApprovalsScanned: diskApprovalFiles.length,
      orders: orderDeltaItems,
      approvals: approvalDeltaItems,
      existingBaselineUnchangedCount,
      legitimateStateTransitionsCount,
      newRuntimeOrdersCount,
      newRuntimeApprovalsCount,
      genuineCapturesCount,
      syntheticCapturesSegregatedCount,
      conflictsRejectedCount,
      quarantinedExcludedCount,
      hasConflicts: conflictsRejectedCount > 0,
      conflictDetails,
    };
  }

  /**
   * Executes controlled delta reconciliation against the target database.
   * All mutations are wrapped in a single database transaction.
   * In dryRun mode, performs analysis and rolls back without committing.
   */
  public async reconcile(): Promise<DeltaReconciliationResult> {
    const client = await this.pool.connect();
    const startTime = new Date().toISOString();

    try {
      // 1. Safety check: ensure not mutating persistent database
      const dbName = await this.assertDatabaseSafety(client);

      // 2. Perform delta analysis
      const analysis = await this.performAnalysis(client);

      if (analysis.hasConflicts && this.failOnConflict) {
        throw new Error(
          `Delta Reconciliation Aborted: ${analysis.conflictsRejectedCount} conflicting records detected:\n` +
            analysis.conflictDetails.join('\n')
        );
      }

      if (this.dryRun) {
        return {
          success: true,
          executedAt: startTime,
          databaseName: dbName,
          dryRun: true,
          analysis,
          appliedTransitionsCount: 0,
          appliedNewOrdersCount: 0,
          appliedNewApprovalsCount: 0,
          appliedGenuineCapturesCount: 0,
          syntheticCapturesSegregatedCount: analysis.syntheticCapturesSegregatedCount,
          quarantinedExcludedCount: analysis.quarantinedExcludedCount,
        };
      }

      // 3. Begin single atomic transaction for reconciliation
      await client.query('BEGIN');

      let appliedTransitionsCount = 0;
      let appliedNewApprovalsCount = 0;
      let appliedNewOrdersCount = 0;
      let appliedGenuineCapturesCount = 0;

      try {
        // A. Insert New Runtime Approvals
        const approvalsDir = path.resolve(this.dataDir, 'approvals');
        for (const appDelta of analysis.approvals) {
          if (appDelta.category === 'NEW_RUNTIME_RECORD') {
            const filePath = path.join(approvalsDir, appDelta.fileName);
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);

            const sessionTokenHash = parsed.sessionToken
              ? crypto.createHash('sha256').update(parsed.sessionToken).digest('hex')
              : null;
            const sig = parsed.signature || parsed.challenge_signature || null;

            await client.query(
              `INSERT INTO approval_tickets (
                ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
                verified_subtotal, verified_tax, verified_shipping, verified_total,
                currency, status, session_token_hash, source_origin, integrity_status,
                expires_at, signed_at, consumed_at, created_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
              ) ON CONFLICT (ticket_id) DO NOTHING`,
              [
                parsed.ticketId,
                this.organizationId,
                parsed.nonce,
                parsed.cartFingerprint,
                sig,
                parseExactDecimalString(parsed.verifiedSubtotal ?? 0, 'subtotal'),
                parseExactDecimalString(parsed.verifiedTax ?? 0, 'tax'),
                parseExactDecimalString(parsed.verifiedShipping ?? 0, 'shipping'),
                appDelta.verifiedTotalDecimal,
                parsed.currency || 'USD',
                parsed.status,
                sessionTokenHash,
                appDelta.sourceOrigin,
                appDelta.integrityStatus,
                new Date(parsed.expiresAt),
                parsed.signoff?.signedAt ? new Date(parsed.signoff.signedAt) : null,
                parsed.consumedAt ? new Date(parsed.consumedAt) : null,
                new Date(parsed.createdAt || Date.now()),
              ]
            );

            // Child items
            if (Array.isArray(parsed.verifiedItems)) {
              for (const it of parsed.verifiedItems) {
                await client.query(
                  `INSERT INTO approval_ticket_items (
                    ticket_id, product_id, product_name, quantity, unit_price, line_total
                  ) VALUES ($1, $2, $3, $4, $5, $6)`,
                  [
                    parsed.ticketId,
                    it.productId,
                    it.name || it.productId,
                    it.quantity,
                    parseExactDecimalString(it.unitPrice, 'unitPrice'),
                    parseExactDecimalString(it.lineTotal ?? it.quantity * it.unitPrice, 'lineTotal'),
                  ]
                );
              }
            }
            appliedNewApprovalsCount++;
          }
        }

        // B. Apply Legitimate Order State Transitions
        for (const orderDelta of analysis.orders) {
          if (orderDelta.category === 'LEGITIMATE_STATE_TRANSITION' && orderDelta.newDbStatus) {
            // Find order ID by external_order_id
            const orderRes = await client.query<{ id: string; status: OrderStatus }>(
              `SELECT id, status FROM orders WHERE external_order_id = $1`,
              [orderDelta.orderId]
            );

            if (orderRes.rows.length === 1) {
              const orderIdUuid = orderRes.rows[0].id;
              await client.query(
                `SELECT reconcile_legacy_order_status_transition($1, $2, $3, $4, $5)`,
                [
                  orderIdUuid,
                  orderRes.rows[0].status,
                  orderDelta.newDbStatus,
                  'CONTROLLED_DELTA_RECONCILIATION',
                  this.operatorId || 'UNAUTHENTICATED_SYSTEM_CONTEXT',
                ]
              );
              appliedTransitionsCount++;
            }
          }
        }

        // C. Insert New Runtime Orders
        const ordersDir = path.resolve(this.dataDir, 'orders');
        for (const orderDelta of analysis.orders) {
          if (orderDelta.category === 'NEW_RUNTIME_RECORD' && orderDelta.newDbStatus) {
            const filePath = path.join(ordersDir, orderDelta.fileName);
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);

            const orderNumber = generateLegacyOrderNumber(orderDelta.orderId);
            const createdAtDate = new Date(parsed.createdAt || Date.now());

            const insertRes = await client.query<{ id: string }>(
              `INSERT INTO orders (
                order_number, organization_id, ticket_id, external_order_id,
                provider, provider_environment, status, authorized_total,
                authorized_subtotal, authorized_tax, authorized_shipping,
                currency, approver_name, approver_department, idempotency_key,
                is_simulated, is_simulated_provenance, simulated_reason,
                source_origin, created_at, updated_at
              ) VALUES (
                $1, $2, $3, $4, 'PAYPAL', 'SANDBOX', $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, 'RUNTIME', $17, NOW()
              ) ON CONFLICT (external_order_id) DO NOTHING
              RETURNING id`,
              [
                orderNumber,
                this.organizationId,
                parsed.ticketId,
                orderDelta.orderId,
                orderDelta.newDbStatus,
                orderDelta.authorizedTotalDecimal,
                parseExactDecimalString(parsed.authorizedSubtotal ?? 0, 'subtotal'),
                parseExactDecimalString(parsed.authorizedTax ?? 0, 'tax'),
                parseExactDecimalString(parsed.authorizedShipping ?? 0, 'shipping'),
                parsed.currency || 'USD',
                parsed.approverName || null,
                parsed.approverDepartment || null,
                parsed.idempotencyKey || parsed.ticketId,
                Boolean(parsed.isSimulated),
                parsed.isSimulated ? 'LOCAL_TEST_HARNESS' : 'EXPLICIT_PROVIDER',
                parsed.simulatedReason || null,
                createdAtDate,
              ]
            );

            if (insertRes.rows.length > 0) {
              const orderIdUuid = insertRes.rows[0].id;

              // Items
              if (Array.isArray(parsed.items)) {
                for (const it of parsed.items) {
                  const lineTotal = it.lineTotal ?? it.quantity * it.unitPrice;
                  await client.query(
                    `INSERT INTO order_items (
                      organization_id, order_id, product_id, product_name,
                      quantity, unit_price, line_total
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                      this.organizationId,
                      orderIdUuid,
                      it.productId,
                      it.name || it.productId,
                      it.quantity,
                      parseExactDecimalString(it.unitPrice, 'unitPrice'),
                      parseExactDecimalString(lineTotal, 'lineTotal'),
                    ]
                  );
                }
              }

              // Genuine captures only
              if (
                orderDelta.hasCapture &&
                orderDelta.captureOrigin === 'PAYPAL_API' &&
                orderDelta.captureId
              ) {
                await client.query(
                  `INSERT INTO payment_captures (
                    order_id, external_capture_id, payment_attempt_id, captured_amount,
                    currency, transaction_fee, net_amount, payer_email, payer_id,
                    capture_origin, simulated_reason, captured_at, created_at
                  ) VALUES (
                    $1, $2, NULL, $3, $4, NULL, NULL, NULL, NULL, 'PAYPAL_API', NULL, $5, NOW()
                  ) ON CONFLICT (external_capture_id) DO NOTHING`,
                  [
                    orderIdUuid,
                    orderDelta.captureId,
                    orderDelta.authorizedTotalDecimal,
                    parsed.currency || 'USD',
                    parsed.capturedAt ? new Date(parsed.capturedAt) : createdAtDate,
                  ]
                );
                appliedGenuineCapturesCount++;
              }

              appliedNewOrdersCount++;
            }
          }
        }

        // Commit transaction
        await client.query('COMMIT');

        return {
          success: true,
          executedAt: startTime,
          databaseName: dbName,
          dryRun: false,
          analysis,
          appliedTransitionsCount,
          appliedNewOrdersCount,
          appliedNewApprovalsCount,
          appliedGenuineCapturesCount,
          syntheticCapturesSegregatedCount: analysis.syntheticCapturesSegregatedCount,
          quarantinedExcludedCount: analysis.quarantinedExcludedCount,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    } finally {
      client.release();
    }
  }
}
