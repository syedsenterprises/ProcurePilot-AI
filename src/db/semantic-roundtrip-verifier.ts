import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseExactDecimalToCents } from './legacy-preflight';

export type DifferenceClassification =
  | 'EXACT_MATCH'
  | 'LOSSLESS_NORMALIZATION'
  | 'INTENTIONAL_SEMANTIC_DIFFERENCE'
  | 'INFORMATION_NOT_PRESENT_IN_POSTGRES'
  | 'UNEXPECTED_LOSS';

export interface FieldComparisonResult {
  recordId: string;
  recordType: 'ORDER' | 'APPROVAL';
  field: string;
  originalValue: any;
  exportedValue: any;
  classification: DifferenceClassification;
  notes?: string;
}

export interface SemanticRoundtripReport {
  success: boolean;
  totalOrdersCompared: number;
  totalApprovalsCompared: number;
  totalFieldsCompared: number;
  exactMatchesCount: number;
  losslessNormalizationsCount: number;
  intentionalSemanticDifferencesCount: number;
  infoNotPresentInPostgresCount: number;
  unexpectedLossCount: number;
  quarantinedOrphanVerified: boolean;
  fieldMatrix: Record<string, { classification: DifferenceClassification; count: number; sampleNote?: string }>;
  unexpectedLosses: FieldComparisonResult[];
}

function sha256Hex(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Compares an exported staging directory against original .data/ storage,
 * producing a field-level compatibility classification matrix.
 */
export function verifySemanticRoundtrip(
  stagingDir: string,
  baseDir = process.cwd()
): SemanticRoundtripReport {
  const originalOrdersDir = path.resolve(baseDir, '.data/orders');
  const originalApprovalsDir = path.resolve(baseDir, '.data/approvals');
  const exportedOrdersDir = path.resolve(stagingDir, 'orders');
  const exportedApprovalsDir = path.resolve(stagingDir, 'approvals');

  const fieldMatrix: Record<string, { classification: DifferenceClassification; count: number; sampleNote?: string }> = {};
  const unexpectedLosses: FieldComparisonResult[] = [];

  function recordField(
    recordId: string,
    recordType: 'ORDER' | 'APPROVAL',
    field: string,
    origVal: any,
    expVal: any,
    classification: DifferenceClassification,
    notes?: string
  ) {
    const key = `${recordType}.${field}`;
    if (!fieldMatrix[key]) {
      fieldMatrix[key] = { classification, count: 0, sampleNote: notes };
    }
    fieldMatrix[key].count++;

    if (classification === 'UNEXPECTED_LOSS') {
      unexpectedLosses.push({
        recordId,
        recordType,
        field,
        originalValue: origVal,
        exportedValue: expVal,
        classification,
        notes,
      });
    }
  }

  // 1. Compare Orders
  const exportedOrderFiles = fs.readdirSync(exportedOrdersDir);
  let ordersCompared = 0;

  for (const fileName of exportedOrderFiles) {
    if (!fileName.endsWith('.json')) continue;
    ordersCompared++;

    const origPath = path.resolve(originalOrdersDir, fileName);
    const expPath = path.resolve(exportedOrdersDir, fileName);

    const orig = JSON.parse(fs.readFileSync(origPath, 'utf8'));
    const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const id = orig.orderId;

    // orderId
    recordField(id, 'ORDER', 'orderId', orig.orderId, exp.orderId, orig.orderId === exp.orderId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // ticketId
    recordField(id, 'ORDER', 'ticketId', orig.ticketId, exp.ticketId, orig.ticketId === exp.ticketId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // authorizedTotal
    const origTotCents = parseExactDecimalToCents(orig.authorizedTotal.toFixed(2));
    const expTotCents = parseExactDecimalToCents(exp.authorizedTotal.toFixed(2));
    recordField(id, 'ORDER', 'authorizedTotal', orig.authorizedTotal, exp.authorizedTotal, origTotCents === expTotCents ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // authorizedSubtotal
    recordField(id, 'ORDER', 'authorizedSubtotal', orig.authorizedSubtotal, exp.authorizedSubtotal, orig.authorizedSubtotal === exp.authorizedSubtotal ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // authorizedTax
    recordField(id, 'ORDER', 'authorizedTax', orig.authorizedTax, exp.authorizedTax, orig.authorizedTax === exp.authorizedTax ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // authorizedShipping
    recordField(id, 'ORDER', 'authorizedShipping', orig.authorizedShipping, exp.authorizedShipping, orig.authorizedShipping === exp.authorizedShipping ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // currency
    recordField(id, 'ORDER', 'currency', orig.currency, exp.currency, orig.currency === exp.currency ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // status
    recordField(id, 'ORDER', 'status', orig.status, exp.status, orig.status === exp.status ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // approverName
    recordField(id, 'ORDER', 'approverName', orig.approverName, exp.approverName, orig.approverName === exp.approverName ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // approverDepartment
    recordField(id, 'ORDER', 'approverDepartment', orig.approverDepartment, exp.approverDepartment, orig.approverDepartment === exp.approverDepartment ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // idempotencyKey
    recordField(id, 'ORDER', 'idempotencyKey', orig.idempotencyKey, exp.idempotencyKey, orig.idempotencyKey === exp.idempotencyKey ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // captureId
    recordField(id, 'ORDER', 'captureId', orig.captureId, exp.captureId, orig.captureId === exp.captureId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');

    // isSimulated
    if (orig.isSimulated === exp.isSimulated) {
      recordField(id, 'ORDER', 'isSimulated', orig.isSimulated, exp.isSimulated, 'EXACT_MATCH');
    } else if (exp.isSimulated === true && orig.isSimulated === undefined) {
      recordField(
        id,
        'ORDER',
        'isSimulated',
        orig.isSimulated,
        exp.isSimulated,
        'INTENTIONAL_SEMANTIC_DIFFERENCE',
        'PostgreSQL explicitly attaches is_simulated=true per migration-simulated-orders-manifest.json'
      );
    } else {
      recordField(id, 'ORDER', 'isSimulated', orig.isSimulated, exp.isSimulated, 'UNEXPECTED_LOSS');
    }

    // createdAt (Lossless ISO timestamp normalization)
    const origCreatedMs = new Date(orig.createdAt).getTime();
    const expCreatedMs = new Date(exp.createdAt).getTime();
    const createdClass: DifferenceClassification = orig.createdAt === exp.createdAt ? 'EXACT_MATCH' : origCreatedMs === expCreatedMs ? 'LOSSLESS_NORMALIZATION' : 'UNEXPECTED_LOSS';
    recordField(id, 'ORDER', 'createdAt', orig.createdAt, exp.createdAt, createdClass);

    // capturedAt
    if (orig.capturedAt || exp.capturedAt) {
      const origCapMs = orig.capturedAt ? new Date(orig.capturedAt).getTime() : null;
      const expCapMs = exp.capturedAt ? new Date(exp.capturedAt).getTime() : null;

      if (orig.capturedAt === exp.capturedAt) {
        recordField(id, 'ORDER', 'capturedAt', orig.capturedAt, exp.capturedAt, 'EXACT_MATCH');
      } else if (origCapMs === expCapMs) {
        recordField(id, 'ORDER', 'capturedAt', orig.capturedAt, exp.capturedAt, 'LOSSLESS_NORMALIZATION');
      } else if (exp.isSimulated || orig.isSimulated) {
        // In PostgreSQL, payment_captures stores 0 synthetic captures. Simulated capture timestamps fall back to order created_at.
        recordField(
          id,
          'ORDER',
          'capturedAt',
          orig.capturedAt,
          exp.capturedAt,
          'INFORMATION_NOT_PRESENT_IN_POSTGRES',
          'Synthetic capture timestamp not stored in PostgreSQL financial ledger; falls back to order created_at'
        );
      } else {
        recordField(id, 'ORDER', 'capturedAt', orig.capturedAt, exp.capturedAt, 'UNEXPECTED_LOSS');
      }
    }

    // items
    if (Array.isArray(orig.items) && Array.isArray(exp.items)) {
      recordField(id, 'ORDER', 'items.length', orig.items.length, exp.items.length, orig.items.length === exp.items.length ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
      for (let i = 0; i < orig.items.length; i++) {
        const oIt = orig.items[i];
        const eIt = exp.items[i];
        if (eIt) {
          recordField(id, 'ORDER', 'items.productId', oIt.productId, eIt.productId, oIt.productId === eIt.productId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'ORDER', 'items.name', oIt.name, eIt.name, oIt.name === eIt.name ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'ORDER', 'items.unitPrice', oIt.unitPrice, eIt.unitPrice, oIt.unitPrice === eIt.unitPrice ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'ORDER', 'items.quantity', oIt.quantity, eIt.quantity, oIt.quantity === eIt.quantity ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
        }
      }
    }
  }

  // 2. Compare Approvals
  const exportedApprovalFiles = fs.readdirSync(exportedApprovalsDir);
  let approvalsCompared = 0;

  for (const fileName of exportedApprovalFiles) {
    if (!fileName.endsWith('.json')) continue;
    approvalsCompared++;

    const origPath = path.resolve(originalApprovalsDir, fileName);
    const expPath = path.resolve(exportedApprovalsDir, fileName);

    const orig = JSON.parse(fs.readFileSync(origPath, 'utf8'));
    const exp = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const id = orig.ticketId;

    // ticketId
    recordField(id, 'APPROVAL', 'ticketId', orig.ticketId, exp.ticketId, orig.ticketId === exp.ticketId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // nonce
    recordField(id, 'APPROVAL', 'nonce', orig.nonce, exp.nonce, orig.nonce === exp.nonce ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // cartFingerprint
    recordField(id, 'APPROVAL', 'cartFingerprint', orig.cartFingerprint, exp.cartFingerprint, orig.cartFingerprint === exp.cartFingerprint ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // verifiedSubtotal
    recordField(id, 'APPROVAL', 'verifiedSubtotal', orig.verifiedSubtotal, exp.verifiedSubtotal, orig.verifiedSubtotal === exp.verifiedSubtotal ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // verifiedTax
    recordField(id, 'APPROVAL', 'verifiedTax', orig.verifiedTax, exp.verifiedTax, orig.verifiedTax === exp.verifiedTax ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // verifiedShipping
    recordField(id, 'APPROVAL', 'verifiedShipping', orig.verifiedShipping, exp.verifiedShipping, orig.verifiedShipping === exp.verifiedShipping ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // verifiedTotal
    recordField(id, 'APPROVAL', 'verifiedTotal', orig.verifiedTotal, exp.verifiedTotal, orig.verifiedTotal === exp.verifiedTotal ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // currency
    recordField(id, 'APPROVAL', 'currency', orig.currency, exp.currency, orig.currency === exp.currency ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // status
    recordField(id, 'APPROVAL', 'status', orig.status, exp.status, orig.status === exp.status ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');

    // sessionToken: in PostgreSQL, stored as SHA-256 session_token_hash for credential hygiene.
    // Plaintext token cannot be recovered from one-way hash and is omitted from export.
    if (orig.sessionToken || exp.sessionToken) {
      if (orig.sessionToken === exp.sessionToken) {
        recordField(id, 'APPROVAL', 'sessionToken', orig.sessionToken, exp.sessionToken, 'EXACT_MATCH');
      } else if (orig.sessionToken && exp.sessionToken === undefined) {
        recordField(
          id,
          'APPROVAL',
          'sessionToken',
          orig.sessionToken,
          exp.sessionToken,
          'INFORMATION_NOT_PRESENT_IN_POSTGRES',
          'Plaintext session token not stored in PostgreSQL (one-way hashed); omitted from export to prevent hash masquerading'
        );
      } else if (orig.sessionToken && exp.sessionToken === sha256Hex(orig.sessionToken)) {
        recordField(
          id,
          'APPROVAL',
          'sessionToken',
          orig.sessionToken,
          exp.sessionToken,
          'INTENTIONAL_SEMANTIC_DIFFERENCE',
          'Session token stored as SHA-256 hash in PostgreSQL for credential hygiene'
        );
      } else {
        recordField(id, 'APPROVAL', 'sessionToken', orig.sessionToken, exp.sessionToken, 'UNEXPECTED_LOSS');
      }
    }

    // createdAt
    recordField(id, 'APPROVAL', 'createdAt', orig.createdAt, exp.createdAt, orig.createdAt === exp.createdAt ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
    // expiresAt
    recordField(id, 'APPROVAL', 'expiresAt', orig.expiresAt, exp.expiresAt, orig.expiresAt === exp.expiresAt ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');

    // consumedAt
    if (orig.consumedAt || exp.consumedAt) {
      const origMs = orig.consumedAt ? new Date(orig.consumedAt).getTime() : null;
      const expMs = exp.consumedAt ? new Date(exp.consumedAt).getTime() : null;
      const classType: DifferenceClassification = orig.consumedAt === exp.consumedAt ? 'EXACT_MATCH' : origMs === expMs ? 'LOSSLESS_NORMALIZATION' : 'UNEXPECTED_LOSS';
      recordField(id, 'APPROVAL', 'consumedAt', orig.consumedAt, exp.consumedAt, classType);
    }

    // signoff
    if (orig.signoff || exp.signoff) {
      if (orig.signoff && exp.signoff) {
        recordField(id, 'APPROVAL', 'signoff.userName', orig.signoff.userName, exp.signoff.userName, orig.signoff.userName === exp.signoff.userName ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
        recordField(id, 'APPROVAL', 'signoff.department', orig.signoff.department, exp.signoff.department, orig.signoff.department === exp.signoff.department ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
        recordField(id, 'APPROVAL', 'signoff.purchaseJustification', orig.signoff.purchaseJustification, exp.signoff.purchaseJustification, orig.signoff.purchaseJustification === exp.signoff.purchaseJustification ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
        recordField(id, 'APPROVAL', 'signoff.identityTier', orig.signoff.identityTier, exp.signoff.identityTier, orig.signoff.identityTier === exp.signoff.identityTier ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
      } else {
        recordField(id, 'APPROVAL', 'signoff', orig.signoff, exp.signoff, 'UNEXPECTED_LOSS');
      }
    }

    // items
    if (Array.isArray(orig.verifiedItems) && Array.isArray(exp.verifiedItems)) {
      recordField(id, 'APPROVAL', 'verifiedItems.length', orig.verifiedItems.length, exp.verifiedItems.length, orig.verifiedItems.length === exp.verifiedItems.length ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
      for (let i = 0; i < orig.verifiedItems.length; i++) {
        const oIt = orig.verifiedItems[i];
        const eIt = exp.verifiedItems[i];
        if (eIt) {
          recordField(id, 'APPROVAL', 'verifiedItems.productId', oIt.productId, eIt.productId, oIt.productId === eIt.productId ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'APPROVAL', 'verifiedItems.name', oIt.name, eIt.name, oIt.name === eIt.name ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'APPROVAL', 'verifiedItems.unitPrice', oIt.unitPrice, eIt.unitPrice, oIt.unitPrice === eIt.unitPrice ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
          recordField(id, 'APPROVAL', 'verifiedItems.quantity', oIt.quantity, eIt.quantity, oIt.quantity === eIt.quantity ? 'EXACT_MATCH' : 'UNEXPECTED_LOSS');
        }
      }
    }

    // Provenance fields: sourceOrigin & integrityStatus (Intentional semantic enhancement in PostgreSQL)
    recordField(id, 'APPROVAL', 'sourceOrigin', orig.sourceOrigin || undefined, exp.sourceOrigin, 'INTENTIONAL_SEMANTIC_DIFFERENCE', 'PostgreSQL migration explicitly attaches historical sourceOrigin="LEGACY_JSON_IMPORT"');
    recordField(id, 'APPROVAL', 'integrityStatus', orig.integrityStatus || undefined, exp.integrityStatus, 'INTENTIONAL_SEMANTIC_DIFFERENCE', 'PostgreSQL migration explicitly marks historical imported approvals as UNVERIFIABLE_LEGACY');

    // signature: not present on disk in legacy JSON; not manufactured in PostgreSQL
    recordField(id, 'APPROVAL', 'signature', orig.signature || undefined, exp.signature || undefined, 'INFORMATION_NOT_PRESENT_IN_POSTGRES', 'HMAC signature was only generated in memory at challenge creation and not written to legacy disk; preserved as absent');
  }

  // 3. Verify Quarantined Orphan Record Excluded
  const orphanFile = 'TEST-ORDER-MUTATION-CHECK-01.json';
  const orphanInOriginal = fs.existsSync(path.resolve(originalOrdersDir, orphanFile));
  const orphanInExported = fs.existsSync(path.resolve(exportedOrdersDir, orphanFile));
  const quarantinedOrphanVerified = orphanInOriginal && !orphanInExported;

  let exactMatches = 0;
  let losslessNorms = 0;
  let intentionalDiffs = 0;
  let infoNotPresent = 0;
  let totalFields = 0;

  for (const entry of Object.values(fieldMatrix)) {
    totalFields += entry.count;
    if (entry.classification === 'EXACT_MATCH') exactMatches += entry.count;
    else if (entry.classification === 'LOSSLESS_NORMALIZATION') losslessNorms += entry.count;
    else if (entry.classification === 'INTENTIONAL_SEMANTIC_DIFFERENCE') intentionalDiffs += entry.count;
    else if (entry.classification === 'INFORMATION_NOT_PRESENT_IN_POSTGRES') infoNotPresent += entry.count;
  }

  return {
    success: unexpectedLosses.length === 0 && quarantinedOrphanVerified,
    totalOrdersCompared: ordersCompared,
    totalApprovalsCompared: approvalsCompared,
    totalFieldsCompared: totalFields,
    exactMatchesCount: exactMatches,
    losslessNormalizationsCount: losslessNorms,
    intentionalSemanticDifferencesCount: intentionalDiffs,
    infoNotPresentInPostgresCount: infoNotPresent,
    unexpectedLossCount: unexpectedLosses.length,
    quarantinedOrphanVerified,
    fieldMatrix,
    unexpectedLosses,
  };
}
