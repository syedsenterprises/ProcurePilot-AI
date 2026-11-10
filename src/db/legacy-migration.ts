import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import assert from 'node:assert';
import { Client, PoolClient } from 'pg';
import { db } from './pool';
import { runPreflightInspection, QuarantineRecord, parseExactDecimalToCents } from './legacy-preflight';
import { mapLegacyOrderStatusToDb } from './order-state-machine';

export const SEED_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';

export interface ExcludedApprovalRecord {
  ticketId: string;
  fileName: string;
  reason: 'MISSING_SOURCE_SIGNATURE' | 'MALFORMED_SOURCE_SIGNATURE';
  rawSignature?: string | null;
}

export interface ExcludedOrderRecord {
  orderId: string;
  ticketId: string;
  fileName: string;
  reason: string;
}

export interface ExcludedSyntheticCaptureRecord {
  orderId: string;
  captureId: string;
  captureOrigin: string;
  reason: string;
}

export interface CorrectiveMigrationSummary {
  executedAt: string;
  seedOrganizationId: string;
  // Approval tickets
  approvalsScanned: number;
  approvalsMigrated: number;
  approvalItemsMigrated: number;
  approvalsExcluded: number;
  approvalsExcludedMissingSignature: number;
  approvalsExcludedMalformedSignature: number;
  // Orders
  ordersScanned: number;
  ordersMigrated: number;
  orderItemsMigrated: number;
  ordersQuarantinedOrphan: number;
  ordersExcludedUnresolvedDependency: number;
  // Captures
  genuineCapturesMigrated: number;
  genuineCapturedAmount: string;
  syntheticCapturesExcluded: number;
  totalCapturesInDb: number;
  // Financial totals for successfully migrated records
  migratedAuthorizedTotal: string;
  migratedGenuineTotal: string;
  migratedSimulationTotal: string;
  // Blocker Status
  schemaBlockerIdentified: boolean;
  blockerDetails: string | null;
}

export function generateLegacyOrderNumber(orderId: string): string {
  const sanitized = orderId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const candidate = `LEGACY-ORD-${sanitized}`;
  if (candidate.length <= 32) {
    return candidate;
  }
  const shortCandidate = `LEG-${sanitized}`;
  if (shortCandidate.length <= 32) {
    return shortCandidate;
  }
  const hash = crypto.createHash('sha256').update(orderId).digest('hex').slice(0, 16);
  return `LEG-${hash}`;
}

export async function runLegacyMigration(options: {
  client?: PoolClient | Client;
  baseDir?: string;
  organizationId?: string;
  hmacSecret?: string;
  allowSignatureBackfill?: boolean; // STRICTLY FALSE BY DEFAULT PER PHASE 1B.2.1.1
} = {}): Promise<{
  summary: CorrectiveMigrationSummary;
  quarantined: QuarantineRecord[];
  excludedApprovals: ExcludedApprovalRecord[];
  excludedOrders: ExcludedOrderRecord[];
  excludedSyntheticCaptures: ExcludedSyntheticCaptureRecord[];
}> {
  const baseDir = options.baseDir || process.cwd();
  const organizationId = options.organizationId || SEED_ORGANIZATION_ID;
  const allowSignatureBackfill = Boolean(options.allowSignatureBackfill);
  const secret =
    options.hmacSecret ||
    process.env.APPROVAL_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    undefined;

  // 1. Run Preflight Inspection (non-mutating, manifest hashes preserved)
  const { manifest, quarantine } = runPreflightInspection(baseDir);

  const performMigration = async (client: PoolClient | Client) => {
    // 2. Ensure Seed Organization exists
    await client.query(
      `INSERT INTO organizations (id, name, slug, currency, created_at, updated_at)
       VALUES ($1, 'Default Enterprise Tenant', 'default-enterprise', 'USD', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [organizationId]
    );

    // 3. Migrate Approval Tickets & Items with STRICT Signature Preservation
    const approvalsDir = path.resolve(baseDir, '.data', 'approvals');
    let approvalItemsCount = 0;
    let approvalsMigratedCount = 0;
    const importedApprovalTicketIds = new Set<string>();

    const excludedApprovals: ExcludedApprovalRecord[] = [];

    for (const appRecord of manifest.approvals) {
      const filePath = path.join(approvalsDir, appRecord.fileName);
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);

      // Check 1: Read source signature directly from original approval JSON without trimming
      const sourceSignature: string | null =
        typeof parsed.signature === 'string' && parsed.signature.length > 0
          ? parsed.signature
          : typeof parsed.challenge_signature === 'string' && parsed.challenge_signature.length > 0
          ? parsed.challenge_signature
          : null;

      let finalSignatureToInsert: string | null = null;

      if (sourceSignature) {
        // Format check — if present, must match ^[a-fA-F0-9]{64}$ exactly
        if (!/^[a-fA-F0-9]{64}$/.test(sourceSignature)) {
          excludedApprovals.push({
            ticketId: parsed.ticketId,
            fileName: appRecord.fileName,
            reason: 'MALFORMED_SOURCE_SIGNATURE',
            rawSignature: sourceSignature,
          });
          continue; // EXCLUDE FROM IMPORT
        }

        // Cryptographic verification if historical secret is available
        if (secret) {
          const sigPayload = `${parsed.ticketId}:${parsed.cartFingerprint}:${parsed.nonce}:${parsed.expiresAt}`;
          const expectedHmac = crypto.createHmac('sha256', secret).update(sigPayload).digest('hex');
          if (sourceSignature.toLowerCase() !== expectedHmac.toLowerCase()) {
            console.warn(`[WARN] Cryptographic HMAC mismatch on ticket ${parsed.ticketId}`);
          }
        }

        finalSignatureToInsert = sourceSignature;
      } else {
        // Per Phase 1B.2.1.2 schema extension (Migration 005):
        // Legacy approval tickets lacking source signatures are imported with
        // challenge_signature = NULL, source_origin = 'LEGACY_JSON_IMPORT', and integrity_status = 'UNVERIFIABLE_LEGACY'
        finalSignatureToInsert = null;
      }

      // Hash session token if present
      const sessionTokenHash = parsed.sessionToken
        ? crypto.createHash('sha256').update(parsed.sessionToken).digest('hex')
        : null;

      const expiresAtDate = new Date(parsed.expiresAt);
      const createdAtDate = new Date(parsed.createdAt);
      const signedAtDate = parsed.signoff?.signedAt ? new Date(parsed.signoff.signedAt) : null;
      const consumedAtDate = parsed.consumedAt ? new Date(parsed.consumedAt) : null;

      // Invoke import_legacy_approval_ticket procedure (immutable, non-bypassable migration write path)
      await client.query(
        `SELECT import_legacy_approval_ticket(
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )`,
        [
          parsed.ticketId,
          organizationId,
          parsed.nonce,
          parsed.cartFingerprint,
          finalSignatureToInsert, // Exact source value or NULL verbatim
          parsed.verifiedSubtotal.toFixed(2),
          parsed.verifiedTax.toFixed(2),
          parsed.verifiedShipping.toFixed(2),
          appRecord.verifiedTotalDecimal,
          parsed.currency || 'USD',
          parsed.status || 'PENDING_APPROVAL',
          sessionTokenHash,
          parsed.signoff?.userName || null,
          parsed.signoff?.department || null,
          parsed.signoff?.purchaseJustification || null,
          parsed.signoff?.identityTier || 'SELF_ATTESTED_REQUISITIONER',
          expiresAtDate,
          signedAtDate,
          consumedAtDate,
          createdAtDate,
        ]
      );

      // Verify stored provenance invariants
      const verifyRow = await client.query<{ challenge_signature: string | null; source_origin: string; integrity_status: string }>(
        `SELECT challenge_signature, source_origin, integrity_status FROM approval_tickets WHERE ticket_id = $1`,
        [parsed.ticketId]
      );
      assert.strictEqual(
        verifyRow.rows[0].challenge_signature,
        finalSignatureToInsert,
        `Stored challenge_signature must equal source value byte-for-byte for ${parsed.ticketId}`
      );
      assert.strictEqual(verifyRow.rows[0].source_origin, 'LEGACY_JSON_IMPORT');
      assert.strictEqual(verifyRow.rows[0].integrity_status, 'UNVERIFIABLE_LEGACY');

      importedApprovalTicketIds.add(parsed.ticketId);
      approvalsMigratedCount++;

      // Child Items: imported through controlled procedure under legacy importer context
      const existingItemsRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM approval_ticket_items WHERE ticket_id = $1`,
        [parsed.ticketId]
      );
      const existingItemCount = parseInt(existingItemsRes.rows[0].count, 10);
      if (existingItemCount === 0) {
        if (Array.isArray(parsed.verifiedItems)) {
          for (const it of parsed.verifiedItems) {
            const lineTotal = it.lineTotal !== undefined ? it.lineTotal : it.quantity * it.unitPrice;
            await client.query(
              `SELECT import_legacy_approval_ticket_item($1, $2, $3, $4, $5, $6)`,
              [
                parsed.ticketId,
                it.productId,
                it.name,
                it.quantity,
                it.unitPrice.toFixed(2),
                lineTotal.toFixed(2),
              ]
            );
            approvalItemsCount++;
          }
        }
      } else {
        approvalItemsCount += existingItemCount;
      }
    }

    // 4. Migrate Orders, Order Items & Payment Captures
    const ordersDir = path.resolve(baseDir, '.data', 'orders');
    let orderItemsCount = 0;
    let ordersMigratedCount = 0;
    let genuineCapturesMigrated = 0;
    let genuineCapturedCents = 0;
    let migratedTotalCents = 0;
    let migratedGenuineCents = 0;
    let migratedSimCents = 0;

    const excludedOrders: ExcludedOrderRecord[] = [];
    const excludedSyntheticCaptures: ExcludedSyntheticCaptureRecord[] = [];

    for (const orderRecord of manifest.orders) {
      // Check foreign key prerequisite: approval ticket must exist in database
      if (!importedApprovalTicketIds.has(orderRecord.ticketId)) {
        excludedOrders.push({
          orderId: orderRecord.orderId,
          ticketId: orderRecord.ticketId,
          fileName: orderRecord.fileName,
          reason: `UNRESOLVED_APPROVAL_TICKET_DEPENDENCY: Referenced ticketId "${orderRecord.ticketId}" was excluded from import due to missing source signature. Foreign key fk_orders_org_ticket precludes insertion.`,
        });
        continue; // Exclude order to prevent broken foreign key (Error 23503)
      }

      const filePath = path.join(ordersDir, orderRecord.fileName);
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);

      const orderNumber = generateLegacyOrderNumber(orderRecord.orderId);
      const createdAtDate = new Date(parsed.createdAt);
      const capturedAtDate = parsed.capturedAt ? new Date(parsed.capturedAt) : null;
      const orderDbStatus = mapLegacyOrderStatusToDb(parsed.status, orderRecord.isGenuineProviderOrder);

      // Invoke import_legacy_order procedure (immutable, non-bypassable migration write path)
      const orderInsertRes = await client.query<{ id: string }>(
        `SELECT import_legacy_order(
          $1, $2, $3, $4, 'PAYPAL', 'SANDBOX', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        ) AS id`,
        [
          orderNumber,
          organizationId,
          orderRecord.ticketId,
          orderRecord.orderId,
          orderDbStatus,
          orderRecord.authorizedTotalDecimal,
          orderRecord.authorizedSubtotalStr,
          orderRecord.authorizedTaxStr,
          orderRecord.authorizedShippingStr,
          orderRecord.currency || 'USD',
          orderRecord.approverName,
          orderRecord.approverDepartment,
          parsed.idempotencyKey || orderRecord.ticketId,
          orderRecord.isSimulated,
          orderRecord.isSimulatedProvenance,
          orderRecord.simulatedReason,
          createdAtDate,
          capturedAtDate || createdAtDate,
        ]
      );
      const orderIdUuid = orderInsertRes.rows[0].id;

      ordersMigratedCount++;

      const totalCents = parseExactDecimalToCents(orderRecord.authorizedTotalDecimal, 'authorizedTotal');
      migratedTotalCents += totalCents;
      if (orderRecord.isGenuineProviderOrder) {
        migratedGenuineCents += totalCents;
      } else {
        migratedSimCents += totalCents;
      }

      // Child Order Items: imported through controlled procedure under legacy importer context
      const existingOrderItemsRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
        [orderIdUuid]
      );
      const existingOrderItemCount = parseInt(existingOrderItemsRes.rows[0].count, 10);
      if (existingOrderItemCount === 0) {
        if (Array.isArray(parsed.items)) {
          for (const it of parsed.items) {
            const lineTotal = it.lineTotal !== undefined ? it.lineTotal : it.quantity * it.unitPrice;
            await client.query(
              `SELECT import_legacy_order_item($1, $2, $3, $4, $5, $6, $7)`,
              [
                organizationId,
                orderIdUuid,
                it.productId,
                it.name,
                it.quantity,
                it.unitPrice.toFixed(2),
                lineTotal.toFixed(2),
              ]
            );
            orderItemsCount++;
          }
        }
      } else {
        orderItemsCount += existingOrderItemCount;
      }

      // Payment Captures: MANDATORY SYNTHETIC EXCLUSION
      // Genuine provider settlements ONLY. All synthetic captures (CAP_SANDBOX_STAGE2_*) strictly excluded.
      if (orderRecord.hasExternalCapture && orderRecord.captureId) {
        if (orderRecord.captureOrigin === 'PAYPAL_API') {
          await client.query(
            `INSERT INTO payment_captures (
              order_id, external_capture_id, payment_attempt_id, captured_amount,
              currency, transaction_fee, net_amount, payer_email, payer_id,
              capture_origin, simulated_reason, captured_at, created_at
            ) VALUES (
              $1, $2, NULL, $3, $4, NULL, NULL, NULL, NULL, 'PAYPAL_API', NULL, $5, $6
            ) ON CONFLICT (external_capture_id) DO NOTHING`,
            [
              orderIdUuid,
              orderRecord.captureId,
              orderRecord.authorizedTotalDecimal,
              orderRecord.currency || 'USD',
              capturedAtDate,
              capturedAtDate || createdAtDate,
            ]
          );
          genuineCapturesMigrated++;
          genuineCapturedCents += parseExactDecimalToCents(orderRecord.authorizedTotalDecimal, 'genuineCapture');
        } else {
          // Synthetic capture strictly excluded from payment_captures ledger
          excludedSyntheticCaptures.push({
            orderId: orderRecord.orderId,
            captureId: orderRecord.captureId,
            captureOrigin: orderRecord.captureOrigin || 'LOCAL_SYNTHETIC_TEST',
            reason: 'SYNTHETIC_SANDBOX_CAPTURE_EXCLUDED_FROM_LEDGER',
          });
        }
      }
    }

    const schemaBlockerIdentified = excludedApprovals.length > 0;
    const blockerDetails = schemaBlockerIdentified
      ? `Migration 005 resolves the legacy provenance schema extension. However, ${excludedApprovals.length} approval records were excluded due to malformed signatures.`
      : null;

    const summary: CorrectiveMigrationSummary = {
      executedAt: new Date().toISOString(),
      seedOrganizationId: organizationId,
      approvalsScanned: manifest.totalApprovalsScanned,
      approvalsMigrated: approvalsMigratedCount,
      approvalItemsMigrated: approvalItemsCount,
      approvalsExcluded: excludedApprovals.length,
      approvalsExcludedMissingSignature: excludedApprovals.filter((a) => a.reason === 'MISSING_SOURCE_SIGNATURE').length,
      approvalsExcludedMalformedSignature: excludedApprovals.filter((a) => a.reason === 'MALFORMED_SOURCE_SIGNATURE').length,
      ordersScanned: manifest.totalOrdersScanned,
      ordersMigrated: ordersMigratedCount,
      orderItemsMigrated: orderItemsCount,
      ordersQuarantinedOrphan: manifest.quarantinedOrdersCount,
      ordersExcludedUnresolvedDependency: excludedOrders.length,
      genuineCapturesMigrated,
      genuineCapturedAmount: (genuineCapturedCents / 100).toFixed(2),
      syntheticCapturesExcluded: manifest.localSyntheticCapturesCount,
      totalCapturesInDb: genuineCapturesMigrated,
      migratedAuthorizedTotal: (migratedTotalCents / 100).toFixed(2),
      migratedGenuineTotal: (migratedGenuineCents / 100).toFixed(2),
      migratedSimulationTotal: (migratedSimCents / 100).toFixed(2),
      schemaBlockerIdentified,
      blockerDetails,
    };

    return {
      summary,
      quarantined: quarantine,
      excludedApprovals,
      excludedOrders,
      excludedSyntheticCaptures,
    };
  };

  if (options.client) {
    return performMigration(options.client);
  }

  return db.withTransaction(async (client) => {
    return performMigration(client);
  });
}

// CLI Execution Entrypoint
if (require.main === module) {
  runLegacyMigration()
    .then(({ summary, quarantined, excludedApprovals, excludedOrders, excludedSyntheticCaptures }) => {
      // Write corrective summary to a dedicated new summary file WITHOUT touching existing manifests
      const summaryPath = path.resolve(process.cwd(), 'migration-corrective-rehearsal-summary.json');
      fs.writeFileSync(
        summaryPath,
        JSON.stringify(
          {
            summary,
            quarantined,
            excludedApprovalsSummary: {
              count: excludedApprovals.length,
              sample: excludedApprovals.slice(0, 5),
            },
            excludedOrdersSummary: {
              count: excludedOrders.length,
              sample: excludedOrders.slice(0, 5),
            },
            excludedSyntheticCapturesSummary: {
              count: excludedSyntheticCaptures.length,
              sample: excludedSyntheticCaptures.slice(0, 5),
            },
          },
          null,
          2
        ),
        'utf8'
      );

      console.log('================================================================');
      console.log('ProcurePilot AI — Phase 1B.2.1.1 Corrective Migration Rehearsal');
      console.log('================================================================');
      console.log(`Executed At:                         ${summary.executedAt}`);
      console.log(`Seed Organization ID:                ${summary.seedOrganizationId}`);
      console.log('----------------------------------------------------------------');
      console.log(`Approvals Scanned:                  ${summary.approvalsScanned}`);
      console.log(`  ✓ Approvals Migrated (Verbatim):   ${summary.approvalsMigrated}`);
      console.log(`  ✗ Approvals Excluded (No Sig):     ${summary.approvalsExcludedMissingSignature}`);
      console.log('----------------------------------------------------------------');
      console.log(`Orders Scanned:                     ${summary.ordersScanned}`);
      console.log(`  ✓ Orders Migrated:                 ${summary.ordersMigrated}`);
      console.log(`  ✗ Orders Quarantined (Orphan):     ${summary.ordersQuarantinedOrphan}`);
      console.log(`  ✗ Orders Excluded (No Ticket FK):  ${summary.ordersExcludedUnresolvedDependency}`);
      console.log('----------------------------------------------------------------');
      console.log(`Payment Captures in Ledger:         ${summary.totalCapturesInDb}`);
      console.log(`  ✓ Genuine PayPal Captures:         ${summary.genuineCapturesMigrated} ($${summary.genuineCapturedAmount})`);
      console.log(`  ✗ Synthetic Captures Excluded:     ${summary.syntheticCapturesExcluded}`);
      console.log('----------------------------------------------------------------');
      console.log(`Schema Blocker Identified:          ${summary.schemaBlockerIdentified}`);
      if (summary.blockerDetails) {
        console.log(`Blocker Details:                    ${summary.blockerDetails}`);
      }
      console.log('----------------------------------------------------------------');
      console.log(`Corrective summary written to:      ${summaryPath}`);
      console.log('================================================================');
    })
    .catch((err) => {
      console.error('Corrective migration execution failed:', err);
      process.exit(1);
    });
}
