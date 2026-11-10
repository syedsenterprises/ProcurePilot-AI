import { Product } from './product';

export interface ProductRecommendation {
  productId: string;
  product: Product;
  matchScore: number; // 0 to 100
  reason: string;
  quantityRecommended: number;
  highlightedSpec?: string;
}

export interface ProcurementReasoningStep {
  step: number;
  phase: 'parsing' | 'retrieval' | 'constraint_solving' | 'synthesis';
  title: string;
  detail: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ProcurementMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  budgetConstraint?: number;
  reasoningSteps?: ProcurementReasoningStep[];
  recommendations?: ProductRecommendation[];
  totalBundlePrice?: number;
  provider: 'gemini-api' | 'procurepilot-heuristic-engine';
  aiStatus?: 'live' | 'fallback' | 'not_configured';
  aiError?: {
    statusCode?: number;
    message: string;
    attemptsMade?: number;
  };
  modelUsed?: string;
}

export interface ProcurementRequest {
  query: string;
  budgetLimit?: number;
  department?: string;
  urgency?: 'immediate' | 'standard' | 'flexible';
  focusCategories?: string[];
}

export interface ProcurementResponse {
  success: boolean;
  messageId: string;
  summary: string;
  extractedBudget?: number;
  recommendations: ProductRecommendation[];
  bundleTotal: number;
  reasoningSteps: ProcurementReasoningStep[];
  provider: 'gemini-api' | 'procurepilot-heuristic-engine';
  isAiConnected: boolean;
  aiStatus: 'live' | 'fallback' | 'not_configured';
  aiError?: {
    statusCode?: number;
    message: string;
    attemptsMade?: number;
  };
  modelUsed?: string;
  warnings?: string[];
}
