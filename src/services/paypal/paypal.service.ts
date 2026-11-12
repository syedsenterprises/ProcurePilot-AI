import { catalogService } from '../catalog/catalog.service';
import { payPalOrderStore, StoredPayPalOrder, hashSessionToken } from './paypal-order-store';
import { approvalService } from '../approval/approval.service';
import {
  PayPalCaptureResponse,
  PayPalEnvironment,
  PayPalOrderCreationRequest,
  PayPalOrderResponse,
  PayPalWebhookHeaders,
  PayPalWebhookVerificationResult,
  PayPalWebhookVerifyRequest,
  PayPalWebhookVerifyResponse
} from '@/types/paypal';
import { auditLogger } from '@/lib/security/audit-logger';

export class PayPalService {
  private static instance: PayPalService;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly environment: PayPalEnvironment;
  private readonly webhookId: string | undefined;

  private constructor() {
    this.clientId = process.env.PAYPAL_CLIENT_ID;
    this.clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    this.environment = (process.env.PAYPAL_ENVIRONMENT as PayPalEnvironment) || 'sandbox';
    this.webhookId = process.env.PAYPAL_WEBHOOK_ID;
  }

  public static getInstance(): PayPalService {
    if (!PayPalService.instance) {
      PayPalService.instance = new PayPalService();
    }
    return PayPalService.instance;
  }

  private getClientId(): string | undefined {
    return process.env.PAYPAL_CLIENT_ID || this.clientId;
  }

  private getClientSecret(): string | undefined {
    return process.env.PAYPAL_CLIENT_SECRET || this.clientSecret;
  }

  public isConfigured(): boolean {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    return Boolean(
      clientId &&
      clientSecret &&
      clientId !== 'undefined' &&
      clientSecret !== 'undefined' &&
      !clientId.includes('your_paypal_client_id') &&
      !clientSecret.includes('your_paypal_client_secret')
    );
  }

  /**
   * Safe development-only simulation isolation.
   * Production configuration MUST strictly reject simulation mode.
   */
  public isSimulationAllowed(): boolean {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    return (
      process.env.ALLOW_PAYPAL_SIMULATION === 'true' ||
      process.env.ENABLE_PAYPAL_SIMULATION === 'true' ||
      process.env.PAYPAL_SIMULATION === 'true' ||
      process.env.NODE_ENV === 'test'
    );
  }

  public getEnvironment(): PayPalEnvironment {
    return this.environment;
  }

  public getWebhookId(): string | undefined {
    return process.env.PAYPAL_WEBHOOK_ID || this.webhookId;
  }

  /**
   * Official PayPal Webhook Signature Verification
   * Calls POST /v1/notifications/verify-webhook-signature
   * Fails closed on any error, timeout, or missing configuration.
   */
  public async verifyWebhookSignature(
    headers: PayPalWebhookHeaders,
    event: Record<string, unknown>,
    webhookIdOverride?: string
  ): Promise<PayPalWebhookVerificationResult> {
    const webhookId = webhookIdOverride || this.getWebhookId();

    if (!webhookId) {
      return {
        isValid: false,
        status: 'ERROR',
        message: 'PayPal webhook ID is not configured.',
        errorCategory: 'MISSING_CONFIGURATION'
      };
    }

    if (
      !headers.authAlgo ||
      !headers.certUrl ||
      !headers.transmissionId ||
      !headers.transmissionSig ||
      !headers.transmissionTime
    ) {
      return {
        isValid: false,
        status: 'FAILURE',
        message: 'Missing required PayPal transmission headers.',
        errorCategory: 'MISSING_HEADERS'
      };
    }

    try {
      const accessToken = await this.getAccessToken();

      const verifyPayload: PayPalWebhookVerifyRequest = {
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event
      };

      const res = await fetch(`${this.getBaseUrl()}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(verifyPayload),
        signal: AbortSignal.timeout(8000)
      });

      if (!res.ok) {
        return {
          isValid: false,
          status: 'ERROR',
          message: `PayPal signature verification endpoint responded with HTTP ${res.status}.`,
          errorCategory: res.status >= 500 ? 'PAYPAL_API_5XX' : 'PAYPAL_API_ERROR'
        };
      }

      const data = (await res.json()) as PayPalWebhookVerifyResponse;

      if (data?.verification_status === 'SUCCESS') {
        return {
          isValid: true,
          status: 'SUCCESS',
          message: 'Webhook signature verified successfully.'
        };
      }

      if (data?.verification_status === 'FAILURE') {
        return {
          isValid: false,
          status: 'FAILURE',
          message: 'Webhook signature verification failed.',
          errorCategory: 'SIGNATURE_INVALID'
        };
      }

      return {
        isValid: false,
        status: 'ERROR',
        message: `Unexpected verification response status: ${data?.verification_status ?? 'unknown'}`,
        errorCategory: 'UNEXPECTED_RESPONSE'
      };
    } catch (err: unknown) {
      const isTimeout =
        err instanceof Error &&
        (err.name === 'TimeoutError' ||
          err.name === 'AbortError' ||
          err.message.toLowerCase().includes('timeout') ||
          err.message.toLowerCase().includes('aborted'));

      return {
        isValid: false,
        status: 'ERROR',
        message: err instanceof Error ? err.message : 'Webhook verification network error',
        errorCategory: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'
      };
    }
  }

  private getBaseUrl(): string {
    return this.environment === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  /**
   * Fetch OAuth 2.0 access token securely on the server
   */
  private async getAccessToken(): Promise<string> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();
    if (!clientId || !clientSecret) {
      throw new Error('PayPal credentials are not configured.');
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(`${this.getBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to retrieve PayPal access token (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.access_token;
  }

  /**
   * SECURITY ENFORCEMENT:
   * 1. Requires valid, short-lived, unconsumed Approval Ticket.
   * 2. Recalculates authoritative prices strictly from the server-side CatalogService.
   * 3. Prevents client pricing tampering.
   * 4. Idempotent with PayPal-Request-Id header.
   */
  public async createOrder(
    request: PayPalOrderCreationRequest,
    securityContext?: { ticketId: string; authToken: string; sessionToken?: string }
  ): Promise<PayPalOrderResponse> {
    if (!securityContext?.ticketId || !securityContext?.authToken) {
      auditLogger.log('APPROVAL_UNAUTHORIZED', 'ERROR', 'Order creation attempted without ticketId or authToken');
      return {
        success: false,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        message: 'Security Policy Violation: Valid approval ticketId and authorization token are required.'
      };
    }

    // 1. Verify and single-use consume the approval ticket
    const ticketCheck = approvalService.verifyAndConsumeTicket(
      securityContext.ticketId,
      securityContext.authToken,
      request.items,
      securityContext.sessionToken
    );

    if (!ticketCheck.isValid) {
      return {
        success: false,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        message: ticketCheck.error || 'Security Error: Approval verification failed.'
      };
    }

    const ticketState = ticketCheck.state;

    // 2. Authoritative Price Reconciliation
    const reconciliation = catalogService.reconcileCart(request.items, undefined, true);
    if (!reconciliation.isValid) {
      return {
        success: false,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        message: `Cart reconciliation failed: ${reconciliation.discrepancies.join('; ')}`
      };
    }

    // 3. Double-check amount matches ticket
    if (reconciliation.verifiedTotal !== ticketState.verifiedTotal) {
      auditLogger.log('APPROVAL_TICKET_MISMATCH', 'CRITICAL', 'Cart total does not match approved ticket', {
        details: { cartTotal: reconciliation.verifiedTotal, ticketTotal: ticketState.verifiedTotal }
      });
      return {
        success: false,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        message: 'Amount Mismatch Violation: Current cart total does not match approved ticket amount.'
      };
    }

    const clientRef = request.clientReferenceId || `PP-ORD-${Date.now()}`;

    // 4. If credentials are not configured
    if (!this.isConfigured()) {
      if (!this.isSimulationAllowed()) {
        auditLogger.log(
          'PAYPAL_ORDER_CREATED',
          'ERROR',
          'PayPal order creation rejected: Missing credentials and simulation mode is disabled'
        );
        return {
          success: false,
          environment: this.environment,
          createdAt: new Date().toISOString(),
          message:
            'Configuration Error: PayPal Sandbox credentials (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET) are missing or invalid in server environment. Payment simulation is disabled.'
        };
      }

      // Development / Test Simulation Path
      const syntheticOrderId = `SANDBOX_STAGE2_${securityContext.ticketId.slice(8, 20)}`;
      const simulatedApprovalUrl = `/dashboard?status=approved&token=${syntheticOrderId}`;
      const sessionHash = securityContext.sessionToken
        ? hashSessionToken(securityContext.sessionToken)
        : undefined;

      const storedOrder: StoredPayPalOrder = {
        orderId: syntheticOrderId,
        ticketId: securityContext.ticketId,
        authorizedTotal: reconciliation.verifiedTotal,
        authorizedSubtotal: reconciliation.verifiedSubtotal,
        authorizedTax: reconciliation.verifiedTax,
        authorizedShipping: reconciliation.verifiedShipping,
        currency: 'USD',
        status: 'CREATED',
        approverName: request.approvalSignoff.userName,
        approverDepartment: request.approvalSignoff.department,
        items: reconciliation.verifiedItems,
        createdAt: new Date().toISOString(),
        idempotencyKey: securityContext.ticketId,
        isSimulated: true,
        sessionHash,
        approvalUrl: simulatedApprovalUrl
      };
      payPalOrderStore.saveOrder(storedOrder);

      auditLogger.log('PAYPAL_ORDER_CREATED', 'WARN', `Simulated sandbox order created (Dev/Test): ${syntheticOrderId}`, {
        details: { total: reconciliation.verifiedTotal, ticketId: securityContext.ticketId, isSimulated: true }
      });

      return {
        success: false,
        orderId: syntheticOrderId,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        totalAmount: {
          currencyCode: 'USD',
          value: reconciliation.verifiedTotal.toFixed(2)
        },
        requiresManualReview: true,
        isSimulated: true,
        simulationNotice:
          'DEVELOPMENT/TEST SIMULATION: This is an unauthenticated mock order for testing purposes. No real or sandbox funds were authorized.',
        approvalUrl: `/dashboard?status=approved&token=${syntheticOrderId}`,
        message:
          'PayPal Sandbox credentials are not yet configured in environment variables. ' +
          'All server-side pricing validations and cryptographic approval checks succeeded. ' +
          'Configure PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local to activate live PayPal Sandbox API communication.'
      };
    }

    // 5. Live PayPal Orders API v2 with Idempotency
    try {
      const accessToken = await this.getAccessToken();

      const orderPayload = {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: clientRef,
            description: `ProcurePilot AI Order - Approved by ${request.approvalSignoff.userName}`,
            amount: {
              currency_code: 'USD',
              value: reconciliation.verifiedTotal.toFixed(2),
              breakdown: {
                item_total: {
                  currency_code: 'USD',
                  value: reconciliation.verifiedSubtotal.toFixed(2)
                },
                tax_total: {
                  currency_code: 'USD',
                  value: reconciliation.verifiedTax.toFixed(2)
                },
                shipping: {
                  currency_code: 'USD',
                  value: reconciliation.verifiedShipping.toFixed(2)
                }
              }
            },
            items: reconciliation.verifiedItems.map((item) => ({
              name: item.name,
              unit_amount: {
                currency_code: 'USD',
                value: item.unitPrice.toFixed(2)
              },
              quantity: item.quantity.toString()
            }))
          }
        ],
        application_context: {
          brand_name: 'ProcurePilot AI',
          landing_page: 'NO_PREFERENCE',
          user_action: 'PAY_NOW',
          return_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard?status=approved`,
          cancel_url: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/dashboard?status=cancelled`
        }
      };

      const res = await fetch(`${this.getBaseUrl()}/v2/checkout/orders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': securityContext.ticketId // Idempotency key bound to single-use ticket
        },
        body: JSON.stringify(orderPayload)
      });

      if (!res.ok) {
        const errorDetails = await res.text();
        auditLogger.log('PAYPAL_ORDER_CREATED', 'ERROR', `PayPal Orders API error: ${errorDetails}`);
        throw new Error(`PayPal Orders API error (${res.status}): ${errorDetails}`);
      }

      const orderData = await res.json();
      const approveLink = orderData.links?.find((link: { rel: string; href: string }) => link.rel === 'approve')?.href;
      const liveSessionHash = securityContext.sessionToken
        ? hashSessionToken(securityContext.sessionToken)
        : undefined;

      const storedOrder: StoredPayPalOrder = {
        orderId: orderData.id,
        ticketId: securityContext.ticketId,
        authorizedTotal: reconciliation.verifiedTotal,
        authorizedSubtotal: reconciliation.verifiedSubtotal,
        authorizedTax: reconciliation.verifiedTax,
        authorizedShipping: reconciliation.verifiedShipping,
        currency: 'USD',
        status: 'CREATED',
        approverName: request.approvalSignoff.userName,
        approverDepartment: request.approvalSignoff.department,
        items: reconciliation.verifiedItems,
        createdAt: orderData.create_time || new Date().toISOString(),
        idempotencyKey: securityContext.ticketId,
        sessionHash: liveSessionHash,
        approvalUrl: approveLink
      };
      payPalOrderStore.saveOrder(storedOrder);

      auditLogger.log('PAYPAL_ORDER_CREATED', 'INFO', `Live PayPal Order created: ${orderData.id}`);

      return {
        success: true,
        orderId: orderData.id,
        status: orderData.status,
        approvalUrl: approveLink,
        totalAmount: {
          currencyCode: 'USD',
          value: reconciliation.verifiedTotal.toFixed(2)
        },
        environment: this.environment,
        createdAt: orderData.create_time || new Date().toISOString()
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown PayPal error';
      return {
        success: false,
        environment: this.environment,
        createdAt: new Date().toISOString(),
        message: `Server-side payment order creation failed: ${errorMessage}`
      };
    }
  }

  /**
   * Server-side order capture with local order verification and duplicate safety
   */
  public async captureOrder(orderId: string): Promise<PayPalCaptureResponse> {
    const localOrder = payPalOrderStore.getOrder(orderId);
    if (!localOrder) {
      auditLogger.log('PAYPAL_AMOUNT_MISMATCH', 'WARN', `Capture attempted on unknown order: ${orderId}`);
      return {
        success: false,
        message: `Order verification failed: Order ${orderId} not found in authoritative order registry.`
      };
    }

    // Duplicate capture protection
    if (localOrder.status === 'CAPTURED') {
      auditLogger.log('PAYPAL_DUPLICATE_CAPTURE_ATTEMPT', 'INFO', `Safe duplicate capture returned for ${orderId}`);
      return {
        success: true,
        orderId: localOrder.orderId,
        captureId: localOrder.captureId || `CAP_${orderId}`,
        status: 'COMPLETED',
        message: 'Order has already been captured successfully (Idempotent response).',
        isSimulated: localOrder.isSimulated,
        orderDetails: this.formatOrderDetails(localOrder)
      };
    }

    if (!this.isConfigured()) {
      if (!this.isSimulationAllowed()) {
        auditLogger.log('PAYPAL_ORDER_CAPTURED', 'ERROR', `Capture rejected for ${orderId}: Missing PayPal credentials and simulation disabled`);
        return {
          success: false,
          message:
            'Configuration Error: PayPal Sandbox credentials are not configured. Payment capture simulation is disabled in this environment.'
        };
      }

      // Simulate capture in unconfigured mode (Dev/Test only)
      localOrder.status = 'CAPTURED';
      localOrder.capturedAt = new Date().toISOString();
      localOrder.captureId = `CAP_${orderId}`;
      localOrder.isSimulated = true;
      payPalOrderStore.saveOrder(localOrder);

      return {
        success: true,
        orderId,
        captureId: localOrder.captureId,
        status: 'COMPLETED',
        isSimulated: true,
        simulationNotice: 'DEVELOPMENT/TEST SIMULATION: Order captured in development simulation mode.',
        message: 'Order verified and captured successfully in Sandbox architecture simulation.',
        orderDetails: this.formatOrderDetails(localOrder)
      };
    }

    try {
      const accessToken = await this.getAccessToken();
      const res = await fetch(`${this.getBaseUrl()}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'PayPal-Request-Id': `CAP-${localOrder.ticketId}`
        }
      });

      if (!res.ok) {
        const errorDetails = await res.text();
        throw new Error(`Capture API failed (${res.status}): ${errorDetails}`);
      }

      const captureData = await res.json();
      const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];

      // Verify captured amount & currency against local authorized order
      const capturedAmount = parseFloat(capture?.amount?.value || '0');
      const capturedCurrency = capture?.amount?.currency_code;

      if (capturedAmount !== localOrder.authorizedTotal || capturedCurrency !== localOrder.currency) {
        auditLogger.log('PAYPAL_AMOUNT_MISMATCH', 'CRITICAL', `Captured amount mismatch for ${orderId}`, {
          details: {
            expected: `${localOrder.authorizedTotal} ${localOrder.currency}`,
            received: `${capturedAmount} ${capturedCurrency}`
          }
        });
        throw new Error('Critical Security Alert: Captured payment amount or currency does not match authorized order.');
      }

      localOrder.status = 'CAPTURED';
      localOrder.capturedAt = new Date().toISOString();
      localOrder.captureId = capture?.id;
      payPalOrderStore.saveOrder(localOrder);

      auditLogger.log('PAYPAL_ORDER_CAPTURED', 'INFO', `Order ${orderId} successfully captured: ${capture?.id}`);

      return {
        success: true,
        orderId: captureData.id,
        captureId: capture?.id,
        status: capture?.status,
        payer: {
          emailAddress: captureData.payer?.email_address,
          payerId: captureData.payer?.payer_id
        },
        transactionFee: capture?.seller_receivable_breakdown?.paypal_fee?.value,
        netAmount: capture?.seller_receivable_breakdown?.net_amount?.value,
        orderDetails: this.formatOrderDetails(localOrder)
      };
    } catch (err: unknown) {
      return {
        success: false,
        message: err instanceof Error ? err.message : 'Order capture failed'
      };
    }
  }

  public formatOrderDetails(order: StoredPayPalOrder) {
    return {
      orderId: order.orderId,
      ticketId: order.ticketId,
      authorizedTotal: order.authorizedTotal,
      authorizedSubtotal: order.authorizedSubtotal,
      authorizedTax: order.authorizedTax,
      authorizedShipping: order.authorizedShipping,
      currency: order.currency,
      status: order.status,
      approverName: order.approverName,
      approverDepartment: order.approverDepartment,
      items: order.items,
      createdAt: order.createdAt,
      capturedAt: order.capturedAt,
      captureId: order.captureId
    };
  }
}

export const payPalService = PayPalService.getInstance();
