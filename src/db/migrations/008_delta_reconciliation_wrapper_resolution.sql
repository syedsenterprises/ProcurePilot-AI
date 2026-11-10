-- ============================================================================
-- Migration: 008_delta_reconciliation_wrapper_resolution.sql
-- Description: Phase 1B.2.3-B.4.2.2 Security Correction
--              1. Re-creates both the 5-argument and 4-argument procedures for
--                 reconcile_legacy_order_status_transition without parameter
--                 defaults to eliminate PostgreSQL overload resolution ambiguity.
--              2. Explicitly schema-qualifies the internal delegation
--                 (public.reconcile_legacy_order_status_transition) so it
--                 resolves cleanly under SET search_path = pg_catalog.
--              3. Preserves SECURITY DEFINER, table immutability triggers,
--                 ownership (procurepilot_legacy_importer), revokes from PUBLIC,
--                 and grants strictly to authorized operator roles.
-- ============================================================================

-- Drop existing functions to remove any parameter defaults from Migration 007
DROP FUNCTION IF EXISTS public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128));
DROP FUNCTION IF EXISTS public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT);

-- 1. Canonical 5-argument reconciliation procedure (NO parameter defaults to prevent overload ambiguity)
CREATE OR REPLACE FUNCTION public.reconcile_legacy_order_status_transition(
  p_order_id UUID,
  p_expected_old_status VARCHAR(32),
  p_new_status VARCHAR(32),
  p_reason TEXT,
  p_operator_id VARCHAR(128)
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

-- 2. 4-argument backwards-compatibility overload
CREATE OR REPLACE FUNCTION public.reconcile_legacy_order_status_transition(
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
  PERFORM public.reconcile_legacy_order_status_transition(
    p_order_id,
    p_expected_old_status,
    p_new_status,
    p_reason,
    NULL::VARCHAR(128)
  );
END;
$$;

-- 3. Ownership and Permissions
ALTER FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128))
  OWNER TO procurepilot_legacy_importer;
ALTER FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT)
  OWNER TO procurepilot_legacy_importer;

REVOKE ALL ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) TO procurepilot_legacy_importer;
GRANT EXECUTE ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO procurepilot_legacy_importer;

GRANT EXECUTE ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT, VARCHAR(128)) TO procurepilot_reconciliation_operator;
GRANT EXECUTE ON FUNCTION public.reconcile_legacy_order_status_transition(UUID, VARCHAR(32), VARCHAR(32), TEXT) TO procurepilot_reconciliation_operator;
