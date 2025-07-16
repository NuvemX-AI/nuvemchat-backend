import crypto from 'crypto';

/**
 * Generates a cryptographically secure random token.
 * @param {number} byteLength - The number of bytes to generate for the token.
 * @returns {string} The generated token as a hexadecimal string.
 */
export function generateSecureToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('hex');
} 