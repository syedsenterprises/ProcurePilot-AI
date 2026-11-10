import { Product } from './product';

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface CartSummary {
  subtotal: number;
  estimatedTax: number;
  shipping: number;
  total: number;
  itemCount: number;
}

export interface BudgetStatus {
  allocatedBudget: number;
  spent: number;
  remaining: number;
  percentage: number;
  isOverBudget: boolean;
  status: 'safe' | 'warning' | 'exceeded';
}

export interface CartValidationRequest {
  items: Array<{ productId: string; quantity: number }>;
  budgetCap?: number;
  userApprovalConfirmed: boolean;
}

export interface CartValidationResult {
  isValid: boolean;
  verifiedItems: Array<{
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }>;
  verifiedSubtotal: number;
  verifiedTax: number;
  verifiedShipping: number;
  verifiedTotal: number;
  budgetCheck: {
    budgetCap?: number;
    isWithinBudget: boolean;
    remainingBudget?: number;
  };
  humanApprovalRequired: boolean;
  humanApprovalProvided: boolean;
  discrepancies: string[];
  reconciliationTimestamp: string;
}
