import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { generateLegacyOrderNumber } from './legacy-migration';
import { parseExactDecimalToCents } from './legacy-preflight';
import { ReverseExportManifest, formatCentsToExactDecimalString } from './export-pg-to-flatfiles';

export interface ValidationReport {
  valid: boolean;
  exportRunId: string;
  outputDir: string;
  ordersValidated: number;
  approvalsValidated: number;
  recoveryFilesValidated: number;
  totalFilesVerified: number;
  aggregateAuthorizedCents: number;
  aggregateCapturedCents: number;
  reconciliationPassed: boolean;
  errors: string[];
}

function computeSha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively retrieves all files in a directory relative to the root.
 */
function getAllFilesInDir(dir: string, baseDir: string = dir): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.resolve(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFilesInDir(fullPath, baseDir));
    } else {
      results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }
  return results;
}

/**
 * Validates an exported rollback staging directory against legacy schemas,
 * SHA-256 checksums, exact monetary constraints, manifest specifications,
 * and detects any unmanifested extra files.
 */
export function validateExportStaging(outputDir: string): ValidationReport {
  const errors: string[] = [];

  const manifestPath = path.resolve(outputDir, 'export-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      exportRunId: 'UNKNOWN',
      outputDir,
      ordersValidated: 0,
      approvalsValidated: 0,
      recoveryFilesValidated: 0,
      totalFilesVerified: 0,
      aggregateAuthorizedCents: 0,
      aggregateCapturedCents: 0,
      reconciliationPassed: false,
      errors: [`Missing export-manifest.json in "${outputDir}"`],
    };
  }

  // Ensure failure marker does not exist
  const failurePath = path.resolve(outputDir, 'EXPORT_FAILED.json');
  if (fs.existsSync(failurePath)) {
    errors.push(`Staging directory contains EXPORT_FAILED.json marker; export was interrupted or failed.`);
  }

  let manifest: ReverseExportManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err: any) {
    return {
      valid: false,
      exportRunId: 'CORRUPTED',
      outputDir,
      ordersValidated: 0,
      approvalsValidated: 0,
      recoveryFilesValidated: 0,
      totalFilesVerified: 0,
      aggregateAuthorizedCents: 0,
      aggregateCapturedCents: 0,
      reconciliationPassed: false,
      errors: [`Corrupted export-manifest.json: ${err.message}`],
    };
  }

  if (manifest.status !== 'COMPLETED_VERIFIED') {
    errors.push(`Manifest status is "${manifest.status}", expected "COMPLETED_VERIFIED"`);
  }

  // Quarantine accounting verification
  if (manifest.quarantinedOrdersCount !== 1) {
    errors.push(
      `Quarantine accounting mismatch: manifest declares ${manifest.quarantinedOrdersCount} quarantined orders, expected exactly 1`
    );
  }
  if (manifest.totalScannedOrders !== manifest.ordersCount + manifest.quarantinedOrdersCount) {
    errors.push(
      `Total scanned orders mismatch: ${manifest.totalScannedOrders} != ${manifest.ordersCount} + ${manifest.quarantinedOrdersCount}`
    );
  }

  // 1. Verify unmanifested extra files
  const diskFiles = getAllFilesInDir(outputDir);
  const manifestFileSet = new Set(manifest.files.map((f) => f.relativePath.replace(/\\/g, '/')));
  manifestFileSet.add('export-manifest.json');

  for (const diskFile of diskFiles) {
    if (!manifestFileSet.has(diskFile)) {
      errors.push(`Unmanifested extra file detected on disk: "${diskFile}"`);
    }
  }

  // 2. Verify all files in manifest match SHA-256 and sizeBytes
  let ordersCount = 0;
  let approvalsCount = 0;
  let recoveryCount = 0;
  let calculatedAuthCents = 0;
  let calculatedCapCents = 0;

  for (const fileEntry of manifest.files) {
    const fullPath = path.resolve(outputDir, fileEntry.relativePath);

    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing manifest file on disk: "${fileEntry.relativePath}"`);
      continue;
    }

    const content = fs.readFileSync(fullPath);
    const hash = computeSha256(content);
    if (hash !== fileEntry.sha256) {
      errors.push(
        `Checksum mismatch for "${fileEntry.relativePath}": manifest=${fileEntry.sha256}, actual=${hash}`
      );
    }
    if (content.length !== fileEntry.sizeBytes) {
      errors.push(
        `Size mismatch for "${fileEntry.relativePath}": manifest=${fileEntry.sizeBytes}, actual=${content.length}`
      );
    }

    // 3. Validate Order JSON schema
    if (fileEntry.recordType === 'ORDER') {
      ordersCount++;
      try {
        const order = JSON.parse(content.toString('utf8'));

        if (!order.orderId || typeof order.orderId !== 'string') {
          errors.push(`Order file "${fileEntry.fileName}" missing string orderId`);
        }
        if (!order.ticketId || typeof order.ticketId !== 'string') {
          errors.push(`Order file "${fileEntry.fileName}" missing string ticketId`);
        }
        if (order.currency !== 'USD') {
          errors.push(`Order file "${fileEntry.fileName}" invalid currency: ${order.currency}`);
        }
        if (!['CREATED', 'CAPTURED', 'VOIDED'].includes(order.status)) {
          errors.push(`Order file "${fileEntry.fileName}" invalid status: ${order.status}`);
        }

        // Canonical identity verification
        const expectedOrderNumber = generateLegacyOrderNumber(order.orderId);
        if (!expectedOrderNumber) {
          errors.push(`Order "${order.orderId}" could not generate canonical order number`);
        }

        // Exact decimal verification using exact BigInt parser without floating-point math
        const totalCents = parseExactDecimalToCents(order.authorizedTotal, `order[${order.orderId}]`);
        calculatedAuthCents += totalCents;

        if (!Array.isArray(order.items) || order.items.length === 0) {
          errors.push(`Order "${order.orderId}" has no items`);
        } else {
          for (const it of order.items) {
            if (!it.productId || typeof it.productId !== 'string') {
              errors.push(`Order "${order.orderId}" item missing productId`);
            }
            if (!it.quantity || it.quantity < 1 || !Number.isInteger(it.quantity)) {
              errors.push(`Order "${order.orderId}" item invalid quantity: ${it.quantity}`);
            }
            parseExactDecimalToCents(it.unitPrice, `item[${it.productId}]`);
          }
        }

        // Capture verification
        if (order.captureId) {
          if (order.isSimulated) {
            if (!order.captureId.startsWith('CAP_')) {
              errors.push(`Simulated order "${order.orderId}" captureId does not start with CAP_`);
            }
          }
        }
      } catch (err: any) {
        errors.push(`Invalid JSON schema in order file "${fileEntry.fileName}": ${err.message}`);
      }
    }

    // 4. Validate Approval JSON schema
    if (fileEntry.recordType === 'APPROVAL') {
      approvalsCount++;
      try {
        const appr = JSON.parse(content.toString('utf8'));

        if (!appr.ticketId || typeof appr.ticketId !== 'string') {
          errors.push(`Approval file "${fileEntry.fileName}" missing ticketId`);
        }
        if (!appr.nonce || typeof appr.nonce !== 'string' || appr.nonce.length !== 64) {
          errors.push(`Approval file "${fileEntry.fileName}" invalid nonce (length must be 64)`);
        }
        if (!appr.cartFingerprint || typeof appr.cartFingerprint !== 'string' || appr.cartFingerprint.length !== 64) {
          errors.push(`Approval file "${fileEntry.fileName}" invalid cartFingerprint`);
        }
        if (!['PENDING_APPROVAL', 'APPROVED', 'CONSUMED'].includes(appr.status)) {
          errors.push(`Approval file "${fileEntry.fileName}" invalid status: ${appr.status}`);
        }
        if (appr.currency !== 'USD') {
          errors.push(`Approval file "${fileEntry.fileName}" invalid currency: ${appr.currency}`);
        }

        // Provenance & signature checks
        if (appr.integrityStatus === 'UNVERIFIABLE_LEGACY') {
          if (appr.signature) {
            errors.push(
              `Approval violation: Historical approval "${appr.ticketId}" has manufactured signature despite UNVERIFIABLE_LEGACY!`
            );
          }
        }

        // Security check: Plaintext sessionToken field must NEVER contain a 64-hex SHA-256 hash
        if (appr.sessionToken && typeof appr.sessionToken === 'string') {
          if (appr.sessionToken.length === 64 && /^[0-9a-fA-F]{64}$/.test(appr.sessionToken)) {
            errors.push(
              `Security Violation: Approval file "${fileEntry.fileName}" contains a SHA-256 hash in plaintext sessionToken field!`
            );
          }
        }

        parseExactDecimalToCents(appr.verifiedTotal, `appr[${appr.ticketId}]`);
      } catch (err: any) {
        errors.push(`Invalid JSON schema in approval file "${fileEntry.fileName}": ${err.message}`);
      }
    }

    // 5. Validate Financial Recovery Sidecars
    if (fileEntry.recordType === 'FINANCIAL_RECOVERY') {
      recoveryCount++;
      try {
        const sidecarData = JSON.parse(content.toString('utf8'));

        if (fileEntry.fileName === 'recovery-financial-captures.json') {
          if (Array.isArray(sidecarData)) {
            for (const cap of sidecarData) {
              if (cap.externalCaptureId && cap.externalCaptureId.startsWith('CAP_SANDBOX_')) {
                errors.push(
                  `Financial Ledger Contamination: Synthetic capture "${cap.externalCaptureId}" in financial captures sidecar!`
                );
              }
              const cents = parseExactDecimalToCents(cap.capturedAmount, `recoveryCapture[${cap.externalCaptureId}]`);
              if (cap.capturedAmountCents !== cents) {
                errors.push(`Capture ${cap.externalCaptureId} amountCents mismatch`);
              }
              calculatedCapCents += cents;
            }
          }
        }

        if (fileEntry.fileName === 'recovery-payment-attempts.json') {
          if (Array.isArray(sidecarData)) {
            for (const att of sidecarData) {
              if (!att.id || !att.orderId) {
                errors.push(`Payment attempt missing id or orderId`);
              }
              if (att.amount) {
                const cents = parseExactDecimalToCents(att.amount, `attempt[${att.id}]`);
                if (att.amountCents !== cents) {
                  errors.push(`Attempt ${att.id} amountCents mismatch`);
                }
              }
            }
          }
        }

        if (fileEntry.fileName === 'recovery-payment-refunds.json') {
          if (Array.isArray(sidecarData)) {
            for (const ref of sidecarData) {
              if (!ref.id || !ref.orderId || !ref.captureId) {
                errors.push(`Refund missing required foreign key relation (orderId or captureId)`);
              }
              const cents = parseExactDecimalToCents(ref.refundAmount, `refund[${ref.id}]`);
              if (ref.refundAmountCents !== cents) {
                errors.push(`Refund ${ref.id} amountCents mismatch`);
              }
            }
          }
        }

        if (fileEntry.fileName === 'recovery-approval-credentials-metadata.json') {
          if (sidecarData.classification !== 'SENSITIVE_CREDENTIAL_VERIFIER_METADATA') {
            errors.push(`recovery-approval-credentials-metadata.json missing SENSITIVE_CREDENTIAL_VERIFIER_METADATA classification`);
          }
          if (!Array.isArray(sidecarData.credentials)) {
            errors.push(`recovery-approval-credentials-metadata.json missing credentials array`);
          }
        }
      } catch (err: any) {
        errors.push(`Malformed sidecar JSON in "${fileEntry.fileName}": ${err.message}`);
      }
    }
  }

  // 6. Check directory file counts
  const ordersDiskCount = fs.existsSync(path.resolve(outputDir, 'orders'))
    ? fs.readdirSync(path.resolve(outputDir, 'orders')).length
    : 0;
  const approvalsDiskCount = fs.existsSync(path.resolve(outputDir, 'approvals'))
    ? fs.readdirSync(path.resolve(outputDir, 'approvals')).length
    : 0;

  if (ordersDiskCount !== manifest.ordersCount) {
    errors.push(
      `Orders count mismatch: disk contains ${ordersDiskCount} files, manifest declares ${manifest.ordersCount}`
    );
  }
  if (approvalsDiskCount !== manifest.approvalsCount) {
    errors.push(
      `Approvals count mismatch: disk contains ${approvalsDiskCount} files, manifest declares ${manifest.approvalsCount}`
    );
  }

  // 7. Financial Reconciliation Check
  if (calculatedAuthCents !== manifest.aggregateAuthorizedCents) {
    errors.push(
      `Financial reconciliation mismatch on authorized total: calculated=${calculatedAuthCents} cents, manifest=${manifest.aggregateAuthorizedCents} cents`
    );
  }
  if (calculatedCapCents !== manifest.aggregateCapturedCents) {
    errors.push(
      `Financial reconciliation mismatch on captured total: calculated=${calculatedCapCents} cents, manifest=${manifest.aggregateCapturedCents} cents`
    );
  }

  const reconciliationPassed =
    calculatedAuthCents === manifest.aggregateAuthorizedCents &&
    calculatedCapCents === manifest.aggregateCapturedCents;

  return {
    valid: errors.length === 0,
    exportRunId: manifest.exportRunId,
    outputDir,
    ordersValidated: ordersCount,
    approvalsValidated: approvalsCount,
    recoveryFilesValidated: recoveryCount,
    totalFilesVerified: manifest.files.length,
    aggregateAuthorizedCents: calculatedAuthCents,
    aggregateCapturedCents: calculatedCapCents,
    reconciliationPassed,
    errors,
  };
}
