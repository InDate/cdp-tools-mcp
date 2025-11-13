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
 */
export function validateReference(ref: string): { valid: boolean; sanitized?: string; error?: string } {
  const trimmed = ref.trim();

  if (!trimmed) {
    return { valid: false, error: 'Reference cannot be empty' };
  }

  // Count words in raw input
  const words = trimmed.split(/\s+/);

  if (words.length !== 3) {
    return { valid: false, error: `Reference must be exactly 3 words, got ${words.length}` };
  }

  // Sanitize the reference
  const sanitized = sanitizeReference(ref);

  // Check for reserved words on sanitized version
  if (RESERVED_REFERENCES.includes(sanitized)) {
    return { valid: false, error: `Reference "${trimmed}" is reserved and cannot be used` };
  }

  // Verify sanitized version also has 3 parts (catches weird edge cases)
  const sanitizedParts = sanitized.split('-');
  if (sanitizedParts.length !== 3) {
    return { valid: false, error: `Invalid reference format` };
  }

  return { valid: true, sanitized };
}
