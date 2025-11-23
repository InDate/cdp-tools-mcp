/**
 * Reference validation utilities
 */

// Constants
export const UNNAMED_CONNECTION = 'unnamed-connection-default';
export const RESERVED_REFERENCES = [
  UNNAMED_CONNECTION,
  'no-reference-set',
  'unknown-connection-type',
  'none-none-none',
];

/**
 * Sanitize a reference string to a consistent format
 * Converts "Test Payment Flow" -> "test-payment-flow"
 */
export function sanitizeReference(ref: string): string {
  return ref.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Validate a reference string
 * Returns the sanitized reference if valid, or an error if invalid
 *
 * Accepts both formats:
 * - "test replay feature" (3 space-separated words)
 * - "test-replay-feature" (already sanitized, 3 hyphen-separated parts)
 */
export function validateReference(ref: string): { valid: boolean; sanitized?: string; error?: string } {
  const trimmed = ref.trim();

  if (!trimmed) {
    return { valid: false, error: 'Reference cannot be empty' };
  }

  // First, sanitize the reference
  const sanitized = sanitizeReference(ref);

  // Check for reserved words on sanitized version
  if (RESERVED_REFERENCES.includes(sanitized)) {
    return { valid: false, error: `Reference "${trimmed}" is reserved and cannot be used` };
  }

  // Verify sanitized version has exactly 3 parts
  // This works for both "test replay feature" and "test-replay-feature"
  const sanitizedParts = sanitized.split('-');
  if (sanitizedParts.length !== 3) {
    return { valid: false, error: `Reference must be exactly 3 words, got ${sanitizedParts.length}` };
  }

  // Verify each part is non-empty (catches cases like "test--feature" or "test- -feature")
  if (sanitizedParts.some(part => !part)) {
    return { valid: false, error: `Invalid reference format: contains empty parts` };
  }

  return { valid: true, sanitized };
}
