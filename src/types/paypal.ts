export type PayPalEnvironment = 'sandbox' | 'live';

export interface PayPalOrderCreationRequest {
  items: Array<{ productId: string; quantity: number }>;
  userApprovalConfirmed: boolean;
  approvalSignoff: {
    userName: string;
    department: string;
    purchaseJustification: string;
    confirmedAt: string;
  };
  clientReferenceId?: string;
  currency?: 'USD';
}

export interface PayPalOrderResponse {
  success: boolean;
  orderId?: string;
  status?: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  approvalUrl?: string;
  totalAmount?: {
    currencyCode: string;
    value: string;
  };
  requiresManualReview?: boolean;
  message?: string;
  environment: PayPalEnvironment;
  createdAt: string;
  isSimulated?: boolean;
  simulationNotice?: string;
}

export interface PayPalCapturedItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface PayPalCapturedOrderDetails {
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
  items: PayPalCapturedItem[];
  createdAt: string;
  capturedAt?: string;
  captureId?: string;
}

export interface PayPalCaptureResponse {
  success: boolean;
  captureId?: string;
  orderId?: string;
  status?: 'COMPLETED' | 'DECLINED' | 'FAILED' | 'PENDING';
  payer?: {
    emailAddress?: string;
    payerId?: string;
  };
  transactionFee?: string;
  netAmount?: string;
  message?: string;
  isSimulated?: boolean;
  simulationNotice?: string;
  orderDetails?: PayPalCapturedOrderDetails;
}

export interface RecoveredPendingOrder {
  orderId: string;
  ticketId: string;
  status: string;
  authorizedTotal: number;
  authorizedSubtotal: number;
  authorizedTax: number;
  authorizedShipping: number;
  currency: string;
  approverName: string;
  approverDepartment: string;
  items: Array<{ productId: string; name: string; quantity: number; unitPrice: number }>;
  createdAt: string;
  approvalUrl?: string;
  isSimulated?: boolean;
}

export interface PayPalWebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface PayPalWebhookVerifyRequest {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: Record<string, unknown>;
}

export interface PayPalWebhookVerifyResponse {
  verification_status: 'SUCCESS' | 'FAILURE';
}

export interface PayPalWebhookVerificationResult {
  isValid: boolean;
  status: 'SUCCESS' | 'FAILURE' | 'ERROR';
  message: string;
  errorCategory?: string;
}

export interface PayPalWebhookEvent<T = Record<string, unknown>> {
  id: string;
  event_version?: string;
  create_time: string;
  resource_type: string;
  event_type: string;
  summary?: string;
  resource: T;
  links?: Array<{ href: string; rel: string; method?: string }>;
}
