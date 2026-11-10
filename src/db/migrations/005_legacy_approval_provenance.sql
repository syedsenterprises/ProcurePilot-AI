-- ============================================================================
-- Migration: 005_legacy_approval_provenance.sql
-- Description: Adds explicit database-enforced provenance & integrity status
--              to approval_tickets, permits NULL challenge_signature strictly
--              for UNVERIFIABLE_LEGACY imports, establishes a secure,
--              non-bypassable migration-only write path with strict immutability
--              for parents and child records, removes embedded credentials,
--              and eliminates superuser allowlisting.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create Dedicated Legacy Migration Role (NOLOGIN)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'procurepilot_legacy_importer') THEN
    CREATE ROLE procurepilot_legacy_importer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE procurepilot_legacy_importer WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- Revoke schema creation rights to maintain schema isolation
REVOKE CREATE ON SCHEMA public FROM procurepilot_legacy_importer;
GRANT USAGE ON SCHEMA public TO procurepilot_legacy_importer;

-- ----------------------------------------------------------------------------
-- 2. Schema Alterations on approval_tickets
-- ----------------------------------------------------------------------------

-- Add provenance columns with safe runtime defaults
ALTER TABLE approval_tickets
  ADD COLUMN IF NOT EXISTS source_origin VARCHAR(32) NOT NULL DEFAULT 'RUNTIME',
  ADD COLUMN IF NOT EXISTS integrity_status VARCHAR(32) NOT NULL DEFAULT 'VERIFIED';

-- Drop the NOT NULL constraint on challenge_signature to permit NULL for historical imports
ALTER TABLE approval_tickets
  ALTER COLUMN challenge_signature DROP NOT NULL;

-- Drop any inline CHECK constraints referencing challenge_signature from Migration 001
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'approval_tickets'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%challenge_signature%'
  ) LOOP
    EXECUTE 'ALTER TABLE approval_tickets DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

-- Drop existing provenance check constraints if they exist (for idempotency)
ALTER TABLE approval_tickets
  DROP CONSTRAINT IF EXISTS chk_approval_tickets_source_origin,
  DROP CONSTRAINT IF EXISTS chk_approval_tickets_integrity_status,
  DROP CONSTRAINT IF EXISTS chk_approval_tickets_provenance;

-- Discrete check constraints
ALTER TABLE approval_tickets
  ADD CONSTRAINT chk_approval_tickets_source_origin
    CHECK (source_origin IN ('RUNTIME', 'LEGACY_JSON_IMPORT')),
  ADD CONSTRAINT chk_approval_tickets_integrity_status
    CHECK (integrity_status IN ('VERIFIED', 'UNVERIFIABLE_LEGACY'));

-- Comprehensive database-enforced provenance integrity constraint
-- Runtime records MUST have valid 64-char HMAC signature and VERIFIED status.
-- Historical legacy records MUST have UNVERIFIABLE_LEGACY status and can have NULL or 64-char signature.
ALTER TABLE approval_tickets
  ADD CONSTRAINT chk_approval_tickets_provenance CHECK (
    (
      source_origin = 'RUNTIME' 
      AND integrity_status = 'VERIFIED' 
      AND challenge_signature IS NOT NULL 
      AND challenge_signature ~ '^[a-fA-F0-9]{64}$'
    )
    OR
    (
      source_origin = 'LEGACY_JSON_IMPORT' 
      AND integrity_status = 'UNVERIFIABLE_LEGACY' 
      AND (challenge_signature IS NULL OR challenge_signature ~ '^[a-fA-F0-9]{64}$')
    )
  );

CREATE INDEX IF NOT EXISTS idx_approval_tickets_provenance
  ON approval_tickets(source_origin, integrity_status);

-- ----------------------------------------------------------------------------
-- 3. Migration Execution Audit Trail Table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS legacy_migration_execution_audit (
  id BIGSERIAL PRIMARY KEY,
  operation VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  session_user_val VARCHAR(64) NOT NULL,
  current_user_val VARCHAR(64) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. Controlled Migration Write-Path Functions (SECURITY DEFINER, Truly Immutable)
-- ----------------------------------------------------------------------------

-- 4a. Approval Ticket Import Procedure
CREATE OR REPLACE FUNCTION import_legacy_approval_ticket(
  p_ticket_id VARCHAR(64),
  p_organization_id UUID,
  p_nonce VARCHAR(64),
  p_cart_fingerprint VARCHAR(64),
  p_challenge_signature VARCHAR(64),
  p_verified_subtotal NUMERIC(12, 2),
  p_verified_tax NUMERIC(12, 2),
  p_verified_shipping NUMERIC(12, 2),
  p_verified_total NUMERIC(12, 2),
  p_currency VARCHAR(3),
  p_status VARCHAR(32),
  p_session_token_hash VARCHAR(64),
  p_approver_name VARCHAR(128),
  p_approver_department VARCHAR(128),
  p_purchase_justification TEXT,
  p_identity_tier VARCHAR(64),
  p_expires_at TIMESTAMPTZ,
  p_signed_at TIMESTAMPTZ,
  p_consumed_at TIMESTAMPTZ,
  p_created_at TIMESTAMPTZ
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_existing RECORD;
BEGIN
  -- Strict validation of mandatory historical fields (no fabricated defaults)
  IF p_ticket_id IS NULL OR length(p_ticket_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_ticket_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_organization_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_nonce IS NULL OR length(p_nonce) <> 64 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_nonce must be 64 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cart_fingerprint IS NULL OR length(p_cart_fingerprint) <> 64 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_cart_fingerprint must be 64 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_verified_subtotal IS NULL OR p_verified_subtotal < 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_verified_subtotal' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_verified_tax IS NULL OR p_verified_tax < 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_verified_tax' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_verified_shipping IS NULL OR p_verified_shipping < 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_verified_shipping' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_verified_total IS NULL OR p_verified_total <= 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_verified_total' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_currency IS NULL OR p_currency <> 'USD' THEN
    RAISE EXCEPTION 'Mandatory field missing or unsupported: p_currency' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('PENDING_APPROVAL', 'APPROVED', 'CONSUMED', 'EXPIRED') THEN
    RAISE EXCEPTION 'Mandatory field missing or invalid: p_status' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_identity_tier IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_identity_tier' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_expires_at' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_created_at IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_created_at (historical creation timestamp cannot be synthesized)' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Strict signature validation: non-null signature must match ^[a-fA-F0-9]{64}$ exactly (no trim, no whitespace)
  IF p_challenge_signature IS NOT NULL THEN
    IF p_challenge_signature !~ '^[a-fA-F0-9]{64}$' THEN
      RAISE EXCEPTION 'Signature validation error: non-null challenge signature must match ^[a-fA-F0-9]{64}$ exactly'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- Check if ticket already exists
  SELECT ticket_id, organization_id, nonce, cart_fingerprint, challenge_signature,
         verified_subtotal, verified_tax, verified_shipping, verified_total,
         currency, status, session_token_hash, approver_name, approver_department,
         purchase_justification, identity_tier, expires_at, signed_at, consumed_at,
         created_at, source_origin, integrity_status
  INTO v_existing
  FROM approval_tickets
  WHERE ticket_id = p_ticket_id;

  IF FOUND THEN
    -- Check for identical repeat import (strict equivalence across all fields)
    IF v_existing.organization_id = p_organization_id
       AND v_existing.nonce = p_nonce
       AND v_existing.cart_fingerprint = p_cart_fingerprint
       AND (v_existing.challenge_signature IS NOT DISTINCT FROM p_challenge_signature)
       AND v_existing.verified_subtotal = p_verified_subtotal
       AND v_existing.verified_tax = p_verified_tax
       AND v_existing.verified_shipping = p_verified_shipping
       AND v_existing.verified_total = p_verified_total
       AND v_existing.currency = p_currency
       AND v_existing.status = p_status
       AND (v_existing.session_token_hash IS NOT DISTINCT FROM p_session_token_hash)
       AND (v_existing.approver_name IS NOT DISTINCT FROM p_approver_name)
       AND (v_existing.approver_department IS NOT DISTINCT FROM p_approver_department)
       AND (v_existing.purchase_justification IS NOT DISTINCT FROM p_purchase_justification)
       AND v_existing.identity_tier = p_identity_tier
       AND v_existing.expires_at = p_expires_at
       AND (v_existing.signed_at IS NOT DISTINCT FROM p_signed_at)
       AND (v_existing.consumed_at IS NOT DISTINCT FROM p_consumed_at)
       AND v_existing.created_at = p_created_at
       AND v_existing.source_origin = 'LEGACY_JSON_IMPORT'
       AND v_existing.integrity_status = 'UNVERIFIABLE_LEGACY'
    THEN
      -- Identical repeat import succeeds without modifying anything
      RETURN;
    ELSE
      RAISE EXCEPTION 'Conflicting import for legacy ticket "%": existing record contains conflicting historical data.', p_ticket_id
        USING ERRCODE = 'data_exception';
    END IF;
  END IF;

  -- Record audit trail entry
  INSERT INTO legacy_migration_execution_audit (operation, entity_id, session_user_val, current_user_val)
  VALUES ('IMPORT_APPROVAL_TICKET', p_ticket_id, session_user, current_user);

  -- Insert new historical record with explicit legacy provenance
  INSERT INTO approval_tickets (
    ticket_id,
    organization_id,
    procurement_request_id,
    nonce,
    cart_fingerprint,
    challenge_signature,
    verified_subtotal,
    verified_tax,
    verified_shipping,
    verified_total,
    currency,
    status,
    session_token_hash,
    approver_name,
    approver_department,
    purchase_justification,
    identity_tier,
    expires_at,
    signed_at,
    consumed_at,
    created_at,
    source_origin,
    integrity_status
  ) VALUES (
    p_ticket_id,
    p_organization_id,
    NULL,
    p_nonce,
    p_cart_fingerprint,
    p_challenge_signature, -- stored verbatim without transformation
    p_verified_subtotal,
    p_verified_tax,
    p_verified_shipping,
    p_verified_total,
    p_currency,
    p_status,
    p_session_token_hash,
    p_approver_name,
    p_approver_department,
    p_purchase_justification,
    p_identity_tier,
    p_expires_at,
    p_signed_at,
    p_consumed_at,
    p_created_at,
    'LEGACY_JSON_IMPORT',
    'UNVERIFIABLE_LEGACY'
  );
END;
$$;

-- 4b. Approval Ticket Item Import Procedure
CREATE OR REPLACE FUNCTION import_legacy_approval_ticket_item(
  p_ticket_id VARCHAR(64),
  p_product_id VARCHAR(64),
  p_product_name VARCHAR(255),
  p_quantity INTEGER,
  p_unit_price NUMERIC(12, 2),
  p_line_total NUMERIC(12, 2)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Validate mandatory parameters
  IF p_ticket_id IS NULL OR length(p_ticket_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_ticket_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_product_id IS NULL OR length(p_product_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_product_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_quantity' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Check if exact child item already exists (idempotency)
  IF EXISTS (
    SELECT 1 FROM approval_ticket_items
    WHERE ticket_id = p_ticket_id
      AND product_id = p_product_id
      AND quantity = p_quantity
      AND unit_price = p_unit_price
      AND line_total = p_line_total
  ) THEN
    RETURN;
  END IF;

  -- Record audit trail entry
  INSERT INTO legacy_migration_execution_audit (operation, entity_id, session_user_val, current_user_val)
  VALUES ('IMPORT_APPROVAL_TICKET_ITEM', p_ticket_id || ':' || p_product_id, session_user, current_user);

  INSERT INTO approval_ticket_items (
    ticket_id, product_id, product_name, quantity, unit_price, line_total
  ) VALUES (
    p_ticket_id, p_product_id, p_product_name, p_quantity, p_unit_price, p_line_total
  );
END;
$$;

-- 4c. Order Import Procedure (Complete Field-by-Field Equivalence & Conflict Rejection)
CREATE OR REPLACE FUNCTION import_legacy_order(
  p_order_number VARCHAR(32),
  p_organization_id UUID,
  p_ticket_id VARCHAR(64),
  p_external_order_id VARCHAR(128),
  p_provider VARCHAR(32),
  p_provider_environment VARCHAR(32),
  p_status VARCHAR(32),
  p_authorized_total NUMERIC(12, 2),
  p_authorized_subtotal NUMERIC(12, 2),
  p_authorized_tax NUMERIC(12, 2),
  p_authorized_shipping NUMERIC(12, 2),
  p_currency VARCHAR(3),
  p_approver_name VARCHAR(128),
  p_approver_department VARCHAR(128),
  p_idempotency_key VARCHAR(128),
  p_is_simulated BOOLEAN,
  p_is_simulated_provenance VARCHAR(64),
  p_simulated_reason VARCHAR(128),
  p_created_at TIMESTAMPTZ,
  p_updated_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_existing RECORD;
  v_new_id UUID;
BEGIN
  -- Strict validation of mandatory historical fields
  IF p_order_number IS NULL OR length(p_order_number) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_order_number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_organization_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ticket_id IS NULL OR length(p_ticket_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_ticket_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_external_order_id IS NULL OR length(p_external_order_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_external_order_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_authorized_total IS NULL OR p_authorized_total <= 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_authorized_total' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_currency IS NULL OR p_currency <> 'USD' THEN
    RAISE EXCEPTION 'Mandatory field missing or unsupported: p_currency' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_status' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_created_at IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_created_at' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Check if order already exists
  SELECT id, order_number, organization_id, ticket_id, external_order_id,
         provider, provider_environment, status, authorized_total,
         authorized_subtotal, authorized_tax, authorized_shipping,
         currency, approver_name, approver_department, idempotency_key,
         is_simulated, is_simulated_provenance, simulated_reason,
         source_origin, created_at, updated_at
  INTO v_existing
  FROM orders
  WHERE order_number = p_order_number;

  IF FOUND THEN
    -- Check for identical repeat import (strict equivalence across all fields)
    IF v_existing.organization_id = p_organization_id
       AND v_existing.ticket_id = p_ticket_id
       AND v_existing.external_order_id = p_external_order_id
       AND v_existing.provider = p_provider
       AND v_existing.provider_environment = p_provider_environment
       AND v_existing.status = p_status
       AND v_existing.authorized_total = p_authorized_total
       AND (v_existing.authorized_subtotal IS NOT DISTINCT FROM p_authorized_subtotal)
       AND (v_existing.authorized_tax IS NOT DISTINCT FROM p_authorized_tax)
       AND (v_existing.authorized_shipping IS NOT DISTINCT FROM p_authorized_shipping)
       AND v_existing.currency = p_currency
       AND (v_existing.approver_name IS NOT DISTINCT FROM p_approver_name)
       AND (v_existing.approver_department IS NOT DISTINCT FROM p_approver_department)
       AND (v_existing.idempotency_key IS NOT DISTINCT FROM p_idempotency_key)
       AND v_existing.is_simulated = p_is_simulated
       AND (v_existing.is_simulated_provenance IS NOT DISTINCT FROM p_is_simulated_provenance)
       AND (v_existing.simulated_reason IS NOT DISTINCT FROM p_simulated_reason)
       AND v_existing.source_origin = 'LEGACY_JSON_IMPORT'
       AND v_existing.created_at = p_created_at
       AND v_existing.updated_at = p_updated_at
    THEN
      -- Identical repeat import is a no-op; returns existing ID
      RETURN v_existing.id;
    ELSE
      RAISE EXCEPTION 'Conflicting import for legacy order "%": existing record contains conflicting historical data.', p_order_number
        USING ERRCODE = 'data_exception';
    END IF;
  END IF;

  -- Record audit trail entry
  INSERT INTO legacy_migration_execution_audit (operation, entity_id, session_user_val, current_user_val)
  VALUES ('IMPORT_ORDER', p_order_number, session_user, current_user);

  -- Insert new historical order
  INSERT INTO orders (
    order_number, organization_id, ticket_id, external_order_id, provider,
    provider_environment, status, authorized_total, authorized_subtotal,
    authorized_tax, authorized_shipping, currency, approver_name,
    approver_department, idempotency_key, is_simulated, is_simulated_provenance,
    simulated_reason, source_origin, created_at, updated_at
  ) VALUES (
    p_order_number, p_organization_id, p_ticket_id, p_external_order_id, p_provider,
    p_provider_environment, p_status, p_authorized_total, p_authorized_subtotal,
    p_authorized_tax, p_authorized_shipping, p_currency, p_approver_name,
    p_approver_department, p_idempotency_key, p_is_simulated, p_is_simulated_provenance,
    p_simulated_reason, 'LEGACY_JSON_IMPORT', p_created_at, p_updated_at
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- 4d. Order Item Import Procedure
CREATE OR REPLACE FUNCTION import_legacy_order_item(
  p_organization_id UUID,
  p_order_id UUID,
  p_product_id VARCHAR(64),
  p_product_name VARCHAR(255),
  p_quantity INTEGER,
  p_unit_price NUMERIC(12, 2),
  p_line_total NUMERIC(12, 2)
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Validate mandatory parameters
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_organization_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory field missing: p_order_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_product_id IS NULL OR length(p_product_id) = 0 THEN
    RAISE EXCEPTION 'Mandatory field missing: p_product_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Mandatory field invalid: p_quantity' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Check if exact child item already exists (idempotency)
  IF EXISTS (
    SELECT 1 FROM order_items
    WHERE organization_id = p_organization_id
      AND order_id = p_order_id
      AND product_id = p_product_id
      AND quantity = p_quantity
      AND unit_price = p_unit_price
      AND line_total = p_line_total
  ) THEN
    RETURN;
  END IF;

  -- Record audit trail entry
  INSERT INTO legacy_migration_execution_audit (operation, entity_id, session_user_val, current_user_val)
  VALUES ('IMPORT_ORDER_ITEM', p_order_id::text || ':' || p_product_id, session_user, current_user);

  INSERT INTO order_items (
    organization_id, order_id, product_id, product_name, quantity, unit_price, line_total
  ) VALUES (
    p_organization_id, p_order_id, p_product_id, p_product_name, p_quantity, p_unit_price, p_line_total
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Assign Procedure Ownership to Dedicated Migration Role
-- ----------------------------------------------------------------------------

ALTER FUNCTION import_legacy_approval_ticket(
  VARCHAR(64), UUID, VARCHAR(64), VARCHAR(64), VARCHAR(64),
  NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  VARCHAR(3), VARCHAR(32), VARCHAR(64), VARCHAR(128), VARCHAR(128),
  TEXT, VARCHAR(64), TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) OWNER TO procurepilot_legacy_importer;

ALTER FUNCTION import_legacy_approval_ticket_item(
  VARCHAR(64), VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) OWNER TO procurepilot_legacy_importer;

ALTER FUNCTION import_legacy_order(
  VARCHAR(32), UUID, VARCHAR(64), VARCHAR(128), VARCHAR(32),
  VARCHAR(32), VARCHAR(32), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  NUMERIC(12, 2), VARCHAR(3), VARCHAR(128), VARCHAR(128), VARCHAR(128),
  BOOLEAN, VARCHAR(64), VARCHAR(128), TIMESTAMPTZ, TIMESTAMPTZ
) OWNER TO procurepilot_legacy_importer;

ALTER FUNCTION import_legacy_order_item(
  UUID, UUID, VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) OWNER TO procurepilot_legacy_importer;

-- ----------------------------------------------------------------------------
-- 6. Database-Enforced Provenance Triggers (Superuser Allowlist Removed)
-- ----------------------------------------------------------------------------

-- 6a. Protection for Approval Tickets
CREATE OR REPLACE FUNCTION enforce_approval_provenance_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Enforce strict immutability: historical legacy records can NEVER be updated
  IF TG_OP = 'UPDATE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: legacy approval tickets are strictly immutable and cannot be updated.'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- Enforce strict immutability: historical legacy records can NEVER be deleted
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: legacy approval tickets are strictly immutable and cannot be deleted.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  -- Prevent any execution identity other than procurepilot_legacy_importer from creating or updating records to claim legacy provenance
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.source_origin = 'LEGACY_JSON_IMPORT' OR NEW.integrity_status = 'UNVERIFIABLE_LEGACY' THEN
      IF current_user <> 'procurepilot_legacy_importer' THEN
        RAISE EXCEPTION 'Authorization violation: execution identity "%" cannot create or modify records with legacy provenance. Only procurepilot_legacy_importer is authorized.', current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_approval_provenance ON approval_tickets;
CREATE TRIGGER trg_protect_approval_provenance
  BEFORE INSERT OR UPDATE OR DELETE ON approval_tickets
  FOR EACH ROW
  EXECUTE FUNCTION enforce_approval_provenance_security();

-- 6b. Protection for Approval Ticket Items (Child Records)
CREATE OR REPLACE FUNCTION enforce_approval_ticket_item_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_parent_source_origin VARCHAR(32);
BEGIN
  -- Enforce immutability on UPDATE: child items of legacy tickets can NEVER be updated
  IF TG_OP = 'UPDATE' THEN
    SELECT source_origin INTO v_parent_source_origin FROM approval_tickets WHERE ticket_id = OLD.ticket_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: approval items belonging to legacy approval tickets are strictly immutable and cannot be updated.'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- Enforce immutability on DELETE: child items of legacy tickets can NEVER be deleted
  IF TG_OP = 'DELETE' THEN
    SELECT source_origin INTO v_parent_source_origin FROM approval_tickets WHERE ticket_id = OLD.ticket_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: approval items belonging to legacy approval tickets are strictly immutable and cannot be deleted.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  -- Enforce authorization on INSERT: only procurepilot_legacy_importer can insert child items for legacy tickets
  IF TG_OP = 'INSERT' THEN
    SELECT source_origin INTO v_parent_source_origin FROM approval_tickets WHERE ticket_id = NEW.ticket_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      IF current_user <> 'procurepilot_legacy_importer' THEN
        RAISE EXCEPTION 'Authorization violation: execution identity "%" cannot insert child items for legacy approval tickets. Only procurepilot_legacy_importer is authorized.', current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_approval_ticket_items_provenance ON approval_ticket_items;
CREATE TRIGGER trg_protect_approval_ticket_items_provenance
  BEFORE INSERT OR UPDATE OR DELETE ON approval_ticket_items
  FOR EACH ROW
  EXECUTE FUNCTION enforce_approval_ticket_item_security();

-- 6c. Protection for Orders
CREATE OR REPLACE FUNCTION enforce_order_provenance_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Enforce strict immutability: historical legacy orders can NEVER be updated
  IF TG_OP = 'UPDATE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: legacy orders are strictly immutable and cannot be updated.'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- Enforce strict immutability: historical legacy orders can NEVER be deleted
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: legacy orders are strictly immutable and cannot be deleted.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.source_origin = 'LEGACY_JSON_IMPORT' THEN
      IF current_user <> 'procurepilot_legacy_importer' THEN
        RAISE EXCEPTION 'Authorization violation: execution identity "%" cannot create or modify records with legacy provenance. Only procurepilot_legacy_importer is authorized.', current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_order_provenance ON orders;
CREATE TRIGGER trg_protect_order_provenance
  BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_provenance_security();

-- 6d. Protection for Order Items (Child Records)
CREATE OR REPLACE FUNCTION enforce_order_item_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_parent_source_origin VARCHAR(32);
BEGIN
  -- Enforce immutability on UPDATE: child items of legacy orders can NEVER be updated
  IF TG_OP = 'UPDATE' THEN
    SELECT source_origin INTO v_parent_source_origin FROM orders WHERE id = OLD.order_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: order items belonging to legacy orders are strictly immutable and cannot be updated.'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- Enforce immutability on DELETE: child items of legacy orders can NEVER be deleted
  IF TG_OP = 'DELETE' THEN
    SELECT source_origin INTO v_parent_source_origin FROM orders WHERE id = OLD.order_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: order items belonging to legacy orders are strictly immutable and cannot be deleted.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  -- Enforce authorization on INSERT: only procurepilot_legacy_importer can insert child items for legacy orders
  IF TG_OP = 'INSERT' THEN
    SELECT source_origin INTO v_parent_source_origin FROM orders WHERE id = NEW.order_id;
    IF v_parent_source_origin = 'LEGACY_JSON_IMPORT' THEN
      IF current_user <> 'procurepilot_legacy_importer' THEN
        RAISE EXCEPTION 'Authorization violation: execution identity "%" cannot insert child items for legacy orders. Only procurepilot_legacy_importer is authorized.', current_user
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_order_items_provenance ON order_items;
CREATE TRIGGER trg_protect_order_items_provenance
  BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_item_security();

-- ----------------------------------------------------------------------------
-- 7. Grant & Privilege Isolation
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT ON TABLE approval_tickets, approval_ticket_items TO procurepilot_legacy_importer;
GRANT USAGE, SELECT ON SEQUENCE approval_ticket_items_id_seq TO procurepilot_legacy_importer;
GRANT SELECT, INSERT ON TABLE orders, order_items TO procurepilot_legacy_importer;
GRANT USAGE, SELECT ON SEQUENCE order_items_id_seq TO procurepilot_legacy_importer;
GRANT SELECT, INSERT ON TABLE legacy_migration_execution_audit TO procurepilot_legacy_importer;
GRANT USAGE, SELECT ON SEQUENCE legacy_migration_execution_audit_id_seq TO procurepilot_legacy_importer;

-- Revoke execute on migration functions from PUBLIC and runtime app role
REVOKE ALL ON FUNCTION import_legacy_approval_ticket(
  VARCHAR(64), UUID, VARCHAR(64), VARCHAR(64), VARCHAR(64),
  NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  VARCHAR(3), VARCHAR(32), VARCHAR(64), VARCHAR(128), VARCHAR(128),
  TEXT, VARCHAR(64), TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

REVOKE ALL ON FUNCTION import_legacy_approval_ticket(
  VARCHAR(64), UUID, VARCHAR(64), VARCHAR(64), VARCHAR(64),
  NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  VARCHAR(3), VARCHAR(32), VARCHAR(64), VARCHAR(128), VARCHAR(128),
  TEXT, VARCHAR(64), TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM procurepilot_app;

REVOKE ALL ON FUNCTION import_legacy_approval_ticket_item(
  VARCHAR(64), VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) FROM PUBLIC;

REVOKE ALL ON FUNCTION import_legacy_approval_ticket_item(
  VARCHAR(64), VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) FROM procurepilot_app;

REVOKE ALL ON FUNCTION import_legacy_order(
  VARCHAR(32), UUID, VARCHAR(64), VARCHAR(128), VARCHAR(32),
  VARCHAR(32), VARCHAR(32), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  NUMERIC(12, 2), VARCHAR(3), VARCHAR(128), VARCHAR(128), VARCHAR(128),
  BOOLEAN, VARCHAR(64), VARCHAR(128), TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

REVOKE ALL ON FUNCTION import_legacy_order(
  VARCHAR(32), UUID, VARCHAR(64), VARCHAR(128), VARCHAR(32),
  VARCHAR(32), VARCHAR(32), NUMERIC(12, 2), NUMERIC(12, 2), NUMERIC(12, 2),
  NUMERIC(12, 2), VARCHAR(3), VARCHAR(128), VARCHAR(128), VARCHAR(128),
  BOOLEAN, VARCHAR(64), VARCHAR(128), TIMESTAMPTZ, TIMESTAMPTZ
) FROM procurepilot_app;

REVOKE ALL ON FUNCTION import_legacy_order_item(
  UUID, UUID, VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) FROM PUBLIC;

REVOKE ALL ON FUNCTION import_legacy_order_item(
  UUID, UUID, VARCHAR(64), VARCHAR(255), INTEGER, NUMERIC(12, 2), NUMERIC(12, 2)
) FROM procurepilot_app;
