-- ============================================================================
-- Migration: 006_controlled_delta_reconciliation.sql
-- Description: Phase 1B.2.3-B.4 Controlled Delta Reconciliation Schema
--              Permits legitimate state-machine status transitions on legacy orders
--              while strictly enforcing immutability of financial amounts, items,
--              identities, and provenance. Adds order_state_transition_audit table,
--              reconcile_legacy_order_status_transition procedure, and harmonizes
--              runtime order provenance constraints.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create Order State Transition Audit Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_state_transition_audit (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_number VARCHAR(32) NOT NULL,
  old_status VARCHAR(32) NOT NULL,
  new_status VARCHAR(32) NOT NULL,
  transition_reason TEXT,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_user_val VARCHAR(64) NOT NULL,
  current_user_val VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_state_transition_audit_order_id
  ON order_state_transition_audit(order_id);

CREATE INDEX IF NOT EXISTS idx_order_state_transition_audit_reconciled_at
  ON order_state_transition_audit(reconciled_at);

-- ----------------------------------------------------------------------------
-- 2. Harmonize Order source_origin Check Constraint
-- ----------------------------------------------------------------------------
-- Permits 'ONLINE_CHECKOUT', 'RUNTIME', and 'LEGACY_JSON_IMPORT'
DO $$
BEGIN
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_origin_check;
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_source_origin;
  ALTER TABLE orders ADD CONSTRAINT chk_orders_source_origin
    CHECK (source_origin IN ('ONLINE_CHECKOUT', 'RUNTIME', 'LEGACY_JSON_IMPORT'));
END $$;

-- ----------------------------------------------------------------------------
-- 3. Dedicated Reconcile Order Status Transition Procedure (SECURITY DEFINER)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_legacy_order_status_transition(
  p_order_id UUID,
  p_expected_old_status VARCHAR(32),
  p_new_status VARCHAR(32),
  p_reason TEXT DEFAULT 'CONTROLLED_DELTA_RECONCILIATION'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_status VARCHAR(32);
  v_order_number VARCHAR(32);
  v_source_origin VARCHAR(32);
BEGIN
  -- Validate mandatory parameters
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory parameter missing: p_order_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new_status IS NULL THEN
    RAISE EXCEPTION 'Mandatory parameter missing: p_new_status' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock and fetch order
  SELECT status, order_number, source_origin
  INTO v_current_status, v_order_number, v_source_origin
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found for reconciliation: %', p_order_id USING ERRCODE = 'data_exception';
  END IF;

  -- Verify expected current status to prevent race conditions
  IF p_expected_old_status IS NOT NULL AND v_current_status <> p_expected_old_status THEN
    RAISE EXCEPTION 'State mismatch for order %: expected status %, found %',
      v_order_number, p_expected_old_status, v_current_status USING ERRCODE = 'data_exception';
  END IF;

  -- Idempotent no-op
  IF v_current_status = p_new_status THEN
    RETURN;
  END IF;

  -- Update order status and timestamp
  UPDATE orders
  SET status = p_new_status,
      updated_at = NOW()
  WHERE id = p_order_id;

  -- Record audit trail
  INSERT INTO order_state_transition_audit (
    order_id, order_number, old_status, new_status, transition_reason,
    reconciled_at, session_user_val, current_user_val
  ) VALUES (
    p_order_id, v_order_number, v_current_status, p_new_status, p_reason,
    NOW(), session_user, current_user
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Update Order Provenance Security Trigger to Permit Canonical Status Transitions
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_order_provenance_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- 1. DELETE is strictly prohibited on legacy orders
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      RAISE EXCEPTION 'Immutability violation: legacy orders are strictly immutable and cannot be deleted.'
        USING ERRCODE = '22000';
    END IF;
    RETURN OLD;
  END IF;

  -- 2. UPDATE validation
  IF TG_OP = 'UPDATE' THEN
    IF OLD.source_origin = 'LEGACY_JSON_IMPORT' THEN
      -- Strict assertion: All immutable fields must NEVER change
      IF OLD.id <> NEW.id
         OR OLD.order_number <> NEW.order_number
         OR OLD.organization_id <> NEW.organization_id
         OR OLD.ticket_id <> NEW.ticket_id
         OR OLD.external_order_id <> NEW.external_order_id
         OR OLD.provider <> NEW.provider
         OR OLD.provider_environment <> NEW.provider_environment
         OR OLD.authorized_total <> NEW.authorized_total
         OR OLD.authorized_subtotal <> NEW.authorized_subtotal
         OR OLD.authorized_tax <> NEW.authorized_tax
         OR OLD.authorized_shipping <> NEW.authorized_shipping
         OR OLD.currency <> NEW.currency
         OR OLD.source_origin <> NEW.source_origin
         OR OLD.created_at <> NEW.created_at
         OR OLD.is_simulated IS DISTINCT FROM NEW.is_simulated
         OR OLD.is_simulated_provenance IS DISTINCT FROM NEW.is_simulated_provenance
         OR OLD.simulated_reason IS DISTINCT FROM NEW.simulated_reason
      THEN
        RAISE EXCEPTION 'Immutability violation: immutable fields of legacy orders cannot be modified.'
          USING ERRCODE = '22000';
      END IF;

      -- If status is changing, enforce the authoritative 12-state order state machine
      IF OLD.status <> NEW.status THEN
        -- Verify transition validity according to canonical graph:
        IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('PENDING_PAYMENT_APPROVAL', 'CREATION_RECONCILIATION_REQUIRED', 'CANCELLED', 'FAILED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'CREATION_RECONCILIATION_REQUIRED' AND NEW.status NOT IN ('PENDING_PAYMENT_APPROVAL', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'PENDING_PAYMENT_APPROVAL' AND NEW.status NOT IN ('BUYER_APPROVED', 'EXPIRED', 'CANCELLED', 'FAILED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'BUYER_APPROVED' AND NEW.status NOT IN ('SETTLING', 'CANCELLED', 'FAILED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'SETTLING' AND NEW.status NOT IN ('COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'COMPLETED' AND NEW.status NOT IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'RECONCILIATION_REQUIRED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status NOT IN ('PARTIALLY_REFUNDED', 'REFUNDED', 'RECONCILIATION_REQUIRED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status = 'RECONCILIATION_REQUIRED' AND NEW.status NOT IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition order from "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        ELSIF OLD.status IN ('REFUNDED', 'CANCELLED', 'EXPIRED', 'FAILED') THEN
          RAISE EXCEPTION 'Invalid Order Status Transition: Cannot transition terminal state "%" to "%"', OLD.status, NEW.status USING ERRCODE = '22000';
        END IF;
      END IF;
    END IF;
  END IF;

  -- 3. INSERT authorization for legacy provenance
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

-- ----------------------------------------------------------------------------
-- 5. Role Grants & Isolation
-- ----------------------------------------------------------------------------
ALTER FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT)
  OWNER TO procurepilot_legacy_importer;

GRANT SELECT, UPDATE (status, updated_at) ON orders TO procurepilot_legacy_importer;
GRANT SELECT, INSERT ON order_state_transition_audit TO procurepilot_legacy_importer;
GRANT USAGE, SELECT ON SEQUENCE order_state_transition_audit_id_seq TO procurepilot_legacy_importer;
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO procurepilot_legacy_importer;
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO PUBLIC;
