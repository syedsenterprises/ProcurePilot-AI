import { catalogService } from '../catalog/catalog.service';
import { GeminiProcurementResult } from './types';
import { ProductRecommendation, ProcurementReasoningStep } from '@/types/procurement';
import { auditLogger } from '@/lib/security/audit-logger';
import {
  CATALOG_FUNCTION_DECLARATIONS,
  executeCatalogTool
} from './catalog-tools';

export class GeminiService {
  private static instance: GeminiService;
  private readonly modelName: string;
  private readonly maxRetries: number = 3;
  private readonly initialBackoffMs: number = 750;

  private get apiKey(): string | undefined {
    return process.env.GEMINI_API_KEY;
  }

  private constructor() {
    this.modelName = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  }

  public static getInstance(): GeminiService {
    if (!GeminiService.instance) {
      GeminiService.instance = new GeminiService();
    }
    return GeminiService.instance;
  }

  public getModelName(): string {
    return this.modelName;
  }

  public isLiveAiConfigured(): boolean {
    return Boolean(
      this.apiKey &&
      this.apiKey.trim().length > 0 &&
      !this.apiKey.includes('your_gemini_api_key')
    );
  }

  /**
   * Helper that retries transient 429 and 5xx responses with bounded exponential backoff.
   * Permanent client errors (400, 401, 403, 404) are NOT retried.
   */
  public async executeWithRetry(
    url: string,
    payload: Record<string, unknown>,
    signalTimeoutMs = 15000
  ): Promise<{ response: Response; attempts: number }> {
    let attempts = 0;
    const delay = this.initialBackoffMs;

    while (attempts < this.maxRetries) {
      attempts++;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(signalTimeoutMs)
        });

        // Success or non-retryable 4xx (except 429 rate-limit)
        if (response.ok) {
          return { response, attempts };
        }

        const isTransient =
          response.status === 429 || (response.status >= 500 && response.status <= 504);

        if (!isTransient || attempts >= this.maxRetries) {
          return { response, attempts };
        }

        // Calculate backoff with jitter
        const retryAfterHeader = response.headers.get('retry-after');
        let waitMs = delay * Math.pow(2, attempts - 1) + Math.random() * 250;
        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed) && parsed > 0 && parsed <= 30) {
            waitMs = parsed * 1000;
          }
        }

        auditLogger.log(
          'GEMINI_CALL_RETRY',
          'WARN',
          `Gemini API returned retryable status ${response.status}. Retrying attempt ${attempts}/${this.maxRetries} after ${Math.round(waitMs)}ms...`,
          {
            details: {
              status: response.status,
              attempt: attempts,
              model: this.modelName
            }
          }
        );

        await new Promise((resolve) => setTimeout(resolve, waitMs));
      } catch (networkError: unknown) {
        if (attempts >= this.maxRetries) {
          throw networkError;
        }
        await new Promise((resolve) => setTimeout(resolve, delay * attempts));
      }
    }

    throw new Error(`Gemini API request failed after ${this.maxRetries} attempts.`);
  }

  /**
   * Main procurement reasoning entrypoint.
   */
  public async analyzeProcurementRequest(
    userQuery: string,
    explicitBudget?: number,
    department?: string
  ): Promise<GeminiProcurementResult> {
    const isLive = this.isLiveAiConfigured();

    if (isLive && this.apiKey) {
      try {
        const liveResult = await this.callLiveGeminiApi(userQuery, explicitBudget, department);
        auditLogger.log('GEMINI_CALL_SUCCESS', 'INFO', `Gemini reasoning succeeded for query`, {
          details: {
            model: liveResult.modelUsed || this.modelName,
            recommendationsCount: liveResult.recommendations.length,
            toolCallsCount: liveResult.toolCallsExecuted?.length || 0
          }
        });
        return liveResult;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown Gemini error';
        const statusCodeMatch = errorMessage.match(/status (\d+)/i);
        const statusCode = statusCodeMatch ? parseInt(statusCodeMatch[1], 10) : 500;

        auditLogger.log('GEMINI_CALL_FAILED', 'ERROR', `Gemini API call failed: ${errorMessage}`, {
          details: { model: this.modelName, statusCode }
        });

        // Run fallback heuristic engine with transparent failure indicators
        const fallback = this.runHeuristicProcurementEngine(userQuery, explicitBudget, department);
        fallback.aiStatus = 'fallback';
        fallback.isAiConnected = false;
        fallback.modelUsed = this.modelName;
        fallback.aiError = {
          statusCode,
          message: `Live Gemini API encountered error (${statusCode}): Upstream service unavailable or model unresponsive.`,
          attemptsMade: this.maxRetries
        };
        fallback.warningNote = `AI Service Notice: Gemini model (${this.modelName}) was temporarily unreachable (HTTP ${statusCode}). The recommendation below was generated by the internal Heuristic Procurement Engine.`;
        return fallback;
      }
    }

    // Default when no API key configured
    const heuristic = this.runHeuristicProcurementEngine(userQuery, explicitBudget, department);
    heuristic.aiStatus = 'not_configured';
    heuristic.isAiConnected = false;
    heuristic.warningNote =
      'ProcurePilot Heuristic Engine: Live Gemini AI key is not configured in .env.local. Running in transparent rule-based mode.';
    return heuristic;
  }

  /**
   * Calls Google Gemini REST endpoint directly with genuine function calling
   * and multi-turn agentic catalog search & validation loop.
   */
  public async callLiveGeminiApi(
    query: string,
    explicitBudget?: number,
    department?: string
  ): Promise<GeminiProcurementResult> {
    const candidateModels =
      this.modelName === 'gemini-flash-latest'
        ? ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest']
        : [this.modelName];

    let lastError: Error | null = null;

    for (const modelCandidate of candidateModels) {
      try {
        return await this.executeAgenticProcurementLoop(
          modelCandidate,
          query,
          explicitBudget,
          department
        );
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        auditLogger.log(
          'GEMINI_MODEL_FALLBACK_ATTEMPT',
          'WARN',
          `Model ${modelCandidate} failed with "${lastError.message}". Checking alternative available flash models...`,
          { details: { failedModel: modelCandidate, error: lastError.message } }
        );
      }
    }

    throw lastError || new Error(`All candidate Gemini models failed to process query.`);
  }

  /**
   * Executes the multi-turn function calling procurement loop against a specific model.
   */
  private async executeAgenticProcurementLoop(
    modelToUse: string,
    query: string,
    explicitBudget?: number,
    department?: string
  ): Promise<GeminiProcurementResult> {
    const realEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${this.apiKey}`;

    const systemInstruction = `You are ProcurePilot AI, an expert enterprise procurement officer.
Analyze the user's purchasing request using the provided catalog tools:
- search_products: Search the catalog for items matching requirements and budget.
- get_product_details: Retrieve full specifications, stock count, and pricing for a candidate product ID.
- compare_products: Compare alternatives side-by-side to justify inclusion.
- validate_budget: Reconcile and validate that the proposed item quantities strictly fit the budget.

RULES:
1. You MUST call "search_products" first to find genuine products in the authoritative catalog.
2. NEVER invent product IDs, prices, stock, or specifications. Only recommend products that exist in the catalog.
3. Strictly respect budget constraints. If a budget is specified, do not exceed it.
4. When you have selected the items, output your final recommendation as strict JSON conforming to this format:
{
  "summary": "Brief executive summary explaining the procurement choice and budget fit",
  "detectedBudget": number or null,
  "recommendations": [
    {
      "productId": "exact_catalog_id",
      "quantity": 1,
      "reason": "Detailed explanation of why this item was selected",
      "matchScore": 95,
      "highlightedSpec": "Key technical spec justifying inclusion"
    }
  ],
  "reasoningSteps": [
    {
      "step": 1,
      "phase": "discovery" or "evaluation" or "compliance" or "finalization",
      "title": "Step title",
      "detail": "Description of reasoning",
      "status": "completed"
    }
  ]
}`;

    const promptText = `User Procurement Request: "${query}"
Explicit Budget Limit: ${explicitBudget ? `$${explicitBudget}` : 'Not explicitly set'}
Department: ${department || 'General / Engineering'}

Execute required catalog tool calls to find and validate the best items, then provide the final JSON recommendation.`;

    const contents: Array<{
      role: 'user' | 'model';
      parts: Array<Record<string, unknown>>;
    }> = [
      {
        role: 'user',
        parts: [{ text: `${systemInstruction}\n\n${promptText}` }]
      }
    ];

    const toolCallsExecuted: Array<{
      toolName: string;
      args: Record<string, unknown>;
      isSuccess: boolean;
    }> = [];

    const dynamicReasoningSteps: ProcurementReasoningStep[] = [
      {
        step: 1,
        phase: 'parsing',
        title: 'Requirement & Budget Extraction',
        detail: `Analyzed user request for "${query}". Target budget: ${
          explicitBudget ? `$${explicitBudget}` : 'Extracted dynamically'
        }. Department: ${department || 'General'}.`,
        status: 'completed'
      }
    ];

    const maxTurns = 6;
    let turn = 0;
    let finalRawText = '';

    while (turn < maxTurns) {
      turn++;

      // When approaching the final turn, gently nudge the model to finalize its JSON recommendation
      const toolsToPass =
        turn < maxTurns - 1
          ? [{ functionDeclarations: CATALOG_FUNCTION_DECLARATIONS }]
          : undefined;

      const payload: Record<string, unknown> = {
        contents
      };
      if (toolsToPass) {
        payload.tools = toolsToPass;
      }

      const { response, attempts } = await this.executeWithRetry(realEndpoint, payload, 15000);

      if (!response.ok) {
        const errText = await response.text();
        const safeErr = errText.replace(/([?&]key=)[^&"'\s]+/gi, '$1[REDACTED]');
        throw new Error(
          `Gemini API returned status ${response.status} after ${attempts} attempts on model ${modelToUse}: ${safeErr}`
        );
      }

      const data = await response.json();
      const candidate = data.candidates?.[0]?.content;

      if (!candidate || !candidate.parts || candidate.parts.length === 0) {
        throw new Error(`Empty candidate received from model ${modelToUse}`);
      }

      // Check if candidate parts contain function calls
      const functionCallParts = candidate.parts.filter(
        (p: Record<string, unknown>) => Boolean(p.functionCall)
      );

      if (functionCallParts.length > 0) {
        // Model called one or more tools
        contents.push(candidate);

        for (const part of functionCallParts) {
          const call = part.functionCall as { name: string; args?: Record<string, unknown> };
          const toolName = call.name;
          const toolArgs = call.args || {};

          // Execute tool securely on the server
          const execResult = await executeCatalogTool(toolName, toolArgs);

          toolCallsExecuted.push({
            toolName,
            args: toolArgs,
            isSuccess: execResult.success
          });

          // Record reasoning step for user visibility
          dynamicReasoningSteps.push({
            step: dynamicReasoningSteps.length + 1,
            phase: toolName === 'validate_budget' ? 'constraint_solving' : 'retrieval',
            title: `Catalog Action: ${toolName}`,
            detail: execResult.success
              ? `Executed ${toolName} with parameters: ${JSON.stringify(toolArgs)}`
              : `Tool ${toolName} reported issue: ${execResult.error}`,
            status: execResult.success ? 'completed' : 'in_progress'
          });

          // Provide function response back to Gemini
          contents.push({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: toolName,
                  response: execResult.success ? execResult.result : { error: execResult.error }
                }
              }
            ]
          });
        }
      } else {
        // Model returned final text synthesis
        const textPart = candidate.parts.find(
          (p: Record<string, unknown>) => typeof p.text === 'string'
        );
        if (textPart && typeof textPart.text === 'string') {
          finalRawText = textPart.text;
        }
        break;
      }
    }

    if (!finalRawText && contents.length > 0) {
      // Append final synthesis directive to the last user message to preserve alternating turn order
      contents[contents.length - 1].parts.push({
        text: 'Based on the tool results above, synthesize and output your final recommendation as strict JSON now.'
      });

      const { response } = await this.executeWithRetry(
        realEndpoint,
        { contents },
        15000
      );
      if (response.ok) {
        const data = await response.json();
        const cand = data.candidates?.[0]?.content;
        const textPart = cand?.parts?.find(
          (p: Record<string, unknown>) => typeof p.text === 'string'
        );
        if (textPart && typeof textPart.text === 'string') {
          finalRawText = textPart.text;
        }
      }
    }

    // Parse model's structured JSON output
    const parsed = this.parseModelJsonResponse(finalRawText);

    // Reconcile against authoritative catalog to prevent hallucination
    const recommendations: ProductRecommendation[] = [];
    let bundleTotal = 0;
    const queryBudget = this.runHeuristicProcurementEngine(query, undefined, department).detectedBudget;
    const budgetCap =
      typeof explicitBudget === 'number' && Number.isFinite(explicitBudget) && explicitBudget > 0
        ? explicitBudget
        : queryBudget ??
          (typeof parsed.detectedBudget === 'number' &&
          Number.isFinite(parsed.detectedBudget) &&
          parsed.detectedBudget > 0
            ? parsed.detectedBudget
            : undefined);
    let budgetRejectedCount = 0;
    let unavailableRejectedCount = 0;

    for (const rec of parsed.recommendations || []) {
      const product = catalogService.getProductById(rec.productId);
      if (product) {
        const qty =
          typeof rec.quantity === 'number' &&
          Number.isSafeInteger(rec.quantity) &&
          rec.quantity > 0 &&
          rec.quantity <= 999
            ? rec.quantity
            : 1;
        const proposedItems = [
          ...recommendations.map((item) => ({
            productId: item.productId,
            quantity: item.quantityRecommended || 1
          })),
          { productId: product.id, quantity: qty }
        ];
        const reconciliation = catalogService.reconcileCart(proposedItems, budgetCap);

        // The model is advisory only. Reject any candidate that fails authoritative stock,
        // quantity, tax, shipping, or total-budget reconciliation before it reaches the UI.
        if (!product.inStock || product.stockCount < qty || !reconciliation.isValid) {
          if (reconciliation.budgetCheck.isWithinBudget === false) {
            budgetRejectedCount++;
            auditLogger.log(
              'GEMINI_BUDGET_OVERFLOW_REJECTED',
              'WARN',
              'Over-budget AI recommendation rejected by authoritative cart reconciliation.',
              {
                details: {
                  productId: product.id,
                  quantity: qty,
                  proposedTotal: reconciliation.verifiedTotal,
                  budgetCap
                }
              }
            );
          } else {
            unavailableRejectedCount++;
            auditLogger.log(
              'GEMINI_UNAVAILABLE_PRODUCT_REJECTED',
              'WARN',
              'AI recommendation rejected because the product or quantity is unavailable.',
              { details: { productId: product.id, quantity: qty, stockCount: product.stockCount } }
            );
          }
          continue;
        }

        recommendations.push({
          productId: product.id,
          product,
          matchScore: typeof rec.matchScore === 'number' ? rec.matchScore : 92,
          reason: rec.reason || `Selected to fulfill ${product.category} requirements.`,
          quantityRecommended: qty,
          highlightedSpec:
            rec.highlightedSpec ||
            Object.entries(product.specifications)[0]?.join(': ') ||
            product.shortDescription
        });
        bundleTotal += product.price * qty;
      } else {
        auditLogger.log(
          'GEMINI_UNKNOWN_PRODUCT_REJECTED',
          'WARN',
          `AI hallucinated or suggested unknown product ID "${rec.productId}". Ignored to maintain catalog integrity.`,
          { details: { rejectedId: rec.productId, model: modelToUse } }
        );
      }
    }

    if (budgetRejectedCount > 0) {
      dynamicReasoningSteps.push({
        step: dynamicReasoningSteps.length + 1,
        phase: 'constraint_solving',
        title: 'Server-Side Budget Enforcement',
        detail: `Rejected ${budgetRejectedCount} AI candidate item(s) because the fully reconciled cart total, including tax and shipping, would exceed the ${budgetCap ? `$${budgetCap.toFixed(2)}` : 'requested'} budget cap.`,
        status: 'completed'
      });
    }

    if (unavailableRejectedCount > 0) {
      dynamicReasoningSteps.push({
        step: dynamicReasoningSteps.length + 1,
        phase: 'constraint_solving',
        title: 'Availability & Quantity Enforcement',
        detail: `Rejected ${unavailableRejectedCount} AI candidate item(s) that failed authoritative stock or quantity checks.`,
        status: 'completed'
      });
    }

    const finalCartReconciliation = catalogService.reconcileCart(
      recommendations.map((item) => ({
        productId: item.productId,
        quantity: item.quantityRecommended || 1
      })),
      budgetCap
    );

    // Final reasoning step
    dynamicReasoningSteps.push({
      step: dynamicReasoningSteps.length + 1,
      phase: 'synthesis',
      title: 'Authoritative Catalog Reconciliation',
      detail: `Reconciled ${recommendations.length} recommended items. Subtotal: $${bundleTotal.toFixed(
        2
      )}; total including tax and shipping: $${finalCartReconciliation.verifiedTotal.toFixed(2)}.${budgetCap ? ` Budget cap: $${budgetCap.toFixed(2)}.` : ''}`,
      status: 'completed'
    });

    const baseSummary =
      recommendations.length === 0
        ? budgetRejectedCount > 0
          ? `Gemini's proposed candidates exceeded the authorized total budget of $${budgetCap?.toFixed(2) ?? 'the requested amount'} after tax and shipping. All over-budget candidates were rejected; no items were added.`
          : unavailableRejectedCount > 0
            ? 'No available catalogue items passed authoritative stock and quantity checks. No items were added.'
            : 'No valid catalogue recommendations were returned. No items were added.'
        : `Server-verified bundle: ${recommendations.length} in-stock item(s); subtotal $${finalCartReconciliation.verifiedSubtotal.toFixed(2)}, tax $${finalCartReconciliation.verifiedTax.toFixed(2)}, shipping $${finalCartReconciliation.verifiedShipping.toFixed(2)}, total $${finalCartReconciliation.verifiedTotal.toFixed(2)}${budgetCap ? ` against the $${budgetCap.toFixed(2)} budget cap` : ''}.`;
    const budgetSummary =
      budgetRejectedCount > 0
        ? ` Rejected ${budgetRejectedCount} AI candidate item(s) because the authoritative total including tax and shipping would exceed the budget.`
        : '';
    const availabilitySummary =
      unavailableRejectedCount > 0
        ? ` Rejected ${unavailableRejectedCount} AI candidate item(s) that failed authoritative stock or quantity checks.`
        : '';

    return {
      // Never surface the model's free-form summary: it can describe rejected items or
      // hallucinate totals. This user-facing summary is built only from final server data.
      summary: `${baseSummary}${budgetSummary}${availabilitySummary}`,
      detectedBudget: budgetCap ?? parsed.detectedBudget,
      recommendations,
      bundleTotal: Math.round(bundleTotal * 100) / 100,
      warningNote:
        budgetRejectedCount + unavailableRejectedCount > 0
          ? `Authoritative server-side reconciliation excluded ${budgetRejectedCount} over-budget and ${unavailableRejectedCount} unavailable candidate item(s).`
          : undefined,
      // Keep the displayed trace grounded in steps generated by this server; do not append
      // unverified model-authored narrative that could mention rejected products or stale totals.
      reasoningSteps: dynamicReasoningSteps,
      isAiConnected: true,
      provider: 'gemini-api',
      aiStatus: 'live',
      modelUsed: modelToUse,
      toolCallsExecuted
    };
  }

  /**
   * Safely parses JSON from Gemini output, stripping any markdown code fences.
   */
  private parseModelJsonResponse(text: string): {
    summary?: string;
    detectedBudget?: number;
    recommendations?: Array<{
      productId: string;
      quantity?: number;
      reason?: string;
      matchScore?: number;
      highlightedSpec?: string;
    }>;
    reasoningSteps?: ProcurementReasoningStep[];
  } {
    if (!text || text.trim().length === 0) {
      return {};
    }

    try {
      // 1. Direct JSON parse
      return JSON.parse(text);
    } catch {
      // 2. Extract from markdown code fences ```json ... ```
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (jsonMatch && jsonMatch[1]) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch {
          // continue
        }
      }

      // 3. Fallback: Find outermost { ... }
      const braceStart = text.indexOf('{');
      const braceEnd = text.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          return JSON.parse(text.slice(braceStart, braceEnd + 1));
        } catch {
          // continue
        }
      }

      return { summary: text.slice(0, 300) };
    }
  }

  /**
   * Transparent Rule-Based Procurement Engine for Stage 1/2 Heuristic Fallback.
   */
  public runHeuristicProcurementEngine(
    query: string,
    explicitBudget?: number,
    department?: string
  ): GeminiProcurementResult {
    const lower = query.toLowerCase();

    // 1. Extract budget from query if not explicitly passed
    let detectedBudget = explicitBudget;
    if (!detectedBudget) {
      const budgetMatch =
        query.match(
          /(?:under|below|budget(?:\s+of)?|max(?:imum)?(?:\s+of)?|limit(?:\s+of)?|around|cap(?:\s+of)?)\s*:?\s*\$?(\d+(?:,\d{3})*(?:\.\d{2})?)/i
        ) ||
        query.match(/\$?(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?:dollars|usd|\$|budget|limit|max)/i) ||
        query.match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/i);

      if (budgetMatch && budgetMatch[1]) {
        detectedBudget = parseFloat(budgetMatch[1].replace(/,/g, ''));
      }
    }

    // 2. Identify primary categories from intent keywords
    const targetCategories: string[] = [];
    if (/desk|chair|ergonomic|standing|monitor arm|cable tray/i.test(lower)) {
      targetCategories.push('Furniture');
    }
    if (/laptop|macbook|dell|computer|workstation|pc|server/i.test(lower)) {
      targetCategories.push('Hardware');
    }
    if (/monitor|screen|display|keyboard|mouse|webcam|headset|mic/i.test(lower)) {
      targetCategories.push('Peripherals');
    }
    if (/switch|router|access point|wifi|cat6|ethernet/i.test(lower)) {
      targetCategories.push('Networking');
    }
    if (/license|jetbrains|github|copilot|figma|slack|aws/i.test(lower)) {
      targetCategories.push('Software');
    }

    // Default to popular starter hardware & furniture if vague
    if (targetCategories.length === 0) {
      targetCategories.push('Hardware', 'Peripherals');
    }

    // 3. Retrieve matching candidates from authoritative catalog
    const allMatching = catalogService.getProducts().filter((p) => {
      if (!p.inStock) return false;
      const categoryMatch = targetCategories.includes(p.category);
      const textMatch =
        p.name.toLowerCase().includes(lower) ||
        p.shortDescription.toLowerCase().includes(lower) ||
        p.tags.some((t) => lower.includes(t.toLowerCase()));
      return categoryMatch || textMatch;
    });

    // 4. Select balanced bundle fitting detectedBudget
    const recommendations: ProductRecommendation[] = [];
    let currentTotal = 0;
    const effectiveBudget = detectedBudget || 5000;

    // Sort by rating desc, then price asc for best value
    allMatching.sort((a, b) => b.rating - a.rating || a.price - b.price);

    for (const product of allMatching) {
      const proposedItems = [
        ...recommendations.map((item) => ({
          productId: item.productId,
          quantity: item.quantityRecommended || 1
        })),
        { productId: product.id, quantity: 1 }
      ];
      const reconciliation = catalogService.reconcileCart(proposedItems, effectiveBudget);

      if (product.inStock && product.stockCount > 0 && reconciliation.isValid) {
        recommendations.push({
          productId: product.id,
          product,
          matchScore: Math.floor(88 + Math.random() * 10),
          reason: `Heuristic Match: Fits ${product.category} requirement and maintains bundle within the $${effectiveBudget} threshold.`,
          quantityRecommended: 1,
          highlightedSpec: Object.entries(product.specifications)[0]?.join(': ') || 'Standard'
        });
        currentTotal += product.price;

        if (recommendations.length >= 4) break;
      }
    }

    // Fallback if no matching within budget: pick the single lowest price item in catalog
    if (recommendations.length === 0) {
      const cheapest = [...catalogService.getProducts()]
        .filter((p) => p.inStock)
        .sort((a, b) => a.price - b.price)[0];
      if (
        cheapest &&
        catalogService.reconcileCart(
          [{ productId: cheapest.id, quantity: 1 }],
          effectiveBudget
        ).isValid
      ) {
        recommendations.push({
          productId: cheapest.id,
          product: cheapest,
          matchScore: 75,
          reason: 'Selected as the most economical available option to stay within constraints.',
          quantityRecommended: 1,
          highlightedSpec: Object.entries(cheapest.specifications)[0]?.join(': ') || 'Standard'
        });
        currentTotal += cheapest.price;
      }
    }

    const reasoningSteps: ProcurementReasoningStep[] = [
      {
        step: 1,
        phase: 'parsing',
        title: 'Requirement & Intent Analysis',
        detail: `Extracted intent for categories: ${targetCategories.join(', ')}. Target budget constraint: ${
          detectedBudget ? `$${detectedBudget}` : 'Flexible / Default $5,000'
        }.`,
        status: 'completed'
      },
      {
        step: 2,
        phase: 'retrieval',
        title: 'Catalogue Search & Stock Verification',
        detail: `Identified ${allMatching.length} in-stock candidate products in the authoritative local catalog.`,
        status: 'completed'
      },
      {
        step: 3,
        phase: 'constraint_solving',
        title: 'Spec Comparison & Optimization',
        detail: `Ranked candidates by performance rating and unit cost efficiency. Formed bundle of ${recommendations.length} items.`,
        status: 'completed'
      },
      {
        step: 4,
        phase: 'synthesis',
        title: 'Budget & Approval Check',
        detail: `Reconciled bundle total $${currentTotal.toFixed(2)} against limit of $${effectiveBudget}. Compliant.`,
        status: 'completed'
      }
    ];

    return {
      summary:
        recommendations.length > 0
          ? `ProcurePilot Heuristic Engine recommended a ${recommendations.length}-item bundle totaling $${currentTotal.toFixed(
              2
            )} matching your ${department || 'business'} requirements. The authoritative total including tax and shipping remains within the $${effectiveBudget.toFixed(2)} budget.`
          : `No in-stock catalogue items fit within the $${effectiveBudget.toFixed(2)} total budget after tax and shipping. No items were recommended.`,
      detectedBudget,
      recommendations,
      bundleTotal: Math.round(currentTotal * 100) / 100,
      reasoningSteps,
      isAiConnected: false,
      provider: 'procurepilot-heuristic-engine',
      aiStatus: 'fallback',
      modelUsed: 'heuristic-rule-engine-v1'
    };
  }

  /**
   * Generates default procurement reasoning steps.
   */
  public generateDefaultReasoningSteps(
    query: string,
    explicitBudget?: number
  ): ProcurementReasoningStep[] {
    return [
      {
        step: 1,
        phase: 'parsing',
        title: 'Requirement Analysis',
        detail: `Parsed natural language query: "${query}". Extracted target specifications and budget limits.`,
        status: 'completed'
      },
      {
        step: 2,
        phase: 'retrieval',
        title: 'Catalogue Search',
        detail: 'Matched criteria against verified catalog items using function calling.',
        status: 'completed'
      },
      {
        step: 3,
        phase: 'constraint_solving',
        title: 'Budget Validation',
        detail: explicitBudget
          ? `Validated that selected items do not exceed the explicit budget cap of $${explicitBudget}.`
          : 'Optimized recommendation for overall cost-to-performance ratio.',
        status: 'completed'
      }
    ];
  }
}

export const geminiService = GeminiService.getInstance();
