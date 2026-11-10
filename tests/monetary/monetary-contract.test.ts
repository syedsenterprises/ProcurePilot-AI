import assert from 'assert';
import { parseExactDecimalToCents } from '@/db/legacy-preflight';
import {
  formatCentsToExactDecimalString,
  convertExactDecimalToLegacyNumber,
  formatCentsToLegacyNumber,
} from '@/db/export-pg-to-flatfiles';

export async function runMonetaryContractTests(): Promise<void> {
  console.log('\n--- Running Monetary Arithmetic Contract Tests ---');

  // 1. Positive Exact Decimal Conversion
  assert.strictEqual(parseExactDecimalToCents('294.54', 'test'), 29454);
  assert.strictEqual(parseExactDecimalToCents('0.01', 'test'), 1);
  assert.strictEqual(parseExactDecimalToCents('0.1', 'test'), 10);
  assert.strictEqual(parseExactDecimalToCents('1.5', 'test'), 150);
  assert.strictEqual(parseExactDecimalToCents('100', 'test'), 10000);
  assert.strictEqual(parseExactDecimalToCents('100.0', 'test'), 10000);
  assert.strictEqual(parseExactDecimalToCents('100.00', 'test'), 10000);
  assert.strictEqual(parseExactDecimalToCents(294.54, 'test'), 29454);
  assert.strictEqual(parseExactDecimalToCents(0.01, 'test'), 1);
  assert.strictEqual(parseExactDecimalToCents(100, 'test'), 10000);
  console.log('✓ Positive exact decimal conversions verified');

  // 2. Negative Values
  assert.strictEqual(parseExactDecimalToCents('-0.25', 'test'), -25);
  assert.strictEqual(parseExactDecimalToCents('-100.50', 'test'), -10050);
  assert.strictEqual(parseExactDecimalToCents('-0.01', 'test'), -1);
  assert.strictEqual(parseExactDecimalToCents('-5', 'test'), -500);
  assert.strictEqual(parseExactDecimalToCents(-0.25, 'test'), -25);
  console.log('✓ Negative monetary value conversions verified');

  // 3. Zero Handling (Positive and Negative Zero)
  assert.strictEqual(parseExactDecimalToCents('0', 'test'), 0);
  assert.strictEqual(parseExactDecimalToCents('-0', 'test'), 0);
  assert.strictEqual(parseExactDecimalToCents('0.00', 'test'), 0);
  assert.strictEqual(parseExactDecimalToCents('-0.00', 'test'), 0);
  assert.strictEqual(parseExactDecimalToCents(0, 'test'), 0);
  assert.strictEqual(parseExactDecimalToCents(-0, 'test'), 0);
  console.log('✓ Zero (including negative zero) conversions verified');

  // 4. Excess Precision Rejection (> 2 decimal places)
  const excessPrecisionCases = ['1.005', '2.675', '0.0001', '99.999', 1.005, 2.675];
  for (const val of excessPrecisionCases) {
    assert.throws(
      () => parseExactDecimalToCents(val, 'excessPrecisionTest'),
      /Excess monetary precision/i,
      `Should reject excess precision: ${val}`
    );
  }
  console.log('✓ Excess decimal precision (>2 decimal places) strictly rejected');

  // 5. Safe Integer Range Verification
  // MAX_SAFE_INTEGER is 9007199254740991 (i.e. 90071992547409.91 dollars)
  assert.strictEqual(parseExactDecimalToCents('90071992547409.91', 'test'), Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => parseExactDecimalToCents('90071992547409.92', 'overflowTest'),
    /beyond safe integer range/i,
    'Should reject value exceeding MAX_SAFE_INTEGER'
  );
  assert.throws(
    () => parseExactDecimalToCents('-90071992547409.92', 'underflowTest'),
    /beyond safe integer range/i,
    'Should reject value below MIN_SAFE_INTEGER'
  );
  console.log('✓ Safe integer range boundary enforcement verified');

  // 6. Malformed Input Rejection
  const malformedInputs = [
    null,
    undefined,
    '',
    '   ',
    'abc',
    '$294.54',
    '12.34.56',
    '12,34',
    '1e5',
    'NaN',
    'Infinity',
  ];
  for (const input of malformedInputs) {
    assert.throws(
      () => parseExactDecimalToCents(input as any, 'malformedTest'),
      /(Malformed monetary string format|Monetary value cannot be null or undefined|Invalid non-numeric)/i,
      `Should reject malformed input: ${String(input)}`
    );
  }
  console.log('✓ Malformed and non-numeric monetary inputs strictly rejected');

  // 7. Exact Decimal-to-Legacy Number Serialization & Round-Trip
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(29454)), '294.54');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(1)), '0.01');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(-25)), '-0.25');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt(0)), '0.00');
  assert.strictEqual(formatCentsToExactDecimalString(BigInt('9007199254740991')), '90071992547409.91');

  assert.strictEqual(formatCentsToLegacyNumber(29454), 294.54);
  assert.strictEqual(formatCentsToLegacyNumber(1), 0.01);
  assert.strictEqual(formatCentsToLegacyNumber(0), 0);
  assert.strictEqual(formatCentsToLegacyNumber(129500), 1295);
  assert.strictEqual(formatCentsToLegacyNumber(-25), -0.25);
  assert.strictEqual(formatCentsToLegacyNumber(-500), -5);
  console.log('✓ Exact monetary serialization and round-trip (positive, negative, zero) verified');

  // 8. Boundary, Unsafe, and Precision-Loss Rejection at Boundary
  // Rejection of IEEE-754 precision loss beyond safe integer representation
  assert.throws(
    () => convertExactDecimalToLegacyNumber('90071992547409.01', BigInt('9007199254740901')),
    /Inexact float conversion detected/,
    'IEEE-754 float drift must throw explicit error'
  );

  // Boundary check: values exceeding safe integer cents
  assert.throws(
    () => convertExactDecimalToLegacyNumber('9999999999999999.99', BigInt('999999999999999999')),
    /(exceeds JavaScript safe integer limit|exceeds safe integer)/,
    'Values exceeding MAX_SAFE_INTEGER must throw'
  );

  // Decimal string with excess precision
  assert.throws(
    () => convertExactDecimalToLegacyNumber('12.951', BigInt(1295)),
    /(Excess monetary precision|Inexact monetary conversion)/,
    'Excess precision in decimal string must throw'
  );

  // Non-finite decimal string
  assert.throws(
    () => convertExactDecimalToLegacyNumber('Infinity', BigInt(100)),
    /Invalid non-finite monetary conversion/,
    'Non-finite conversion must throw'
  );
  console.log('✓ Unsafe, boundary-exceeding, and inexact monetary conversions strictly rejected');

  console.log('✅ ALL MONETARY CONTRACT TESTS PASSED');
}

if (require.main === module) {
  runMonetaryContractTests().catch((err) => {
    console.error('❌ Monetary contract test suite failed:', err);
    process.exit(1);
  });
}
