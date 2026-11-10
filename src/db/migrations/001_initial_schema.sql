-- ============================================================================
-- Migration 001: Initial Authoritative Schema (13 Core Tables)
-- ProcurePilot AI — Phase 1B.1 Authoritative Schema
-- ============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. organizations
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL CHECK (length(name) >= 2),
  slug VARCHAR(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]+$'),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_organizations_id UNIQUE (id)
);

-- Seed Default Organization for Initial Single-Tenant Phase & Legacy Migration
INSERT INTO organizations (id, name, slug, currency, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Default Enterprise Tenant',
  'default-enterprise',
  'USD',
  NOW(),
  NOW()
) ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. procurement_requests
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procurement_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  session_token_hash VARCHAR(64),
  department VARCHAR(128),
  user_query TEXT NOT NULL CHECK (length(user_query) >= 3),
  extracted_budget NUMERIC(12, 2) CHECK (extracted_budget >= 0),
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONVERTED', 'ABANDONED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_procurement_requests_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_procurement_requests_session ON procurement_requests(session_token_hash);

-- ----------------------------------------------------------------------------
-- 3. approval_tickets
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_tickets (
  ticket_id VARCHAR(64) PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  procurement_request_id UUID,
  nonce VARCHAR(64) NOT NULL CHECK (length(nonce) = 64),
  cart_fingerprint VARCHAR(64) NOT NULL CHECK (length(cart_fingerprint) = 64),
  challenge_signature VARCHAR(64) NOT NULL CHECK (length(challenge_signature) = 64),
  verified_subtotal NUMERIC(12, 2) NOT NULL CHECK (verified_subtotal >= 0),
  verified_tax NUMERIC(12, 2) NOT NULL CHECK (verified_tax >= 0),
  verified_shipping NUMERIC(12, 2) NOT NULL CHECK (verified_shipping >= 0),
  verified_total NUMERIC(12, 2) NOT NULL CHECK (verified_total > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL' 
    CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'CONSUMED', 'EXPIRED')),
  session_token_hash VARCHAR(64),
  approver_name VARCHAR(128),
  approver_department VARCHAR(128),
  purchase_justification TEXT,
  identity_tier VARCHAR(64) NOT NULL DEFAULT 'SELF_ATTESTED_REQUISITIONER',
  expires_at TIMESTAMPTZ NOT NULL,
  signed_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_approval_tickets_org_ticket UNIQUE (organization_id, ticket_id),
  CONSTRAINT fk_approval_tickets_org_request FOREIGN KEY (organization_id, procurement_request_id)
    REFERENCES procurement_requests(organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_approval_tickets_lookup ON approval_tickets(ticket_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_tickets_expiry ON approval_tickets(expires_at) WHERE status = 'PENDING_APPROVAL';

-- ----------------------------------------------------------------------------
-- 4. approval_ticket_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_ticket_items (
  id BIGSERIAL PRIMARY KEY,
  ticket_id VARCHAR(64) NOT NULL REFERENCES approval_tickets(ticket_id) ON DELETE CASCADE,
  product_id VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price > 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total = quantity * unit_price)
);

CREATE INDEX IF NOT EXISTS idx_approval_ticket_items_ticket ON approval_ticket_items(ticket_id);

-- ----------------------------------------------------------------------------
-- 5. orders
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number VARCHAR(32) NOT NULL UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  ticket_id VARCHAR(64) NOT NULL UNIQUE,
  external_order_id VARCHAR(64) UNIQUE,
  provider VARCHAR(32) NOT NULL DEFAULT 'PAYPAL',
  provider_environment VARCHAR(16) NOT NULL DEFAULT 'SANDBOX' 
    CHECK (provider_environment IN ('SANDBOX', 'LIVE')),
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN (
      'DRAFT',
      'CREATION_RECONCILIATION_REQUIRED',
      'PENDING_PAYMENT_APPROVAL',
      'BUYER_APPROVED',
      'SETTLING',
      'COMPLETED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
      'CANCELLED',
      'EXPIRED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )
  ),
  authorized_total NUMERIC(12, 2) NOT NULL CHECK (authorized_total > 0),
  authorized_subtotal NUMERIC(12, 2) NOT NULL CHECK (authorized_subtotal >= 0),
  authorized_tax NUMERIC(12, 2) NOT NULL CHECK (authorized_tax >= 0),
  authorized_shipping NUMERIC(12, 2) NOT NULL CHECK (authorized_shipping >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  approver_name VARCHAR(128),
  approver_department VARCHAR(128),
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  is_simulated BOOLEAN NULL,
  is_simulated_provenance VARCHAR(64) NOT NULL DEFAULT 'EXPLICIT_SOURCE'
    CHECK (is_simulated_provenance IN ('EXPLICIT_PROVIDER', 'LOCAL_TEST_HARNESS', 'UNKNOWN_LEGACY_IMPORT', 'SOURCE_MISSING_NULL', 'EXPLICIT_SOURCE')),
  simulated_reason VARCHAR(255),
  source_origin VARCHAR(32) NOT NULL DEFAULT 'ONLINE_CHECKOUT'
    CHECK (source_origin IN ('ONLINE_CHECKOUT', 'LEGACY_JSON_IMPORT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_orders_org_id UNIQUE (organization_id, id),
  CONSTRAINT fk_orders_org_ticket FOREIGN KEY (organization_id, ticket_id)
    REFERENCES approval_tickets(organization_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_external_id ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_org_created ON orders(organization_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 6. order_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL,
  order_id UUID NOT NULL,
  product_id VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price > 0),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total = quantity * unit_price),
  CONSTRAINT fk_order_items_org_order FOREIGN KEY (organization_id, order_id)
    REFERENCES orders(organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ----------------------------------------------------------------------------
-- 7. payment_attempts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  action_type VARCHAR(32) NOT NULL CHECK (action_type IN ('CREATE_ORDER', 'CAPTURE', 'REFUND')),
  provider VARCHAR(32) NOT NULL DEFAULT 'PAYPAL',
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  provider_request_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'PREPARED' CHECK (
    status IN (
      'PREPARED',
      'DISPATCHED',
      'SUCCEEDED',
      'FAILED',
      'OUTCOME_UNKNOWN',
      'RECONCILIATION_REQUIRED'
    )
  ),
  request_payload JSONB,
  response_status INTEGER,
  response_payload JSONB,
  error_message TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON payment_attempts(order_id, action_type);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);

-- ----------------------------------------------------------------------------
-- 8. payment_captures
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  external_capture_id VARCHAR(64) NOT NULL UNIQUE,
  payment_attempt_id UUID REFERENCES payment_attempts(id),
  captured_amount NUMERIC(12, 2) NOT NULL CHECK (captured_amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  transaction_fee NUMERIC(12, 2) CHECK (transaction_fee >= 0),
  net_amount NUMERIC(12, 2) CHECK (net_amount >= 0),
  payer_email VARCHAR(255),
  payer_id VARCHAR(64),
  capture_origin VARCHAR(32) NOT NULL DEFAULT 'PAYPAL_API'
    CHECK (capture_origin IN ('PAYPAL_API', 'LOCAL_SYNTHETIC_TEST', 'PAYPAL_SANDBOX', 'PAYPAL_PRODUCTION', 'EXTERNAL_UNVERIFIED')),
  simulated_reason VARCHAR(255),
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_captures_order_id UNIQUE (order_id, id)
);

CREATE INDEX IF NOT EXISTS idx_payment_captures_external ON payment_captures(external_capture_id);

-- ----------------------------------------------------------------------------
-- 9. payment_refunds
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  capture_id UUID NOT NULL,
  payment_attempt_id UUID REFERENCES payment_attempts(id),
  external_refund_id VARCHAR(64) NOT NULL UNIQUE,
  refund_amount NUMERIC(12, 2) NOT NULL CHECK (refund_amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  reason TEXT,
  refunded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_payment_refunds_order_capture FOREIGN KEY (order_id, capture_id)
    REFERENCES payment_captures(order_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_capture ON payment_refunds(capture_id);

-- ----------------------------------------------------------------------------
-- 10. payment_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  event_type VARCHAR(64) NOT NULL,
  previous_status VARCHAR(32),
  new_status VARCHAR(32) NOT NULL,
  amount NUMERIC(12, 2),
  context JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order ON payment_events(order_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- 11. webhook_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id VARCHAR(64) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id VARCHAR(64),
  payload_sha256 VARCHAR(64) NOT NULL CHECK (length(payload_sha256) = 64),
  raw_payload JSONB NOT NULL,
  processing_status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED')),
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  max_processing_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_processing_attempts > 0),
  tamper_flag BOOLEAN NOT NULL DEFAULT FALSE,
  last_error_message TEXT,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_resource ON webhook_events(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_unprocessed ON webhook_events(processing_status) 
  WHERE processing_status IN ('RECEIVED', 'FAILED');

-- ----------------------------------------------------------------------------
-- 12. webhook_transmissions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_transmissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transmission_id VARCHAR(128) NOT NULL UNIQUE,
  event_id VARCHAR(64) REFERENCES webhook_events(id) ON DELETE SET NULL,
  delivery_attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (delivery_attempt_number >= 1),
  raw_body_text TEXT NOT NULL,
  payload_sha256 VARCHAR(64) NOT NULL CHECK (length(payload_sha256) = 64),
  auth_algo VARCHAR(64),
  cert_url TEXT,
  transmission_sig TEXT,
  transmission_time TIMESTAMPTZ,
  verification_status VARCHAR(32) NOT NULL 
    CHECK (verification_status IN ('VERIFIED', 'FAILED', 'SIMULATED')),
  http_status_returned INTEGER NOT NULL,
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_transmissions_event ON webhook_transmissions(event_id);

-- ----------------------------------------------------------------------------
-- 13. audit_events
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  message TEXT NOT NULL,
  session_id VARCHAR(64),
  ip_address INET,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_type_severity ON audit_events(event_type, severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_session ON audit_events(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
