import { ProductRecommendation, ProcurementReasoningStep } from '@/types/procurement';

export interface GeminiProcurementPromptContext {
  query: string;
  budgetLimit?: number;
  department?: string;
  urgency?: string;
  availableProducts: Array<{
    id: string;
    name: string;
    category: string;
    price: number;
    specifications: Record<string, string>;
    shortDescription: string;
  }>;
}

export interface GeminiProcurementResult {
  summary: string;
  detectedBudget?: number;
  recommendations: ProductRecommendation[];
  bundleTotal: number;
  reasoningSteps: ProcurementReasoningStep[];
  isAiConnected: boolean;
  provider: 'gemini-api' | 'procurepilot-heuristic-engine';
  aiStatus: 'live' | 'fallback' | 'not_configured';
  aiError?: {
    statusCode?: number;
    message: string;
    attemptsMade?: number;
  };
  modelUsed?: string;
  warningNote?: string;
  toolCallsExecuted?: Array<{
    toolName: string;
    args: Record<string, unknown>;
    isSuccess: boolean;
  }>;
}
