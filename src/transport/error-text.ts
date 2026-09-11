/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Cleans the text that becomes a `CamusError` message.
 *
 * The message is built from whatever the far end returned: a server error body, a gRPC status
 * detail, an HTTP client's own exception text. Applications log it almost without exception, so
 * three properties of that text matter, and the sender guarantees none of them. It must not carry
 * a credential. It must not carry line breaks, which let a sender forge a second log entry. It
 * must not be unbounded.
 *
 * Only the error path pays for this, so the scan is one plain pass rather than a set of regular
 * expressions.
 */

/** The longest message kept. A server error body is a sentence; anything longer is echoed content. */
export const MAX_ERROR_MESSAGE_LENGTH = 2048;

const ELIDED = '…';

const MASKED = '***';

/** Prefixes shaped like a credential. The token that follows one is masked. */
const SECRET_PREFIXES = ['bearer ', 'password=', 'password":', 'pwd=', 'accesstoken=', 'token":'];

/** Characters that end the value a credential-shaped prefix introduces. */
const VALUE_TERMINATORS = new Set([' ', '"', "'", ',', ';', '}', ')', '\n', '\r']);

/**
 * The text with control characters folded to spaces, credential-shaped runs masked, and the length
 * bounded.
 */
export function sanitizeErrorText(text: string | undefined | null): string {
  if (text === undefined || text === null || text.length === 0) return '';

  const lower = text.toLowerCase();
  let clean = '';
  let index = 0;

  while (index < text.length && clean.length < MAX_ERROR_MESSAGE_LENGTH) {
    const prefixLength = matchSecretPrefix(lower, index);

    if (prefixLength !== undefined) {
      clean += text.slice(index, index + prefixLength) + MASKED;
      index = skipSecretValue(text, index + prefixLength);
      continue;
    }

    const character = text[index]!;
    index++;

    // A newline in a logged message lets the sender forge a second log entry, and another control
    // character can rewrite a terminal. Both become a plain space.
    clean += isControl(character) ? ' ' : character;
  }

  return index < text.length ? clean + ELIDED : clean;
}

function matchSecretPrefix(lowercase: string, index: number): number | undefined {
  for (const prefix of SECRET_PREFIXES) {
    if (lowercase.startsWith(prefix, index)) return prefix.length;
  }

  return undefined;
}

/**
 * Skips the value a credential-shaped prefix introduces: leading quotes and spaces, then
 * everything up to the first character that cannot be part of a token or a quoted value.
 */
function skipSecretValue(text: string, index: number): number {
  while (index < text.length && (text[index] === ' ' || text[index] === '"' || text[index] === "'")) {
    index++;
  }

  while (index < text.length && !VALUE_TERMINATORS.has(text[index]!)) index++;

  return index;
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
