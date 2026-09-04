/**
 * Short share-link tokens (009-short-share-links, D3).
 *
 * The token embedded in `<origin>/s/<token>` is the only public
 * identifier of a share link. It must be short enough to copy by hand
 * yet carry enough entropy that enumeration is infeasible (FR-009):
 * 12 base62 characters ≈ 71 bits.
 */

import { randomBytes } from "node:crypto";

/** Token length in characters; 62^12 ≈ 3.2×10^21 candidates. */
export const SHARE_LINK_TOKEN_LENGTH = 12;

/** The base62 alphabet share-link tokens are drawn from. */
const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a uniform, cryptographically random share-link token.
 *
 * Characters are drawn from `crypto.randomBytes` using rejection
 * sampling — byte values at or above `256 - (256 % 62)` are discarded —
 * so every alphabet character is equally likely (no modulo bias).
 *
 * @returns a 12-character `[A-Za-z0-9]` token
 * @example
 * ```ts
 * const token = generateShareToken(); // e.g. "aB3xY9kQ2mR7"
 * ```
 */
export function generateShareToken(): string {
  const alphabetLength = TOKEN_ALPHABET.length;
  // Largest multiple of the alphabet size that fits in one byte: bytes
  // below this limit map uniformly onto the alphabet.
  const limit = Math.floor(256 / alphabetLength) * alphabetLength;
  let token = "";
  while (token.length < SHARE_LINK_TOKEN_LENGTH) {
    const bytes = randomBytes(SHARE_LINK_TOKEN_LENGTH - token.length);
    for (const byte of bytes) {
      if (byte < limit) {
        token += TOKEN_ALPHABET[byte % alphabetLength];
      }
    }
  }
  return token;
}
