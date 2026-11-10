-- ============================================================================
-- Migration: 007_delta_reconciliation_security_hardening.sql
-- Description: Phase 1B.2.3-B.4.2 Security Remediation
--              1. Hardens reconcile_legacy_order_status_transition: revokes
--                 PUBLIC execution, restricts execution to authorized operator
--                 roles, schema-qualifies all table references (public.orders,
--                 public.order_state_transition_audit), sets search_path to
--                 pg_catalog, and adds operator_identity attribution.
--              2. Enforces append-only immutability on order_state_transition_audit
--                 via trigger preventing UPDATE and DELETE.
--              3. Hardens enforce_order_provenance_security trigger to guarantee
--                 no legacy order status changes can bypass the audit procedure.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Schema Alterations on order_state_transition_audit
-- ----------------------------------------------------------------------------
ALTER TABLE public.order_state_transition_audit
  ADD COLUMN IF NOT EXISTS operator_identity VARCHAR(128) NOT NULL DEFAULT 'UNAUTHENTICATED_SYSTEM_CONTEXT';

-- ----------------------------------------------------------------------------
-- 2. Audit Table Immutability Trigger (Strict Append-Only)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_order_state_transition_audit_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'Immutability violation: order_state_transition_audit rows are strictly append-only and cannot be updated or deleted.'
      USING ERRCODE = '22000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_order_state_transition_audit ON public.order_state_transition_audit;
CREATE TRIGGER trg_protect_order_state_transition_audit
  BEFORE UPDATE OR DELETE ON public.order_state_transition_audit
  FOR EACH ROW
  EXECUTE FUNCTION enforce_order_state_transition_audit_immutability();

-- ----------------------------------------------------------------------------
-- 3. Dedicated Operator Role
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'procurepilot_reconciliation_operator') THEN
    CREATE ROLE procurepilot_reconciliation_operator WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE procurepilot_reconciliation_operator WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Hardened Reconcile Order Status Transition Procedure (SECURITY DEFINER)
-- ----------------------------------------------------------------------------
-- Drop existing procedure to update parameter signature cleanly
DROP FUNCTION IF EXISTS reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT);

CREATE OR REPLACE FUNCTION reconcile_legacy_order_status_transition(
  p_order_id UUID,
  p_expected_old_status VARCHAR(32),
  p_new_status VARCHAR(32),
  p_reason TEXT DEFAULT 'CONTROLLED_DELTA_RECONCILIATION',
  p_operator_id VARCHAR(128) DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_current_status VARCHAR(32);
  v_order_number VARCHAR(32);
  v_source_origin VARCHAR(32);
  v_effective_operator VARCHAR(128);
BEGIN
  -- Validate mandatory parameters
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Mandatory parameter missing: p_order_id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new_status IS NULL THEN
    RAISE EXCEPTION 'Mandatory parameter missing: p_new_status' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Establish effective operator attribution
  IF p_operator_id IS NOT NULL AND length(trim(p_operator_id)) > 0 THEN
    v_effective_operator := trim(p_operator_id);
  ELSE
    v_effective_operator := 'UNAUTHENTICATED_SYSTEM_CONTEXT';
  END IF;

  -- Lock and fetch order with schema-qualified public.orders
  SELECT status, order_number, source_origin
  INTO v_current_status, v_order_number, v_source_origin
  FROM public.orders
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

  -- Set transaction-local marker to prove update originated from within this audit procedure
  PERFORM set_config('procurepilot.in_reconcile_transition', 'true', true);

  -- Update order status and timestamp
  UPDATE public.orders
  SET status = p_new_status,
      updated_at = NOW()
  WHERE id = p_order_id;

  -- Record audit trail
  INSERT INTO public.order_state_transition_audit (
    order_id, order_number, old_status, new_status, transition_reason,
    operator_identity, reconciled_at, session_user_val, current_user_val
  ) VALUES (
    p_order_id, v_order_number, v_current_status, p_new_status, p_reason,
    v_effective_operator, NOW(), session_user, current_user
  );
END;
$$;

-- Overload for 4-argument backwards compatibility
CREATE OR REPLACE FUNCTION reconcile_legacy_order_status_transition(
  p_order_id UUID,
  p_expected_old_status VARCHAR(32),
  p_new_status VARCHAR(32),
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM reconcile_legacy_order_status_transition(p_order_id, p_expected_old_status, p_new_status, p_reason, NULL);
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Updated Order Provenance Trigger (Audit Bypass Prevention)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_order_provenance_security()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
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

      -- If status is changing, enforce that it MUST originate from the audit procedure
      IF OLD.status <> NEW.status THEN
        IF COALESCE(current_setting('procurepilot.in_reconcile_transition', true), 'false') <> 'true' THEN
          RAISE EXCEPTION 'Security violation: direct legacy order status updates are strictly prohibited. Updates must be executed via reconcile_legacy_order_status_transition().'
            USING ERRCODE = '42501';
        END IF;

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
-- 6. Role Ownership & Least-Privilege Grants
-- ----------------------------------------------------------------------------
ALTER FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128))
  OWNER TO procurepilot_legacy_importer;
ALTER FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT)
  OWNER TO procurepilot_legacy_importer;

-- Revoke all execute privileges from PUBLIC
REVOKE ALL ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) FROM PUBLIC;

-- Grant execution explicitly to importer and reconciliation operator only
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) TO procurepilot_legacy_importer;
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO procurepilot_legacy_importer;
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) TO procurepilot_reconciliation_operator;
GRANT EXECUTE ON FUNCTION reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO procurepilot_reconciliation_operator;
