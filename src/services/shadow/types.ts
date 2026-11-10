export type ShadowMismatchCategory =
  | 'MISSING_POSTGRES_RECORD'
  | 'EXTRA_POSTGRES_RECORD'
  | 'STATUS_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'LINE_ITEM_QUANTITY_MISMATCH'
  | 'LINE_ITEM_CONTENT_MISMATCH'
  | 'LINE_ITEM_COUNT_MISMATCH'
  | 'BROKEN_RELATIONSHIP'
  | 'TIMESTAMP_MISMATCH'
  | 'SIMULATION_PROVENANCE_MISMATCH'
  | 'SYNTHETIC_CAPTURE_IN_LEDGER'
  | 'UNEXPECTED_LEGACY_SIGNATURE_VERIFIED'
  | 'SORTING_OR_PAGINATION_MISMATCH'
  | 'ORGANIZATION_MISMATCH'
  | 'FIELD_VALUE_MISMATCH';

export type ShadowDifferenceSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface ShadowDifference {
  category: ShadowMismatchCategory;
  severity: ShadowDifferenceSeverity;
  field: string;
  legacyValue: unknown;
  postgresValue: unknown;
  message: string;
  isIntentionalDifference?: boolean;
}

export interface ShadowComparisonResult<T = unknown> {
  operation: string;
  targetId: string;
  legacyResult: T | null;
  postgresResult: T | null;
  isMatch: boolean;
  differences: ShadowDifference[];
  intentionalDifferences: ShadowDifference[];
  unexpectedMismatches: ShadowDifference[];
  executionTimeMs: {
    legacy: number;
    postgres: number;
  };
}

export interface NormalizedItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

export interface NormalizedOrder {
  orderId: string; // Original external / file ID
  orderNumber: string; // Database order number (e.g. LEGACY-ORD-...)
  organizationId: string;
  ticketId: string;
  externalOrderId: string | null;
  status: string;
  authorizedTotal: string;
  authorizedSubtotal: string;
  authorizedTax: string;
  authorizedShipping: string;
  currency: string;
  approverName: string | null;
  approverDepartment: string | null;
  isSimulated: boolean;
  isSimulatedProvenance: string;
  items: NormalizedItem[];
  createdAt: number; // UTC ms
  captureId: string | null;
  capturedAt: number | null;
}

export interface NormalizedApprovalTicket {
  ticketId: string;
  organizationId: string;
  cartFingerprint: string;
  verifiedSubtotal: string;
  verifiedTax: string;
  verifiedShipping: string;
  verifiedTotal: string;
  currency: string;
  status: string;
  integrityStatus: string;
  sourceOrigin: string;
  hasChallengeSignature: boolean;
  approverName: string | null;
  approverDepartment: string | null;
  createdAt: number; // UTC ms
  expiresAt: number; // UTC ms
  items: NormalizedItem[];
}

export interface NormalizedCapture {
  orderId: string;
  externalCaptureId: string;
  capturedAmount: string;
  currency: string;
  captureOrigin: string;
  capturedAt: number | null;
}

export interface NormalizedDashboardSummary {
  totalOrders: number;
  aggregateAuthorizedTotal: string;
  totalApprovals: number;
  approvalsByStatus: Record<string, number>;
  approvalsByIntegrity: Record<string, number>;
  genuineCapturesCount: number;
  genuineCapturedAmount: string;
}
