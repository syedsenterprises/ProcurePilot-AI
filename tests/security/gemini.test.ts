import assert from 'node:assert';
import { geminiService } from '../../src/services/gemini/gemini.service';
import {
  executeCatalogTool,
  SearchProductsArgsSchema,
  GetProductDetailsArgsSchema,
  CompareProductsArgsSchema,
  ValidateBudgetArgsSchema
} from '../../src/services/gemini/catalog-tools';

export async function runGeminiTests() {
  console.log('\n--- Running Gemini Stage 2B.1 Function Calling & AI Reasoning Tests ---');

  // -------------------------------------------------------------------------
  // Test 1: Configured Model Modernization & Default
  // -------------------------------------------------------------------------
  console.log('Test 1: Model Identifier Modernization & Default');
  const activeModel = geminiService.getModelName();
  assert.ok(
    activeModel === 'gemini-flash-latest' || activeModel.includes('flash'),
    `Configured model must be flash-based (Found: ${activeModel})`
  );
  console.log(`  ✓ Active model verified: ${activeModel}`);

  // -------------------------------------------------------------------------
  // Test 2: Natural-Language Budget Extraction
  // -------------------------------------------------------------------------
  console.log('Test 2: Natural-Language Budget Extraction');
  const budgetCases = [
    { query: 'Need a dual monitor desk setup under $1,500 for our designer', expected: 1500 },
    { query: 'Equip an engineer with workstation, budget of 4200 dollars', expected: 4200 },
    { query: 'Ergonomic chair and standing desk max of $850.50', expected: 850.5 },
    { query: 'Looking for a standard laptop with $3000 limit', expected: 3000 },
    { query: 'General accessories with no price mentioned', expected: undefined }
  ];

  for (const c of budgetCases) {
    const res = geminiService.runHeuristicProcurementEngine(c.query);
    assert.strictEqual(
      res.detectedBudget,
      c.expected,
      `Failed to extract budget from query "${c.query}". Expected ${c.expected}, got ${res.detectedBudget}`
    );
  }
  console.log('  ✓ Natural-language budget extraction accurately parsed currency formats and phrases');

  // -------------------------------------------------------------------------
  // Test 3: Catalog Tool Argument Validation (Zod Schemas)
  // -------------------------------------------------------------------------
  console.log('Test 3: Catalog Tool Argument Validation & Rejection');

  // search_products
  assert.ok(SearchProductsArgsSchema.safeParse({ query: 'chair', maxPrice: 500 }).success);
  assert.ok(!SearchProductsArgsSchema.safeParse({ maxPrice: -50 }).success, 'Negative price must be rejected');
  assert.ok(!SearchProductsArgsSchema.safeParse({ query: 'a'.repeat(200) }).success, 'Oversized query must be rejected');

  // get_product_details
  assert.ok(GetProductDetailsArgsSchema.safeParse({ productId: 'prod_chair_ergo' }).success);
  assert.ok(!GetProductDetailsArgsSchema.safeParse({ productId: '' }).success, 'Empty productId must be rejected');
  assert.ok(
    !GetProductDetailsArgsSchema.safeParse({ productId: 'prod; DROP TABLE;' }).success,
    'SQL injection characters must be rejected'
  );

  // compare_products
  assert.ok(CompareProductsArgsSchema.safeParse({ productIds: ['prod-hm-aeron-01', 'prod-sc-gesture-06'] }).success);
  assert.ok(
    !CompareProductsArgsSchema.safeParse({ productIds: ['prod-hm-aeron-01'] }).success,
    'Comparing fewer than 2 items must be rejected'
  );

  // validate_budget
  assert.ok(
    ValidateBudgetArgsSchema.safeParse({
      items: [{ productId: 'prod-hm-aeron-01', quantity: 2 }],
      maxBudget: 3000
    }).success
  );
  assert.ok(
    !ValidateBudgetArgsSchema.safeParse({
      items: [{ productId: 'prod-hm-aeron-01', quantity: 0 }],
      maxBudget: 3000
    }).success,
    'Zero quantity must be rejected'
  );
  assert.ok(
    !ValidateBudgetArgsSchema.safeParse({
      items: [],
      maxBudget: 3000
    }).success,
    'Empty items array must be rejected'
  );
  assert.ok(
    !ValidateBudgetArgsSchema.safeParse({
      items: [{ productId: 'prod-hm-aeron-01', quantity: 1 }],
      maxBudget: -100
    }).success,
    'Negative budget must be rejected'
  );
  console.log('  ✓ All 4 catalog tools strictly validate parameter schemas');

  // -------------------------------------------------------------------------
  // Test 4: Strict Tool Whitelist & Prevention of Payment/Checkout Tools
  // -------------------------------------------------------------------------
  console.log('Test 4: Strict Tool Whitelisting & Forbidden Tool Rejection');
  const forbiddenAttempts = [
    'execute_paypal_payment',
    'create_paypal_order',
    'charge_credit_card',
    'approve_checkout_automatically',
    'system_eval'
  ];

  for (const forbiddenTool of forbiddenAttempts) {
    const result = await executeCatalogTool(forbiddenTool, {});
    assert.strictEqual(result.success, false);
    assert.ok(
      result.error?.includes('Security violation') || result.error?.includes('not permitted'),
      `Forbidden tool ${forbiddenTool} must be strictly blocked`
    );
  }
  console.log('  ✓ Model is strictly prohibited from executing payment or checkout actions');

  // -------------------------------------------------------------------------
  // Test 5: Server-Side Tool Execution Against Real Catalog
  // -------------------------------------------------------------------------
  console.log('Test 5: Server-Side Tool Execution Against Authoritative Catalog');

  // search_products execution
  const searchExec = await executeCatalogTool('search_products', { query: 'Aeron' });
  assert.strictEqual(searchExec.success, true);
  const searchData = searchExec.result as { totalMatches: number; products: Array<{ id: string }> };
  assert.ok(searchData.totalMatches >= 1);
  assert.ok(searchData.products.some((p) => p.id === 'prod-hm-aeron-01'));

  // get_product_details execution
  const detailsExec = await executeCatalogTool('get_product_details', { productId: 'prod-hm-aeron-01' });
  assert.strictEqual(detailsExec.success, true);
  const detailsData = detailsExec.result as { product: { price: number; name: string } };
  assert.ok(detailsData.product.name.includes('Herman Miller Aeron'));
  assert.strictEqual(detailsData.product.price, 1295);

  // validate_budget execution
  const budgetExec = await executeCatalogTool('validate_budget', {
    items: [{ productId: 'prod-hm-aeron-01', quantity: 1 }],
    maxBudget: 1500
  });
  assert.strictEqual(budgetExec.success, true);
  const budgetData = budgetExec.result as { isValid: boolean; withinBudget: boolean; totalAmount: number };
  assert.strictEqual(budgetData.isValid, true);
  assert.strictEqual(budgetData.withinBudget, true);
  assert.strictEqual(budgetData.totalAmount, 1401.84);

  // Non-existent product details
  const notFoundExec = await executeCatalogTool('get_product_details', { productId: 'prod_nonexistent_xyz' });
  assert.strictEqual(notFoundExec.success, false);
  assert.ok(notFoundExec.error?.includes('does not exist in the authoritative catalog'));
  console.log('  ✓ Catalog tool execution reliably queries and validates against real catalog');

  // -------------------------------------------------------------------------
  // Test 6: Unknown Product Rejection (Prevent Hallucinations)
  // -------------------------------------------------------------------------
  console.log('Test 6: Unknown Product Hallucination Rejection');
  const originalFetch = globalThis.fetch;
  try {
    // Mock Gemini returning 1 valid product and 1 hallucinated/invented product
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Test bundle',
                      detectedBudget: 2000,
                      recommendations: [
                        { productId: 'prod-hm-aeron-01', quantity: 1, reason: 'Valid item' },
                        { productId: 'prod_hallucinated_quantum_laptop', quantity: 1, reason: 'Fake item' }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await geminiService.callLiveGeminiApi('Recommend office gear', 2000);
    assert.strictEqual(res.recommendations.length, 1, 'Hallucinated product must be rejected');
    assert.strictEqual(res.recommendations[0].productId, 'prod-hm-aeron-01');
    assert.strictEqual(res.bundleTotal, 1295, 'Bundle total must use authoritative catalog price');
    console.log('  ✓ Hallucinated product IDs rejected; catalog integrity preserved');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------------------
  // Test 6B: Live Gemini recommendations are revalidated against total budget
  // -------------------------------------------------------------------------
  console.log('Test 6B: Server-Side Rejection of Over-Budget Gemini Recommendations');
  try {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Two ergonomic chairs',
                      detectedBudget: 2000,
                      recommendations: [
                        { productId: 'prod-hm-aeron-01', quantity: 1, reason: 'First chair' },
                        { productId: 'prod-hm-aeron-01', quantity: 1, reason: 'Second chair' }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const result = await geminiService.callLiveGeminiApi('Need an ergonomic chair under $2,000', 2000);
    assert.strictEqual(result.recommendations.length, 1, 'The second chair must be rejected after total-budget reconciliation');
    assert.strictEqual(result.bundleTotal, 1295, 'Only the accepted authoritative catalogue item should be counted');
    assert.ok(
      result.warningNote?.includes('1 over-budget'),
      'The response must transparently disclose the rejected over-budget recommendation'
    );
    assert.ok(
      result.summary.includes('$1401.84'),
      'The response summary must report the final server-verified total including tax and shipping'
    );
    assert.ok(
      !result.summary.includes('Two ergonomic chairs'),
      'The model-authored summary must not override the server-verified final item list'
    );
    assert.ok(
      !result.reasoningSteps.some((step) => step.detail.includes('Two ergonomic chairs')),
      'Unverified model-authored narrative must not leak into the displayed reasoning trace'
    );

    const budgetCheck = await executeCatalogTool('validate_budget', {
      items: result.recommendations.map((item) => ({
        productId: item.productId,
        quantity: item.quantityRecommended || 1
      })),
      maxBudget: 2000
    });
    const verifiedBudget = budgetCheck.result as { withinBudget: boolean; totalAmount: number };
    assert.strictEqual(verifiedBudget.withinBudget, true, 'Final recommendations including tax and shipping must remain within budget');
    assert.strictEqual(verifiedBudget.totalAmount, 1401.84);
    console.log('  ✓ Over-budget AI candidate rejected; displayed recommendations pass complete authoritative total validation');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------------------
  // Test 7: Bounded Exponential Backoff on 429 Quota Exhaustion & 503
  // -------------------------------------------------------------------------
  console.log('Test 7: Bounded Exponential Backoff on Transient 429 & 503');
  let attemptCount = 0;
  try {
    globalThis.fetch = async () => {
      attemptCount++;
      if (attemptCount < 3) {
        return new Response(JSON.stringify({ error: { message: 'Quota exceeded or transient spike' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: 'Recovered after backoff',
                      recommendations: [{ productId: 'prod-hm-aeron-01', quantity: 1 }]
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const { response, attempts } = await geminiService.executeWithRetry('https://fake.gemini', { test: true });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(attempts, 3);
    console.log('  ✓ Transient 429 retried with bounded backoff and recovered');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // -------------------------------------------------------------------------
  // Test 8: Transparent Fallback Indicators on Exhaustion / Failure
  // -------------------------------------------------------------------------
  console.log('Test 8: Transparent Fallback Indicators on Failure');
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test_live_simulated_key';
  try {
    // Force permanent 500 failure
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: 'Service completely down' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const failureRes = await geminiService.analyzeProcurementRequest('Need a laptop under 2500', 2500);
    assert.strictEqual(failureRes.aiStatus, 'fallback');
    assert.strictEqual(failureRes.isAiConnected, false);
    assert.ok(failureRes.warningNote?.includes('AI Service Notice'));
    assert.strictEqual(failureRes.aiError?.statusCode, 500);
    assert.ok(failureRes.recommendations.length > 0, 'Heuristic fallback must provide emergency recommendations');
    console.log('  ✓ Transparent fallback triggered with explicit indicators, warning note, and error details');
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GEMINI_API_KEY = prevKey;
  }

  // -------------------------------------------------------------------------
  // Test 9: Budget Compliance & Calculation Integrity
  // -------------------------------------------------------------------------
  console.log('Test 9: Budget Compliance & Server-Side Total Calculation');
  const budgetTestResult = geminiService.runHeuristicProcurementEngine(
    'Equip 1 developer with chair and desk',
    2000
  );
  assert.ok(budgetTestResult.bundleTotal <= 2000, `Bundle total ($${budgetTestResult.bundleTotal}) must be <= $2000`);
  let calculatedSum = 0;
  for (const item of budgetTestResult.recommendations) {
    calculatedSum += item.product.price * item.quantityRecommended;
  }
  assert.strictEqual(
    budgetTestResult.bundleTotal,
    Math.round(calculatedSum * 100) / 100,
    'Bundle total must equal the exact sum of authoritative product prices'
  );
  const completeCartBudget = await executeCatalogTool('validate_budget', {
    items: budgetTestResult.recommendations.map((item) => ({
      productId: item.productId,
      quantity: item.quantityRecommended || 1
    })),
    maxBudget: 2000
  });
  const completeCartBudgetResult = completeCartBudget.result as { withinBudget: boolean; totalAmount: number };
  assert.strictEqual(
    completeCartBudgetResult.withinBudget,
    true,
    'Heuristic recommendations including tax and shipping must remain within the budget'
  );
  assert.ok(
    completeCartBudgetResult.totalAmount <= 2000,
    'The full heuristic checkout total must not exceed the authorized budget'
  );
  console.log('  ✓ Budget compliance verified against complete authoritative checkout total, including tax and shipping');
}
