/**
 * Unit tests for CDPManager getVariables token budget logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We can't directly test the private methods, but we can test the logic
// by extracting and testing the calculations

describe('Token Budget Calculations', () => {
  /**
   * Mirror of the calculateEffectiveBudget logic for testing
   */
  function calculateEffectiveBudget(maxTokens: number): number {
    const FIXED_OVERHEAD = 200; // Message template + code block + wrapper
    const PROPORTIONAL_OVERHEAD = 1.3; // JSON indentation adds ~30%
    return Math.floor((maxTokens - FIXED_OVERHEAD) / PROPORTIONAL_OVERHEAD);
  }

  /**
   * Mirror of the estimateTokens logic for testing
   */
  function estimateTokens(value: any): number {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(str.length / 4);
  }

  describe('calculateEffectiveBudget', () => {
    it('should return ~615 tokens for default maxTokens of 1000', () => {
      // (1000 - 200) / 1.3 = 615.38... -> 615
      const result = calculateEffectiveBudget(1000);
      expect(result).toBe(615);
    });

    it('should return 0 for maxTokens <= 200 (all consumed by overhead)', () => {
      expect(calculateEffectiveBudget(200)).toBe(0);
      expect(calculateEffectiveBudget(100)).toBeLessThan(0);
    });

    it('should scale proportionally with larger budgets', () => {
      // (2000 - 200) / 1.3 = 1384.61... -> 1384
      expect(calculateEffectiveBudget(2000)).toBe(1384);

      // (5000 - 200) / 1.3 = 3692.30... -> 3692
      expect(calculateEffectiveBudget(5000)).toBe(3692);
    });
  });

  describe('estimateTokens', () => {
    it('should estimate ~4 chars per token', () => {
      expect(estimateTokens('1234')).toBe(1);
      expect(estimateTokens('12345678')).toBe(2);
      expect(estimateTokens('123')).toBe(1); // ceil(3/4) = 1
    });

    it('should handle objects via JSON.stringify', () => {
      const obj = { a: 1 };
      // JSON.stringify({ a: 1 }) = '{"a":1}' = 7 chars -> ceil(7/4) = 2
      expect(estimateTokens(obj)).toBe(2);
    });

    it('should handle arrays', () => {
      const arr = [1, 2, 3];
      // JSON.stringify([1,2,3]) = '[1,2,3]' = 7 chars -> ceil(7/4) = 2
      expect(estimateTokens(arr)).toBe(2);
    });
  });

  describe('Response Type Selection Logic', () => {
    /**
     * Simulates the getVariables response type selection
     */
    function selectResponseType(
      fullAtDepthTokens: number,
      depth0Tokens: number,
      namesOnlyTokens: number,
      effectiveBudget: number,
      requestedDepth: number,
      hasFilter: boolean
    ): { responseType: string; filterInsufficient: boolean } {
      // Step 1: Try full at requested depth
      if (requestedDepth > 0 && fullAtDepthTokens <= effectiveBudget) {
        return { responseType: 'full', filterInsufficient: false };
      }

      // Step 2: Try depth 0
      if (depth0Tokens <= effectiveBudget) {
        const wasDepthReduced = requestedDepth > 0;
        return {
          responseType: wasDepthReduced ? 'depth_reduced' : 'full',
          filterInsufficient: false
        };
      }

      // Step 3: Try names only
      if (namesOnlyTokens <= effectiveBudget) {
        return { responseType: 'names_only', filterInsufficient: hasFilter };
      }

      // Step 4: Counts only (always fits)
      return { responseType: 'counts_only', filterInsufficient: hasFilter };
    }

    it('should return full when data fits at requested depth', () => {
      const result = selectResponseType(
        500,  // fullAtDepthTokens
        200,  // depth0Tokens
        50,   // namesOnlyTokens
        615,  // effectiveBudget
        2,    // requestedDepth
        false // hasFilter
      );
      expect(result.responseType).toBe('full');
      expect(result.filterInsufficient).toBe(false);
    });

    it('should return depth_reduced when only depth 0 fits', () => {
      const result = selectResponseType(
        1000, // fullAtDepthTokens - too big
        500,  // depth0Tokens - fits
        50,   // namesOnlyTokens
        615,  // effectiveBudget
        2,    // requestedDepth
        false // hasFilter
      );
      expect(result.responseType).toBe('depth_reduced');
      expect(result.filterInsufficient).toBe(false);
    });

    it('should return full (not depth_reduced) when depth 0 was requested', () => {
      const result = selectResponseType(
        500,  // fullAtDepthTokens
        500,  // depth0Tokens
        50,   // namesOnlyTokens
        615,  // effectiveBudget
        0,    // requestedDepth = 0
        false // hasFilter
      );
      expect(result.responseType).toBe('full');
      expect(result.filterInsufficient).toBe(false);
    });

    it('should return names_only when depth 0 is too big', () => {
      const result = selectResponseType(
        2000, // fullAtDepthTokens - too big
        1000, // depth0Tokens - too big
        300,  // namesOnlyTokens - fits
        615,  // effectiveBudget
        2,    // requestedDepth
        false // hasFilter
      );
      expect(result.responseType).toBe('names_only');
      expect(result.filterInsufficient).toBe(false);
    });

    it('should set filterInsufficient when filter provided but still too large', () => {
      const result = selectResponseType(
        2000, // fullAtDepthTokens - too big
        1000, // depth0Tokens - too big
        300,  // namesOnlyTokens - fits
        615,  // effectiveBudget
        2,    // requestedDepth
        true  // hasFilter
      );
      expect(result.responseType).toBe('names_only');
      expect(result.filterInsufficient).toBe(true);
    });

    it('should return counts_only when names too big', () => {
      const result = selectResponseType(
        5000, // fullAtDepthTokens - too big
        3000, // depth0Tokens - too big
        1000, // namesOnlyTokens - too big
        615,  // effectiveBudget
        2,    // requestedDepth
        false // hasFilter
      );
      expect(result.responseType).toBe('counts_only');
      expect(result.filterInsufficient).toBe(false);
    });

    it('should set filterInsufficient on counts_only when filter provided', () => {
      const result = selectResponseType(
        5000, // fullAtDepthTokens - too big
        3000, // depth0Tokens - too big
        1000, // namesOnlyTokens - too big
        615,  // effectiveBudget
        2,    // requestedDepth
        true  // hasFilter
      );
      expect(result.responseType).toBe('counts_only');
      expect(result.filterInsufficient).toBe(true);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle small scope (5 local variables, no global) - expect full', () => {
      const variables = [
        { name: 'count', value: 42, type: 'number', scopeType: 'local' },
        { name: 'name', value: 'test', type: 'string', scopeType: 'local' },
        { name: 'user', value: { id: 1, name: 'John' }, type: 'object', scopeType: 'local' },
        { name: 'items', value: [1, 2, 3], type: 'object', scopeType: 'local' },
        { name: 'config', value: { debug: true }, type: 'object', scopeType: 'local' },
      ];

      const tokens = estimateTokens(variables);
      const budget = calculateEffectiveBudget(1000);

      // This should easily fit
      expect(tokens).toBeLessThan(budget);
    });

    it('should handle large scope with many variables - may need fallback', () => {
      // Create 100 variables
      const variables = Array.from({ length: 100 }, (_, i) => ({
        name: `variable${i}`,
        value: { data: `value${i}`, nested: { deep: i } },
        type: 'object',
        scopeType: 'local',
      }));

      const tokens = estimateTokens(variables);
      const budget = calculateEffectiveBudget(1000);

      // This should exceed the budget
      expect(tokens).toBeGreaterThan(budget);

      // But names only should fit
      const namesOnly = { local: variables.map(v => v.name) };
      const namesTokens = estimateTokens(namesOnly);
      expect(namesTokens).toBeLessThan(budget);
    });

    it('should demonstrate the overhead calculation is reasonable', () => {
      // Test that our overhead accounts for realistic message formatting
      const data = { local: [{ name: 'x', value: 1, type: 'number' }] };
      const rawTokens = estimateTokens(data);

      // Simulate what the final response might look like
      const messageTemplate = 'Variables for call frame abc123: 1 of 1 total at depth 2';
      const codeBlock = '```json\n' + JSON.stringify(data, null, 2) + '\n```';
      const fullResponse = messageTemplate + '\n\n' + codeBlock;

      const fullTokens = estimateTokens(fullResponse);
      const overhead = fullTokens - rawTokens;

      // Our FIXED_OVERHEAD of 200 should be greater than actual overhead
      // to provide a safety buffer
      expect(200).toBeGreaterThanOrEqual(overhead);
    });
  });
});
