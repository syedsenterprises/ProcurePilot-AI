-- ============================================================================
-- Migration 002: Refund Reservation Integrity and Concurrency Protection
-- ProcurePilot AI — Phase 1B.1 Authoritative Refund Invariants
-- ============================================================================

-- 1. Add explicit typed columns to payment_attempts for refund reservations
ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS related_capture_id UUID REFERENCES payment_captures(id),
  ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(12, 2) CHECK (requested_amount > 0),
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD' CHECK (currency = 'USD');

CREATE INDEX IF NOT EXISTS idx_payment_attempts_capture_refund ON payment_attempts(related_capture_id, action_type, status);

-- 2. Database-enforced Refund Reservation Stored Function
-- Guarantees parent-order row locking, per-capture balance checking, and idempotency
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
  -- Serializes all refund operations on this order without touching payment_captures UPDATE privileges
  PERFORM id FROM orders WHERE id = p_order_id FOR UPDATE;

  -- 2. Check for existing idempotency key
  SELECT id, order_id, related_capture_id, requested_amount, currency, status
  INTO v_existing_attempt
  FROM payment_attempts
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    -- Verify parameters match (conflicting reuse rejection)
    IF v_existing_attempt.order_id != p_order_id OR
       v_existing_attempt.related_capture_id != p_capture_id OR
       v_existing_attempt.requested_amount != p_refund_amount OR
       v_existing_attempt.currency != p_currency THEN
      RAISE EXCEPTION 'Idempotency Conflict: Key % was already used with conflicting refund parameters', p_idempotency_key;
    END IF;

    -- Calculate remaining balance
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

  -- 7. Insert the active reservation into payment_attempts
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

  RETURN QUERY SELECT v_new_attempt_id, FALSE, (v_available_balance - p_refund_amount);
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 3. Controlled Settlement Finalization Function
-- Atomically inserts immutable refund record, transitions attempt to SUCCEEDED, updates order status, and logs event
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

  -- 4. Insert immutable record into payment_refunds
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

  -- 5. Transition attempt status to SUCCEEDED
  UPDATE payment_attempts
  SET status = 'SUCCEEDED',
      completed_at = NOW()
  WHERE id = p_attempt_id;

  -- 6. Recompute total order refund status
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

  -- 7. Record payment event
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

  RETURN QUERY SELECT v_new_refund_id, v_attempt.order_id, v_attempt.related_capture_id, v_new_status;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

-- 4. Trigger Function on payment_refunds: Final Defense-in-Depth Balance Ceiling
CREATE OR REPLACE FUNCTION check_refund_balance_trigger() 
RETURNS TRIGGER AS $$
DECLARE
  v_captured_amount NUMERIC(12, 2);
  v_already_refunded NUMERIC(12, 2);
BEGIN
  -- Read immutable capture amount
  SELECT captured_amount INTO v_captured_amount
  FROM payment_captures
  WHERE id = NEW.capture_id;

  -- Sum settled refunds excluding current row
  SELECT COALESCE(SUM(refund_amount), 0) INTO v_already_refunded
  FROM payment_refunds
  WHERE capture_id = NEW.capture_id AND id != NEW.id;

  IF (v_already_refunded + NEW.refund_amount) > v_captured_amount THEN
    RAISE EXCEPTION 'Integrity Violation: Cumulative refunds (%) exceed captured settlement (%)',
      (v_already_refunded + NEW.refund_amount), v_captured_amount;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_enforce_refund_balance ON payment_refunds;

CREATE TRIGGER trg_enforce_refund_balance
  BEFORE INSERT OR UPDATE ON payment_refunds
  FOR EACH ROW
  EXECUTE FUNCTION check_refund_balance_trigger();

-- 5. Immutability Protection Triggers for Ledger Tables
-- Strictly prevents UPDATE and DELETE on payment_captures and payment_refunds
CREATE OR REPLACE FUNCTION prevent_immutable_record_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Security Violation: Immutable ledger table % does not permit % operations',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_immutable_payment_captures ON payment_captures;
CREATE TRIGGER trg_immutable_payment_captures
  BEFORE UPDATE OR DELETE ON payment_captures
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_record_mutation();

DROP TRIGGER IF EXISTS trg_immutable_payment_refunds ON payment_refunds;
CREATE TRIGGER trg_immutable_payment_refunds
  BEFORE UPDATE OR DELETE ON payment_refunds
  FOR EACH ROW
  EXECUTE FUNCTION prevent_immutable_record_mutation();

-- 6. Runtime Role Provisioning & Least-Privilege Grants
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'procurepilot_app') THEN
    CREATE ROLE procurepilot_app WITH LOGIN PASSWORD 'procurepilot_app_pass_test';
  END IF;
END $$;

-- Revoke default public execution privileges on sensitive financial functions
REVOKE ALL ON FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_refund_settlement(UUID, VARCHAR, NUMERIC, VARCHAR, TEXT, TIMESTAMPTZ) FROM PUBLIC;

-- Grant EXECUTE exclusively to runtime application role
GRANT EXECUTE ON FUNCTION create_refund_reservation(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, VARCHAR) TO procurepilot_app;
GRANT EXECUTE ON FUNCTION finalize_refund_settlement(UUID, VARCHAR, NUMERIC, VARCHAR, TEXT, TIMESTAMPTZ) TO procurepilot_app;

-- Grant standard operational privileges to procurepilot_app
GRANT USAGE ON SCHEMA public TO procurepilot_app;
GRANT SELECT, INSERT, UPDATE ON TABLE orders, order_items, payment_attempts, payment_events, webhook_events, webhook_transmissions, audit_events, procurement_requests, approval_tickets, approval_ticket_items, organizations TO procurepilot_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO procurepilot_app;

-- Grant read-only access on immutable financial ledgers to procurepilot_app (direct INSERT/UPDATE/DELETE restricted)
GRANT SELECT ON TABLE payment_captures, payment_refunds TO procurepilot_app;
