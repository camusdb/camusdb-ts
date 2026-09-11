/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The three forms a CamusDB UUID takes, and the conversions between them.
 *
 * - The canonical string, `550e8400-e29b-41d4-a716-446655440000`. This is what the driver hands a
 *   caller, and what a caller passes as a parameter.
 * - 16 big-endian bytes (RFC 4122 byte order). This is the gRPC wire form.
 * - Two big-endian 64-bit halves, high then low. This is the REST wire form and the shape the
 *   server's own value type holds.
 */

const HEX = '0123456789abcdef';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a canonical hyphenated UUID string. Matching ignores case. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** The 16 big-endian bytes of a canonical UUID string. */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll('-', '');

  if (hex.length !== 32) {
    throw new TypeError(`'${uuid}' is not a UUID: a UUID has 32 hexadecimal digits.`);
  }

  const bytes = new Uint8Array(16);

  for (let i = 0; i < 16; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    if (Number.isNaN(byte)) {
      throw new TypeError(`'${uuid}' is not a UUID: it holds a character that is not hexadecimal.`);
    }

    bytes[i] = byte;
  }

  return bytes;
}

/** The canonical string for 16 big-endian bytes. */
export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new TypeError(`A UUID is 16 bytes; got ${String(bytes.length)}.`);
  }

  let out = '';

  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    const byte = bytes[i]!;
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }

  return out;
}

/** The two big-endian 64-bit halves of a canonical UUID string. */
export function uuidToHalves(uuid: string): { high: bigint; low: bigint } {
  return bytesToHalves(uuidToBytes(uuid));
}

/** The two big-endian 64-bit halves of 16 bytes. */
export function bytesToHalves(bytes: Uint8Array): { high: bigint; low: bigint } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    high: view.getBigInt64(0, false),
    low: view.getBigInt64(8, false),
  };
}

/** The 16 big-endian bytes of two 64-bit halves. */
export function halvesToBytes(high: bigint, low: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt.asIntN(64, high), false);
  view.setBigInt64(8, BigInt.asIntN(64, low), false);
  return bytes;
}

/** The canonical string for two 64-bit halves. */
export function halvesToUuid(high: bigint, low: bigint): string {
  return bytesToUuid(halvesToBytes(high, low));
}
