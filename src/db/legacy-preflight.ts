import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { OrderStatus } from './repositories/types';
import { mapLegacyOrderStatusToDb } from './order-state-machine';

export interface PreflightFileRecord {
  fileName: string;
  filePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface PreflightOrderRecord extends PreflightFileRecord {
  orderId: string;
  ticketId: string;
  rawStatus: string;
  dbStatus: OrderStatus;
  authorizedTotalStr: string;
  authorizedTotalDecimal: string;
  authorizedSubtotalStr: string;
  authorizedTaxStr: string;
  authorizedShippingStr: string;
  currency: string;
  approverName: string | null;
  approverDepartment: string | null;
  isSimulated: boolean | null;
  isSimulatedProvenance: 'EXPLICIT_PROVIDER' | 'LOCAL_TEST_HARNESS' | 'UNKNOWN_LEGACY_IMPORT' | 'SOURCE_MISSING_NULL';
  simulatedReason: string | null;
  isGenuineProviderOrder: boolean;
  hasExternalCapture: boolean;
  captureId: string | null;
  captureOrigin: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST' | null;
  capturedAt: string | null;
  itemCount: number;
}

export interface PreflightApprovalRecord extends PreflightFileRecord {
  ticketId: string;
  status: string;
  nonce: string;
  cartFingerprint: string;
  verifiedTotalStr: string;
  verifiedTotalDecimal: string;
  currency: string;
  expiresAtMs: number;
  isExpired: boolean;
  hasSignoff: boolean;
  approverName: string | null;
  approverDepartment: string | null;
}

export interface QuarantineRecord {
  fileName: string;
  filePath: string;
  category: 'ORPHANED_APPROVAL_REFERENCE' | 'MALFORMED_JSON' | 'EXCESS_MONETARY_PRECISION' | 'INVALID_STATUS';
  reason: string;
  authorizedTotal?: string;
  rawContentSnippet: string;
}

export interface PreflightManifest {
  generatedAt: string;
  // Order counts
  totalOrdersScanned: number;
  validOrdersCount: number;
  quarantinedOrdersCount: number;
  validGenuineOrdersCount: number;
  validSimulationOrdersCount: number;
  // Captures
  paypalRealCapturesCount: number;
  localSyntheticCapturesCount: number;
  // Approvals
  totalApprovalsScanned: number;
  validApprovalsCount: number;
  quarantinedApprovalsCount: number;
  // Monetary sums (exact decimal strings)
  aggregateAuthorizedTotal: string;
  aggregateGenuineTotal: string;
  aggregateSimulationTotal: string;
  quarantinedTotal: string;
  // Detailed lists
  orders: PreflightOrderRecord[];
  approvals: PreflightApprovalRecord[];
}

export function parseExactDecimalString(rawNum: unknown, fieldName: string): string {
  if (typeof rawNum === 'number') {
    const str = rawNum.toString();
    const parts = str.split('.');
    if (parts.length === 2 && parts[1].length > 2) {
      throw new Error(`Excess monetary precision in ${fieldName}: ${str} (Maximum 2 decimal places allowed)`);
    }
    return rawNum.toFixed(2);
  }
  if (typeof rawNum === 'string') {
    if (!/^\d+(\.\d{1,2})?$/.test(rawNum)) {
      throw new Error(`Malformed monetary string format in ${fieldName}: ${rawNum}`);
    }
    const num = parseFloat(rawNum);
    return num.toFixed(2);
  }
  throw new Error(`Invalid non-numeric value for monetary field ${fieldName}: ${String(rawNum)}`);
}

/**
 * Converts a monetary string or number directly into integer cents without binary floating-point roundoff.
 * Rejects values with excess precision (>2 decimal places, e.g. 1.005 or 2.675), malformed formats,
 * and numbers beyond the safe integer range.
 */
export function parseExactDecimalToCents(rawNum: unknown, fieldName = 'amount'): number {
  if (rawNum === null || rawNum === undefined) {
    throw new Error(`Monetary value cannot be null or undefined for ${fieldName}`);
  }
  const str = (typeof rawNum === 'number' ? rawNum.toString() : String(rawNum)).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Malformed monetary string format in ${fieldName}: ${str}`);
  }
  const parts = str.split('.');
  if (parts.length === 2 && parts[1].length > 2) {
    throw new Error(`Excess monetary precision in ${fieldName}: ${str} (Maximum 2 decimal places allowed)`);
  }
  const isNegative = parts[0].startsWith('-');
  const intPart = BigInt(parts[0]);
  let cents = BigInt(0);
  if (parts.length === 2) {
    const frac = parts[1];
    if (frac.length === 1) cents = BigInt(frac) * BigInt(10);
    else if (frac.length === 2) cents = BigInt(frac);
  }
  const totalCents = isNegative ? (intPart * BigInt(100) - cents) : (intPart * BigInt(100) + cents);
  if (totalCents > BigInt(Number.MAX_SAFE_INTEGER) || totalCents < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Monetary value beyond safe integer range in ${fieldName}: ${str}`);
  }
  return Number(totalCents);
}

export function runPreflightInspection(
  baseDir = process.cwd()
): {
  manifest: PreflightManifest;
  quarantine: QuarantineRecord[];
  simulatedManifest: PreflightOrderRecord[];
} {
  const ordersDir = path.resolve(baseDir, '.data', 'orders');
  const approvalsDir = path.resolve(baseDir, '.data', 'approvals');

  const validApprovals: PreflightApprovalRecord[] = [];
  const validOrders: PreflightOrderRecord[] = [];
  const quarantine: QuarantineRecord[] = [];
  const simulatedOrders: PreflightOrderRecord[] = [];

  const approvalTicketIds = new Set<string>();

  // 1. Scan and inspect .data/approvals
  if (fs.existsSync(approvalsDir)) {
    const approvalFiles = fs.readdirSync(approvalsDir).filter((f) => f.endsWith('.json')).sort();

    for (const fileName of approvalFiles) {
      const filePath = path.join(approvalsDir, fileName);
      const raw = fs.readFileSync(filePath, 'utf8');
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      const stat = fs.statSync(filePath);

      try {
        const parsed = JSON.parse(raw);
        if (!parsed.ticketId || !parsed.nonce || !parsed.cartFingerprint) {
          quarantine.push({
            fileName,
            filePath,
            category: 'MALFORMED_JSON',
            reason: 'Missing required approval challenge fields (ticketId, nonce, or cartFingerprint)',
            rawContentSnippet: raw.slice(0, 200),
          });
          continue;
        }

        const verifiedTotalDecimal = parseExactDecimalString(parsed.verifiedTotal, 'verifiedTotal');
        approvalTicketIds.add(parsed.ticketId);

        validApprovals.push({
          fileName,
          filePath,
          sha256,
          sizeBytes: stat.size,
          ticketId: parsed.ticketId,
          status: parsed.status || 'PENDING_APPROVAL',
          nonce: parsed.nonce,
          cartFingerprint: parsed.cartFingerprint,
          verifiedTotalStr: String(parsed.verifiedTotal),
          verifiedTotalDecimal,
          currency: parsed.currency || 'USD',
          expiresAtMs: parsed.expiresAt || 0,
          isExpired: parsed.expiresAt ? Date.now() > parsed.expiresAt : true,
          hasSignoff: Boolean(parsed.signoff),
          approverName: parsed.signoff?.userName || null,
          approverDepartment: parsed.signoff?.department || null,
        });
      } catch (err) {
        quarantine.push({
          fileName,
          filePath,
          category: 'MALFORMED_JSON',
          reason: err instanceof Error ? err.message : 'Unknown JSON parse error',
          rawContentSnippet: raw.slice(0, 200),
        });
      }
    }
  }

  // 2. Scan and inspect .data/orders
  let aggregateTotalCents = 0;
  let aggregateGenuineCents = 0;
  let aggregateSimulationCents = 0;
  let quarantinedCents = 0;

  let paypalRealCaptures = 0;
  let localSyntheticCaptures = 0;
  let validGenuineOrdersCount = 0;
  let validSimulationOrdersCount = 0;

  if (fs.existsSync(ordersDir)) {
    const orderFiles = fs.readdirSync(ordersDir).filter((f) => f.endsWith('.json')).sort();

    for (const fileName of orderFiles) {
      const filePath = path.join(ordersDir, fileName);
      const raw = fs.readFileSync(filePath, 'utf8');
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      const stat = fs.statSync(filePath);

      try {
        const parsed = JSON.parse(raw);
        if (!parsed.orderId || !parsed.ticketId || parsed.authorizedTotal === undefined) {
          quarantine.push({
            fileName,
            filePath,
            category: 'MALFORMED_JSON',
            reason: 'Missing essential order attributes (orderId, ticketId, or authorizedTotal)',
            rawContentSnippet: raw.slice(0, 200),
          });
          continue;
        }

        // Check for orphaned approval reference
        if (!approvalTicketIds.has(parsed.ticketId)) {
          const orphanTotal = parseExactDecimalString(parsed.authorizedTotal, 'authorizedTotal');
          quarantinedCents += parseExactDecimalToCents(orphanTotal, 'quarantinedTotal');
          quarantine.push({
            fileName,
            filePath,
            category: 'ORPHANED_APPROVAL_REFERENCE',
            reason: `Order references ticketId "${parsed.ticketId}" which does not exist in .data/approvals`,
            authorizedTotal: orphanTotal,
            rawContentSnippet: raw.slice(0, 200),
          });
          continue;
        }

        const totalDecimal = parseExactDecimalString(parsed.authorizedTotal, 'authorizedTotal');
        const subtotalDecimal = parseExactDecimalString(parsed.authorizedSubtotal ?? 0, 'authorizedSubtotal');
        const taxDecimal = parseExactDecimalString(parsed.authorizedTax ?? 0, 'authorizedTax');
        const shippingDecimal = parseExactDecimalString(parsed.authorizedShipping ?? 0, 'authorizedShipping');

        const totalCents = parseExactDecimalToCents(totalDecimal, 'authorizedTotal');
        aggregateTotalCents += totalCents;

        // Distinguish genuine PayPal orders from test simulations
        const isGenuineOrder = !parsed.orderId.startsWith('SANDBOX_STAGE2_') && !parsed.orderId.startsWith('TEST-');
        if (isGenuineOrder) {
          validGenuineOrdersCount++;
          aggregateGenuineCents += totalCents;
        } else {
          validSimulationOrdersCount++;
          aggregateSimulationCents += totalCents;
        }

        // Distinguish authentic PayPal captures from synthetic local test stubs
        let captureOrigin: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST' | null = null;
        if (parsed.captureId) {
          if (parsed.captureId.startsWith('CAP_SANDBOX_STAGE2_')) {
            captureOrigin = 'LOCAL_SYNTHETIC_TEST';
            localSyntheticCaptures++;
          } else {
            captureOrigin = 'PAYPAL_API';
            paypalRealCaptures++;
          }
        }

        // Authoritative 12-state canonical status mapping
        const dbStatus = mapLegacyOrderStatusToDb(parsed.status, isGenuineOrder);

        // Simulation metadata provenance
        let isSimulated: boolean | null = null;
        let isSimulatedProvenance: PreflightOrderRecord['isSimulatedProvenance'] = 'SOURCE_MISSING_NULL';
        let simulatedReason: string | null = null;

        if (typeof parsed.isSimulated === 'boolean') {
          isSimulated = parsed.isSimulated;
          isSimulatedProvenance = isSimulated ? 'LOCAL_TEST_HARNESS' : 'EXPLICIT_PROVIDER';
          simulatedReason = parsed.simulatedReason || (isSimulated ? 'TEST_SUITE_MOCK' : null);
        } else if (!isGenuineOrder) {
          isSimulated = true;
          isSimulatedProvenance = 'LOCAL_TEST_HARNESS';
          simulatedReason = 'SYNTHETIC_DEV_TEST_ORDER';
        } else {
          isSimulated = false;
          isSimulatedProvenance = 'EXPLICIT_PROVIDER';
        }

        const orderRecord: PreflightOrderRecord = {
          fileName,
          filePath,
          sha256,
          sizeBytes: stat.size,
          orderId: parsed.orderId,
          ticketId: parsed.ticketId,
          rawStatus: parsed.status,
          dbStatus,
          authorizedTotalStr: String(parsed.authorizedTotal),
          authorizedTotalDecimal: totalDecimal,
          authorizedSubtotalStr: subtotalDecimal,
          authorizedTaxStr: taxDecimal,
          authorizedShippingStr: shippingDecimal,
          currency: parsed.currency || 'USD',
          approverName: parsed.approverName || null,
          approverDepartment: parsed.approverDepartment || null,
          isSimulated,
          isSimulatedProvenance,
          simulatedReason,
          isGenuineProviderOrder: isGenuineOrder,
          hasExternalCapture: Boolean(parsed.captureId),
          captureId: parsed.captureId || null,
          captureOrigin,
          capturedAt: parsed.capturedAt || null,
          itemCount: Array.isArray(parsed.items) ? parsed.items.length : 0,
        };

        if (captureOrigin === 'LOCAL_SYNTHETIC_TEST' || isSimulated) {
          simulatedOrders.push(orderRecord);
        }

        validOrders.push(orderRecord);
      } catch (err) {
        quarantine.push({
          fileName,
          filePath,
          category: 'MALFORMED_JSON',
          reason: err instanceof Error ? err.message : 'Unknown JSON parse error',
          rawContentSnippet: raw.slice(0, 200),
        });
      }
    }
  }

  let generatedAt = new Date().toISOString();
  const existingManifestPath = path.resolve(baseDir, 'migration-preflight-manifest.json');
  if (fs.existsSync(existingManifestPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingManifestPath, 'utf8'));
      if (
        existing.validOrdersCount === validOrders.length &&
        existing.validApprovalsCount === validApprovals.length &&
        existing.aggregateAuthorizedTotal === (aggregateTotalCents / 100).toFixed(2) &&
        existing.generatedAt
      ) {
        generatedAt = existing.generatedAt;
      }
    } catch {
      // Ignore
    }
  }

  const manifest: PreflightManifest = {
    generatedAt,
    totalOrdersScanned: validOrders.length + quarantine.filter((q) => q.filePath.includes('orders')).length,
    validOrdersCount: validOrders.length,
    quarantinedOrdersCount: quarantine.filter((q) => q.filePath.includes('orders')).length,
    validGenuineOrdersCount,
    validSimulationOrdersCount,
    paypalRealCapturesCount: paypalRealCaptures,
    localSyntheticCapturesCount: localSyntheticCaptures,
    totalApprovalsScanned: validApprovals.length + quarantine.filter((q) => q.filePath.includes('approvals')).length,
    validApprovalsCount: validApprovals.length,
    quarantinedApprovalsCount: quarantine.filter((q) => q.filePath.includes('approvals')).length,
    aggregateAuthorizedTotal: (aggregateTotalCents / 100).toFixed(2),
    aggregateGenuineTotal: (aggregateGenuineCents / 100).toFixed(2),
    aggregateSimulationTotal: (aggregateSimulationCents / 100).toFixed(2),
    quarantinedTotal: (quarantinedCents / 100).toFixed(2),
    orders: validOrders,
    approvals: validApprovals,
  };

  return { manifest, quarantine, simulatedManifest: simulatedOrders };
}

// CLI Execution Entrypoint
if (require.main === module) {
  const result = runPreflightInspection();

  const manifestPath = path.resolve(process.cwd(), 'migration-preflight-manifest.json');
  const quarantinePath = path.resolve(process.cwd(), 'migration-quarantine-manifest.json');
  const simulatedPath = path.resolve(process.cwd(), 'migration-simulated-orders-manifest.json');

  fs.writeFileSync(manifestPath, JSON.stringify(result.manifest, null, 2), 'utf8');
  fs.writeFileSync(quarantinePath, JSON.stringify(result.quarantine, null, 2), 'utf8');
  fs.writeFileSync(simulatedPath, JSON.stringify(result.simulatedManifest, null, 2), 'utf8');

  console.log('================================================================');
  console.log('ProcurePilot AI — Legacy Data Preflight Inspection Report');
  console.log('================================================================');
  console.log(`Total Orders Scanned:          ${result.manifest.totalOrdersScanned}`);
  console.log(`  ✓ Valid Orders:              ${result.manifest.validOrdersCount}`);
  console.log(`    - Genuine Provider Orders: ${result.manifest.validGenuineOrdersCount} ($${result.manifest.aggregateGenuineTotal})`);
  console.log(`    - Simulation-Only Orders:  ${result.manifest.validSimulationOrdersCount} ($${result.manifest.aggregateSimulationTotal})`);
  console.log(`  ✗ Quarantined Orders:        ${result.manifest.quarantinedOrdersCount} ($${result.manifest.quarantinedTotal})`);
  console.log(`Total Approvals Scanned:       ${result.manifest.totalApprovalsScanned}`);
  console.log(`  ✓ Valid Approvals:           ${result.manifest.validApprovalsCount}`);
  console.log(`  ✗ Quarantined Approvals:     ${result.manifest.quarantinedApprovalsCount}`);
  console.log('----------------------------------------------------------------');
  console.log(`Aggregate Valid Order Total:   $${result.manifest.aggregateAuthorizedTotal}`);
  console.log(`  - Real PayPal Captures:      ${result.manifest.paypalRealCapturesCount}`);
  console.log(`  - Synthetic Local Captures:  ${result.manifest.localSyntheticCapturesCount}`);
  console.log('----------------------------------------------------------------');
  console.log(`Manifest exported to:          ${manifestPath}`);
  console.log(`Quarantine exported to:        ${quarantinePath}`);
  console.log(`Simulated manifest to:         ${simulatedPath}`);
  console.log('================================================================');
}
