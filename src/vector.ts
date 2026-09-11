/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';

/**
 * Reads and writes the byte layout CamusDB stores an embedding in.
 *
 * A vector is a `bytes` column holding tightly packed little-endian float32 elements with no
 * header, so the byte count is always four times the number of dimensions. There is no separate
 * vector column type: a vector is bytes, and these functions are the two ends of that layout.
 */
export const CamusVector = {
  /** The byte payload for a vector. */
  toBytes(vector: ArrayLike<number>): Uint8Array {
    const bytes = new Uint8Array(vector.length * 4);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < vector.length; i++) {
      view.setFloat32(i * 4, vector[i] as number, true);
    }

    return bytes;
  },

  /** The elements of a stored vector. */
  toFloats(bytes: Uint8Array): Float32Array {
    const dimensions = CamusVector.dimensions(bytes);
    const vector = new Float32Array(dimensions);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let i = 0; i < dimensions; i++) {
      vector[i] = view.getFloat32(i * 4, true);
    }

    return vector;
  },

  /**
   * How many elements a stored vector holds.
   *
   * @throws {CamusError} `CADB0410` when the byte count is not a multiple of four.
   */
  dimensions(bytes: Uint8Array): number {
    if (bytes.length % 4 !== 0) {
      throw new CamusError(
        CamusErrorCode.InvalidVector,
        `A vector's byte count must be a multiple of 4; got ${String(bytes.length)}.`,
      );
    }

    return bytes.length / 4;
  },
} as const;
