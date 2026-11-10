export interface DbOrganization {
  id: string;
  name: string;
  slug: string;
  currency: 'USD';
  created_at: Date;
  updated_at: Date;
}

export interface DbProcurementRequest {
  id: string;
  organization_id: string;
  session_token_hash?: string | null;
  department?: string | null;
  user_query: string;
  extracted_budget?: number | null;
  status: 'DRAFT' | 'CONVERTED' | 'ABANDONED';
  created_at: Date;
}

export type ApprovalSourceOrigin = 'RUNTIME' | 'LEGACY_JSON_IMPORT';
export type ApprovalIntegrityStatus = 'VERIFIED' | 'UNVERIFIABLE_LEGACY';

export interface DbApprovalTicket {
  ticket_id: string;
  organization_id: string;
  procurement_request_id?: string | null;
  nonce: string;
  cart_fingerprint: string;
  challenge_signature?: string | null;
  verified_subtotal: number;
  verified_tax: number;
  verified_shipping: number;
  verified_total: number;
  currency: 'USD';
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'CONSUMED' | 'EXPIRED';
  session_token_hash?: string | null;
  approver_name?: string | null;
  approver_department?: string | null;
  purchase_justification?: string | null;
  identity_tier: string;
  expires_at: Date;
  signed_at?: Date | null;
  consumed_at?: Date | null;
  created_at: Date;
  source_origin: ApprovalSourceOrigin;
  integrity_status: ApprovalIntegrityStatus;
}

export interface DbApprovalTicketItem {
  id: number;
  ticket_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export type OrderStatus =
  | 'DRAFT'
  | 'CREATION_RECONCILIATION_REQUIRED'
  | 'PENDING_PAYMENT_APPROVAL'
  | 'BUYER_APPROVED'
  | 'SETTLING'
  | 'COMPLETED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED'
  | 'RECONCILIATION_REQUIRED';

export interface DbOrder {
  id: string;
  order_number: string;
  organization_id: string;
  ticket_id: string;
  external_order_id?: string | null;
  provider: string;
  provider_environment: 'SANDBOX' | 'LIVE';
  status: OrderStatus;
  authorized_total: number;
  authorized_subtotal: number;
  authorized_tax: number;
  authorized_shipping: number;
  currency: 'USD';
  approver_name?: string | null;
  approver_department?: string | null;
  idempotency_key: string;
  is_simulated?: boolean | null;
  is_simulated_provenance: 'EXPLICIT_SOURCE' | 'SOURCE_MISSING_NULL';
  source_origin: 'ONLINE_CHECKOUT' | 'LEGACY_JSON_IMPORT';
  created_at: Date;
  updated_at: Date;
}

export interface DbOrderItem {
  id: number;
  organization_id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export type PaymentAttemptStatus =
  | 'PREPARED'
  | 'DISPATCHED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN'
  | 'RECONCILIATION_REQUIRED';

export interface DbPaymentAttempt {
  id: string;
  order_id: string;
  related_capture_id?: string | null;
  action_type: 'CREATE_ORDER' | 'CAPTURE' | 'REFUND';
  provider: string;
  idempotency_key: string;
  provider_request_id?: string | null;
  requested_amount?: number | null;
  currency?: string | null;
  status: PaymentAttemptStatus;
  request_payload?: Record<string, unknown> | null;
  response_status?: number | null;
  response_payload?: Record<string, unknown> | null;
  error_message?: string | null;
  attempt_number: number;
  initiated_at: Date;
  completed_at?: Date | null;
}

export interface DbPaymentCapture {
  id: string;
  order_id: string;
  external_capture_id: string;
  payment_attempt_id?: string | null;
  captured_amount: number;
  currency: 'USD';
  transaction_fee?: number | null;
  net_amount?: number | null;
  payer_email?: string | null;
  payer_id?: string | null;
  capture_origin: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST';
  captured_at?: Date | null;
  created_at: Date;
}

export interface DbPaymentRefund {
  id: string;
  order_id: string;
  capture_id: string;
  payment_attempt_id?: string | null;
  external_refund_id: string;
  refund_amount: number;
  currency: 'USD';
  reason?: string | null;
  refunded_at: Date;
  created_at: Date;
}

export interface DbPaymentEvent {
  id: number;
  order_id: string;
  event_type: string;
  previous_status?: string | null;
  new_status: string;
  amount?: number | null;
  context?: Record<string, unknown> | null;
  occurred_at: Date;
}

export interface DbWebhookEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource_id?: string | null;
  payload_sha256: string;
  raw_payload: Record<string, unknown>;
  processing_status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'IGNORED';
  processing_attempts: number;
  max_processing_attempts: number;
  tamper_flag: boolean;
  last_error_message?: string | null;
  first_received_at: Date;
  processed_at?: Date | null;
}

export interface DbWebhookTransmission {
  id: string;
  transmission_id: string;
  event_id?: string | null;
  delivery_attempt_number: number;
  raw_body_text: string;
  payload_sha256: string;
  auth_algo?: string | null;
  cert_url?: string | null;
  transmission_sig?: string | null;
  transmission_time?: Date | null;
  verification_status: 'VERIFIED' | 'FAILED' | 'SIMULATED';
  http_status_returned: number;
  first_received_at: Date;
  last_delivery_at: Date;
}

export interface DbAuditEvent {
  id: number;
  event_type: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  message: string;
  session_id?: string | null;
  ip_address?: string | null;
  details?: Record<string, unknown> | null;
  created_at: Date;
}
