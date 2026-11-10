import { z } from 'zod';

export const ProductIdSchema = z
  .string()
  .min(1, 'Product ID must not be empty')
  .max(64, 'Product ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Product ID contains invalid characters');

export const CartItemInputSchema = z
  .object({
    productId: ProductIdSchema,
    quantity: z
      .number()
      .int('Quantity must be an integer')
      .min(1, 'Quantity must be at least 1')
      .max(999, 'Quantity exceeds maximum allowable limit of 999')
  })
  .strict();

export const CartValidateRequestSchema = z
  .object({
    items: z
      .array(CartItemInputSchema)
      .min(1, 'Cart must contain at least 1 item')
      .max(50, 'Cart item limit exceeded (maximum 50 unique items)'),
    budgetCap: z
      .number()
      .positive('Budget cap must be a positive number')
      .max(10_000_000, 'Budget cap exceeds allowable threshold')
      .optional(),
    userApprovalConfirmed: z.boolean().optional()
  })
  .strict();

export const ProcurementRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2, 'Query must be at least 2 characters long')
      .max(1000, 'Query must not exceed 1000 characters'),
    budgetLimit: z
      .number()
      .positive('Budget limit must be a positive number')
      .max(10_000_000, 'Budget limit exceeds maximum threshold')
      .optional(),
    department: z
      .string()
      .trim()
      .min(1, 'Department name must not be empty')
      .max(100, 'Department name must not exceed 100 characters')
      .optional(),
    urgency: z.enum(['immediate', 'standard', 'flexible']).optional()
  })
  .strict();

export const ApprovalChallengeRequestSchema = z
  .object({
    items: z
      .array(CartItemInputSchema)
      .min(1, 'At least one item is required to generate an approval challenge')
      .max(50, 'Maximum of 50 items allowed in approval challenge'),
    budgetCap: z
      .number()
      .positive('Budget cap must be positive')
      .max(10_000_000)
      .optional()
  })
  .strict();

export const ApprovalSignoffSchema = z
  .object({
    userName: z
      .string()
      .trim()
      .min(2, 'Approver name must be at least 2 characters')
      .max(100, 'Approver name exceeds 100 characters'),
    department: z
      .string()
      .trim()
      .min(2, 'Department must be at least 2 characters')
      .max(100, 'Department exceeds 100 characters'),
    purchaseJustification: z
      .string()
      .trim()
      .min(5, 'Purchase justification must be at least 5 characters')
      .max(500, 'Purchase justification exceeds 500 characters')
  })
  .strict();

export const ApprovalSignRequestSchema = z
  .object({
    ticketId: z.string().min(10).max(128),
    cartFingerprint: z.string().min(32).max(128),
    nonce: z.string().min(16).max(128),
    signature: z.string().min(32).max(128),
    signoff: ApprovalSignoffSchema
  })
  .strict();

export const PayPalCreateOrderSchema = z
  .object({
    ticketId: z.string().min(10).max(128),
    authToken: z.string().min(32).max(128),
    items: z.array(CartItemInputSchema).min(1).max(50),
    approvalSignoff: ApprovalSignoffSchema,
    clientReferenceId: z.string().max(100).optional(),
    currency: z.literal('USD').default('USD')
  })
  .strict();

export const PayPalCaptureOrderSchema = z
  .object({
    orderId: z
      .string()
      .trim()
      .min(5, 'PayPal order ID is too short')
      .max(64, 'PayPal order ID is too long')
      .regex(/^[a-zA-Z0-9_-]+$/, 'PayPal order ID contains invalid characters')
  })
  .strict();
