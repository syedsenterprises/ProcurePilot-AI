-- ============================================================================
-- Migration 003: Refund Attempt Write-Path Security Closure
-- ProcurePilot AI — Phase 1B.1.3 Security Hardening
-- ============================================================================

-- 1. Ensure Controlled Session Setting Exists & Trigger Function Definition
CREATE OR REPLACE FUNCTION enforce_refund_attempt_security()
RETURNS TRIGGER AS $$
DECLARE
  v_is_controlled BOOLEAN;
BEGIN
  -- Read session setting (defaults to false if not set in transaction)
  v_is_controlled := (COALESCE(current_setting('procurepilot.controlled_refund_context', true), 'false') = 'true');

  -- A. Restrict DELETE on all payment_attempts
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Security Violation: Deletion of payment_attempts is strictly prohibited';
  END IF;

  -- B. Restrict direct INSERT of refund attempts
  IF TG_OP = 'INSERT' THEN
    IF NEW.action_type = 'REFUND' AND NOT v_is_controlled THEN
      RAISE EXCEPTION 'Security Violation: Direct INSERT of refund attempts is prohibited. Use create_refund_reservation()';
    END IF;
    RETURN NEW;
  END IF;

  -- C. Restrict UPDATE on refund attempts
  IF TG_OP = 'UPDATE' THEN
    -- Prevent altering action_type between non-refund and refund
    IF OLD.action_type != NEW.action_type THEN
      RAISE EXCEPTION 'Security Violation: Cannot alter action_type on existing payment attempt';
    END IF;

    -- If this is a refund attempt, apply strict lifecycle and parameter immutability
    IF OLD.action_type = 'REFUND' THEN
      -- Immutable financial reservation fields cannot be rewritten
      IF NEW.order_id != OLD.order_id OR
         NEW.related_capture_id != OLD.related_capture_id OR
         NEW.requested_amount != OLD.requested_amount OR
         NEW.currency != OLD.currency OR
         NEW.idempotency_key != OLD.idempotency_key THEN
        RAISE EXCEPTION 'Security Violation: Immutable financial reservation parameters cannot be modified';
      END IF;

      -- If update is not from a controlled database function, block unauthorized status changes
      IF NOT v_is_controlled THEN
        -- Direct transition to SUCCEEDED is prohibited (must use finalize_refund_settlement)
        IF NEW.status = 'SUCCEEDED' AND OLD.status != 'SUCCEEDED' THEN
          RAISE EXCEPTION 'Security Violation: Direct transition to SUCCEEDED is prohibited. Use finalize_refund_settlement()';
        END IF;

        -- Direct transition to FAILED is prohibited (must use record_refund_failure)
        IF NEW.status = 'FAILED' AND OLD.status != 'FAILED' THEN
          RAISE EXCEPTION 'Security Violation: Direct transition to FAILED is prohibited. Use record_refund_failure()';
        END IF;

        -- OUTCOME_UNKNOWN cannot be casually reset or failed without formal reconciliation
        IF OLD.status = 'OUTCOME_UNKNOWN' AND NEW.status != 'OUTCOME_UNKNOWN' THEN
          RAISE EXCEPTION 'Security Violation: Cannot directly transition OUTCOME_UNKNOWN refund attempt without controlled reconciliation';
        END IF;

        -- Direct transition to OUTCOME_UNKNOWN is prohibited (must use record_refund_outcome_unknown)
        IF NEW.status = 'OUTCOME_UNKNOWN' AND OLD.status != 'OUTCOME_UNKNOWN' THEN
          RAISE EXCEPTION 'Security Violation: Direct transition to OUTCOME_UNKNOWN is prohibited. Use record_refund_outcome_unknown()';
        END IF;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- Install the trigger on payment_attempts
DROP TRIGGER IF EXISTS trg_protect_refund_attempts ON payment_attempts;
CREATE TRIGGER trg_protect_refund_attempts
  BEFORE INSERT OR UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refund_attempt_security();

-- 2. Update create_refund_reservation to activate controlled session context
CREATE OR REPLACE FUNCTION create_refund_reservation(
  p_order_id UUID,
  p_capture_id UUID,
  p_refund_amount NUMERIC(12, 2),
  p_currency VARCHAR(3),
  p_idempotency_key VARCHAR(128),
  p_provider_request_id VARCHAR(128)
) RETURNS TABLE (
  attempt_id UUID,
  is_existing_reservation BOOLEAN,
  available_balance_after NUMERIC(12, 2)
) AS $$
DECLARE
  v_captured_amount NUMERIC(12, 2);
  v_capture_currency VARCHAR(3);
  v_settled_refunds NUMERIC(12, 2);
  v_active_reservations NUMERIC(12, 2);
  v_available_balance NUMERIC(12, 2);
  v_existing_attempt RECORD;
  v_new_attempt_id UUID;
BEGIN
  -- 1. Lock the mutable parent orders row
  PERFORM id FROM orders WHERE id = p_order_id FOR UPDATE;

  -- 2. Check for existing idempotency key
  SELECT id, order_id, related_capture_id, requested_amount, currency, status
  INTO v_existing_attempt
  FROM payment_attempts
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing_attempt.order_id != p_order_id OR
       v_existing_attempt.related_capture_id != p_capture_id OR
       v_existing_attempt.requested_amount != p_refund_amount OR
       v_existing_attempt.currency != p_currency THEN
      RAISE EXCEPTION 'Idempotency Conflict: Key % was already used with conflicting refund parameters', p_idempotency_key;
    END IF;

    SELECT captured_amount INTO v_captured_amount FROM payment_captures WHERE id = p_capture_id;
    SELECT COALESCE(SUM(refund_amount), 0) INTO v_settled_refunds FROM payment_refunds WHERE capture_id = p_capture_id;
    SELECT COALESCE(SUM(requested_amount), 0) INTO v_active_reservations 
    FROM payment_attempts 
    WHERE related_capture_id = p_capture_id 
      AND action_type = 'REFUND' 
      AND status IN ('PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED');

    v_available_balance := v_captured_amount - (v_settled_refunds + v_active_reservations);

    RETURN QUERY SELECT v_existing_attempt.id, TRUE, v_available_balance;
    RETURN;
  END IF;

  -- 3. Read immutable settlement facts from payment_captures
  SELECT captured_amount, currency
  INTO v_captured_amount, v_capture_currency
  FROM payment_captures
  WHERE id = p_capture_id AND order_id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Capture % not found for order %', p_capture_id, p_order_id;
  END IF;

  IF p_currency != v_capture_currency THEN
    RAISE EXCEPTION 'Currency Mismatch: Refund currency % does not match capture currency %', p_currency, v_capture_currency;
  END IF;

  -- 4. Calculate confirmed settled refunds on this capture
  SELECT COALESCE(SUM(refund_amount), 0) INTO v_settled_refunds
  FROM payment_refunds
  WHERE capture_id = p_capture_id;

  -- 5. Calculate active in-flight reservations on this capture
  SELECT COALESCE(SUM(requested_amount), 0) INTO v_active_reservations
  FROM payment_attempts
  WHERE related_capture_id = p_capture_id
    AND action_type = 'REFUND'
    AND status IN ('PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED');

  -- 6. Enforce available balance ceiling
  v_available_balance := v_captured_amount - (v_settled_refunds + v_active_reservations);

  IF p_refund_amount > v_available_balance THEN
    RAISE EXCEPTION 'Integrity Violation: Refund request (%) exceeds available capture balance (%)',
      p_refund_amount, v_available_balance;
  END IF;

  -- 7. Insert the active reservation under controlled context
  PERFORM set_config('procurepilot.controlled_refund_context', 'true', true);

  v_new_attempt_id := gen_random_uuid();
  INSERT INTO payment_attempts (
    id,
    order_id,
    related_capture_id,
    action_type,
    provider,
    idempotency_key,
    provider_request_id,
    requested_amount,
    currency,
    status,
    initiated_at
  ) VALUES (
    v_new_attempt_id,
    p_order_id,
    p_capture_id,
    'REFUND',
    'PAYPAL',
    p_idempotency_key,
    p_provider_request_id,
    p_refund_amount,
    p_currency,
    'PREPARED',
    NOW()
  );

  PERFORM set_config('procurepilot.controlled_refund_context', 'false', true);

  RETURN QUERY SELECT v_new_attempt_id, FALSE, (v_available_balance - p_refund_amount);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 3. Update finalize_refund_settlement to activate controlled session context
CREATE OR REPLACE FUNCTION finalize_refund_settlement(
  p_attempt_id UUID,
  p_external_refund_id VARCHAR(64),
  p_refund_amount NUMERIC(12, 2),
  p_currency VARCHAR(3),
  p_reason TEXT DEFAULT NULL,
  p_refunded_at TIMESTAMPTZ DEFAULT NOW()
) RETURNS TABLE (
  refund_id UUID,
  order_id UUID,
  capture_id UUID,
  new_order_status VARCHAR(32)
) AS $$
DECLARE
  v_attempt RECORD;
  v_capture RECORD;
  v_order RECORD;
  v_already_refunded NUMERIC(12, 2);
  v_total_order_refunded NUMERIC(12, 2);
  v_new_refund_id UUID;
  v_new_status VARCHAR(32);
BEGIN
  -- 1. Read attempt details
  SELECT pa.id, pa.order_id, pa.related_capture_id, pa.requested_amount, pa.currency, pa.status
  INTO v_attempt
  FROM payment_attempts pa
  WHERE pa.id = p_attempt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attempt % not found for settlement finalization', p_attempt_id;
  END IF;

  IF v_attempt.status NOT IN ('PREPARED', 'DISPATCHED', 'OUTCOME_UNKNOWN', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'Invalid Attempt Status: Cannot finalize settlement for attempt % in status %',
      p_attempt_id, v_attempt.status;
  END IF;

  -- 2. Lock parent order to serialize state transition
  SELECT o.id, o.authorized_total, o.status
  INTO v_order
  FROM orders o
  WHERE o.id = v_attempt.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent order % not found', v_attempt.order_id;
  END IF;

  -- 3. Validate capture balance
  SELECT pc.id, pc.captured_amount, pc.currency
  INTO v_capture
  FROM payment_captures pc
  WHERE pc.id = v_attempt.related_capture_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Parent capture % not found', v_attempt.related_capture_id;
  END IF;

  SELECT COALESCE(SUM(pr.refund_amount), 0) INTO v_already_refunded
  FROM payment_refunds pr
  WHERE pr.capture_id = v_attempt.related_capture_id;

  IF (v_already_refunded + p_refund_amount) > v_capture.captured_amount THEN
    RAISE EXCEPTION 'Integrity Violation: Refund settlement (%) exceeds capture headroom (%)',
      p_refund_amount, (v_capture.captured_amount - v_already_refunded);
  END IF;

  -- 4. Set controlled context
  PERFORM set_config('procurepilot.controlled_refund_context', 'true', true);

  -- 5. Insert immutable record into payment_refunds
  v_new_refund_id := gen_random_uuid();
  INSERT INTO payment_refunds (
    id,
    order_id,
    capture_id,
    payment_attempt_id,
    external_refund_id,
    refund_amount,
    currency,
    reason,
    refunded_at,
    created_at
  ) VALUES (
    v_new_refund_id,
    v_attempt.order_id,
    v_attempt.related_capture_id,
    p_attempt_id,
    p_external_refund_id,
    p_refund_amount,
    p_currency,
    p_reason,
    p_refunded_at,
    NOW()
  );

  -- 6. Transition attempt status to SUCCEEDED
  UPDATE payment_attempts
  SET status = 'SUCCEEDED',
      completed_at = NOW()
  WHERE id = p_attempt_id;

  -- 7. Recompute total order refund status
  SELECT COALESCE(SUM(pr.refund_amount), 0) INTO v_total_order_refunded
  FROM payment_refunds pr
  WHERE pr.order_id = v_attempt.order_id;

  IF v_total_order_refunded >= v_order.authorized_total THEN
    v_new_status := 'REFUNDED';
  ELSE
    v_new_status := 'PARTIALLY_REFUNDED';
  END IF;

  UPDATE orders
  SET status = v_new_status,
      updated_at = NOW()
  WHERE id = v_attempt.order_id;

  -- 8. Record payment event
  INSERT INTO payment_events (
    order_id,
    event_type,
    previous_status,
    new_status,
    amount,
    context,
    occurred_at
  ) VALUES (
    v_attempt.order_id,
    'REFUND_SETTLED',
    v_order.status,
    v_new_status,
    p_refund_amount,
    jsonb_build_object(
      'attempt_id', p_attempt_id,
      'external_refund_id', p_external_refund_id,
      'capture_id', v_attempt.related_capture_id,
      'refund_id', v_new_refund_id
    ),
    NOW()
  );

  PERFORM set_config('procurepilot.controlled_refund_context', 'false', true);

  RETURN QUERY SELECT v_new_refund_id, v_attempt.order_id, v_attempt.related_capture_id, v_new_status;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 4. Controlled Failure Function: Releases Headroom Only After Validated Failure
CREATE OR REPLACE FUNCTION record_refund_failure(
  p_attempt_id UUID,
  p_error_message TEXT,
  p_error_code VARCHAR(64) DEFAULT NULL,
  p_reconciliation_cleared BOOLEAN DEFAULT FALSE
) RETURNS TABLE (
  attempt_id UUID,
  released_amount NUMERIC(12, 2)
) AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  -- Read attempt
  SELECT pa.id, pa.order_id, pa.action_type, pa.requested_amount, pa.status
  INTO v_attempt
  FROM payment_attempts pa
  WHERE pa.id = p_attempt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attempt % not found for failure recording', p_attempt_id;
  END IF;

  IF v_attempt.action_type != 'REFUND' THEN
    RAISE EXCEPTION 'Attempt % is not a refund attempt', p_attempt_id;
  END IF;

  -- Lock parent order row
  PERFORM id FROM orders WHERE id = v_attempt.order_id FOR UPDATE;

  -- Validate lifecycle preconditions
  IF v_attempt.status = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Security Violation: Cannot mark a settled SUCCEEDED refund attempt as FAILED';
  END IF;

  IF v_attempt.status = 'FAILED' THEN
    -- Idempotent failure recording
    RETURN QUERY SELECT v_attempt.id, 0.00;
    RETURN;
  END IF;

  IF v_attempt.status = 'OUTCOME_UNKNOWN' AND NOT p_reconciliation_cleared THEN
    RAISE EXCEPTION 'Security Violation: Cannot fail OUTCOME_UNKNOWN refund attempt without p_reconciliation_cleared=TRUE';
  END IF;

  -- Execute failure transition under controlled context
  PERFORM set_config('procurepilot.controlled_refund_context', 'true', true);

  UPDATE payment_attempts
  SET status = 'FAILED',
      completed_at = NOW(),
      error_message = p_error_message
  WHERE id = p_attempt_id;

  -- Emit payment event
  INSERT INTO payment_events (
    order_id,
    event_type,
    previous_status,
    new_status,
    amount,
    context,
    occurred_at
  ) VALUES (
    v_attempt.order_id,
    'REFUND_FAILED',
    v_attempt.status,
    'FAILED',
    v_attempt.requested_amount,
    jsonb_build_object(
      'attempt_id', p_attempt_id,
      'error_code', p_error_code,
      'error_message', p_error_message,
      'reconciliation_cleared', p_reconciliation_cleared
    ),
    NOW()
  );

  PERFORM set_config('procurepilot.controlled_refund_context', 'false', true);

  RETURN QUERY SELECT v_attempt.id, v_attempt.requested_amount;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 5. Controlled Ambiguous Outcome Transition Function
CREATE OR REPLACE FUNCTION record_refund_outcome_unknown(
  p_attempt_id UUID,
  p_reason TEXT
) RETURNS TABLE (
  attempt_id UUID
) AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  -- Read attempt
  SELECT pa.id, pa.order_id, pa.action_type, pa.requested_amount, pa.status
  INTO v_attempt
  FROM payment_attempts pa
  WHERE pa.id = p_attempt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attempt % not found for outcome_unknown transition', p_attempt_id;
  END IF;

  IF v_attempt.action_type != 'REFUND' THEN
    RAISE EXCEPTION 'Attempt % is not a refund attempt', p_attempt_id;
  END IF;

  -- Lock parent order
  PERFORM id FROM orders WHERE id = v_attempt.order_id FOR UPDATE;

  IF v_attempt.status NOT IN ('PREPARED', 'DISPATCHED') THEN
    RAISE EXCEPTION 'Invalid Attempt Status: Cannot transition attempt % from status % to OUTCOME_UNKNOWN',
      p_attempt_id, v_attempt.status;
  END IF;

  -- Execute transition under controlled context
  PERFORM set_config('procurepilot.controlled_refund_context', 'true', true);

  UPDATE payment_attempts
  SET status = 'OUTCOME_UNKNOWN',
      error_message = p_reason
  WHERE id = p_attempt_id;

  INSERT INTO payment_events (
    order_id,
    event_type,
    previous_status,
    new_status,
    amount,
    context,
    occurred_at
  ) VALUES (
    v_attempt.order_id,
    'REFUND_OUTCOME_UNKNOWN',
    v_attempt.status,
    'OUTCOME_UNKNOWN',
    v_attempt.requested_amount,
    jsonb_build_object('attempt_id', p_attempt_id, 'reason', p_reason),
    NOW()
  );

  PERFORM set_config('procurepilot.controlled_refund_context', 'false', true);

  RETURN QUERY SELECT v_attempt.id;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 6. Strict Least-Privilege Grants for Functions & Schema
REVOKE ALL ON FUNCTION enforce_refund_attempt_security() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_refund_settlement(UUID, VARCHAR, NUMERIC, VARCHAR, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_refund_failure(UUID, TEXT, VARCHAR, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_refund_outcome_unknown(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION enforce_refund_attempt_security() TO procurepilot_app;
GRANT EXECUTE ON FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) TO procurepilot_app;
GRANT EXECUTE ON FUNCTION finalize_refund_settlement(UUID, VARCHAR, NUMERIC, VARCHAR, TEXT, TIMESTAMPTZ) TO procurepilot_app;
GRANT EXECUTE ON FUNCTION record_refund_failure(UUID, TEXT, VARCHAR, BOOLEAN) TO procurepilot_app;
GRANT EXECUTE ON FUNCTION record_refund_outcome_unknown(UUID, TEXT) TO procurepilot_app;

-- Revoke schema creation from PUBLIC and procurepilot_app to prevent function replacement
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM procurepilot_app;
