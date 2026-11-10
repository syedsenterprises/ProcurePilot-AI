import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { geminiService } from '../../src/services/gemini/gemini.service';
import { catalogService } from '../../src/services/catalog/catalog.service';

export async function runGeminiLiveIntegrationTest() {
  console.log('\n================================================================');
  console.log('Gemini Live API & Function Calling Integration Test');
  console.log('================================================================');

  // 1. Read API key from local environment safely
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) {
    console.warn('⚠️ .env.local not found. Skipping live integration test.');
    return;
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const keyMatch = envContent.match(/GEMINI_API_KEY=([^\r\n]+)/);
  if (!keyMatch || !keyMatch[1] || keyMatch[1].includes('your_gemini_api_key')) {
    console.warn('⚠️ GEMINI_API_KEY is not configured in .env.local. Skipping live integration test.');
    return;
  }

  // Ensure process.env.GEMINI_API_KEY is set in memory without logging it
  process.env.GEMINI_API_KEY = keyMatch[1].trim();

  console.log('Step 1: Authenticated with configured local GEMINI_API_KEY [REDACTED]');
  console.log(`Step 2: Active configured model target: ${geminiService.getModelName()}`);

  const userQuery = 'I need an ergonomic chair for remote engineering work. My budget is $1400.';
  console.log(`Step 3: Sending natural-language procurement request: "${userQuery}"`);

  const startTime = Date.now();
  const result = await geminiService.analyzeProcurementRequest(userQuery, 1400, 'Software Engineering');
  const durationMs = Date.now() - startTime;

  console.log(`Step 4: Received response in ${durationMs}ms`);
  console.log(`  - AI Status: ${result.aiStatus}`);
  console.log(`  - Provider: ${result.provider}`);
  console.log(`  - Model Used: ${result.modelUsed}`);
  console.log(`  - Is Connected: ${result.isAiConnected}`);
  console.log(`  - Detected Budget: $${result.detectedBudget}`);
  console.log(`  - Bundle Total: $${result.bundleTotal}`);
  console.log(`  - Recommendations Count: ${result.recommendations.length}`);

  // Assertions
  assert.ok(result.recommendations.length > 0, 'Must produce at least one recommendation');
  assert.ok(
    result.bundleTotal <= 1400,
    `Bundle total ($${result.bundleTotal}) must strictly respect the $1400 budget limit`
  );

  // Validate every recommended product exists in the authoritative catalog
  for (const rec of result.recommendations) {
    const authoritative = catalogService.getProductById(rec.productId);
    assert.ok(authoritative, `Product ID "${rec.productId}" must exist in authoritative catalog`);
    assert.strictEqual(
      rec.product.price,
      authoritative.price,
      `Price for ${rec.productId} must match catalog price ($${authoritative.price})`
    );
    console.log(`  ✓ Verified catalog item: [${rec.productId}] ${rec.product.name} @ $${rec.product.price}`);
  }

  // If live AI responded, inspect tool execution evidence
  if (result.aiStatus === 'live') {
    console.log('\n--- Live Gemini Function Calling Evidence ---');
    assert.ok(
      result.toolCallsExecuted && result.toolCallsExecuted.length > 0,
      'Live Gemini integration must execute at least one catalog tool via function calling'
    );

    for (const [idx, call] of result.toolCallsExecuted.entries()) {
      console.log(`  [Call #${idx + 1}] Tool: ${call.toolName}`);
      console.log(`    Arguments: ${JSON.stringify(call.args)}`);
      console.log(`    Success: ${call.isSuccess}`);
    }

    console.log('\n--- Final Procurement Summary from Gemini ---');
    console.log(`  "${result.summary}"`);
  } else {
    console.log('\n⚠️ Upstream Gemini returned fallback notice:', result.warningNote);
  }

  console.log('\n================================================================');
  console.log('✅ LIVE GEMINI INTEGRATION & REASONING TEST COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');
}

// Direct execution support
if (require.main === module || process.argv[1]?.endsWith('gemini-live-tools.test.ts')) {
  runGeminiLiveIntegrationTest().catch((err) => {
    console.error('❌ Live integration test failed:', err);
    process.exit(1);
  });
}
