/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { randomInt } from 'node:crypto';

/**
 * A CamusDB ObjectId: the 12-byte identifier an `id` column holds, written as 24 lowercase
 * hexadecimal characters.
 *
 * The layout mirrors the server's `CamusObjectIdValue` exactly, so an id this class generates is
 * indistinguishable from one the server generates: a 4-byte second-resolution timestamp, a 3-byte
 * machine identifier, a 2-byte process identifier, and a 3-byte counter.
 */
export class CamusObjectId {
  readonly a: number;
  readonly b: number;
  readonly c: number;

  constructor(a: number, b: number, c: number) {
    this.a = a | 0;
    this.b = b | 0;
    this.c = c | 0;
  }

  /** True when every component is zero — the value `default(CamusObjectIdValue)` holds. */
  isNull(): boolean {
    return this.a === 0 && this.b === 0 && this.c === 0;
  }

  /** The 12 bytes, in the server's little-endian-per-component order. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, this.a, true);
    view.setInt32(4, this.b, true);
    view.setInt32(8, this.c, true);
    return bytes;
  }

  /** The 24 lowercase hexadecimal characters. */
  toString(): string {
    return hex8(this.a) + hex8(this.b) + hex8(this.c);
  }

  /** `toString`, so `JSON.stringify` renders an id the way the wire does. */
  toJSON(): string {
    return this.toString();
  }

  /** Orders two ids the way the server does: by unsigned component, most significant first. */
  compareTo(other: CamusObjectId): number {
    const a = compareUnsigned(this.a, other.a);
    if (a !== 0) return a;

    const b = compareUnsigned(this.b, other.b);
    if (b !== 0) return b;

    return compareUnsigned(this.c, other.c);
  }

  /** True when both ids name the same value. */
  equals(other: CamusObjectId): boolean {
    return this.a === other.a && this.b === other.b && this.c === other.c;
  }

  /** Parses 24 hexadecimal characters. Throws `TypeError` for anything else. */
  static parse(value: string): CamusObjectId {
    if (value.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(value)) {
      throw new TypeError('An ObjectId is 24 hexadecimal digits.');
    }

    return new CamusObjectId(
      Number.parseInt(value.slice(0, 8), 16) | 0,
      Number.parseInt(value.slice(8, 16), 16) | 0,
      Number.parseInt(value.slice(16, 24), 16) | 0,
    );
  }

  /** A new id for the current instant. */
  static generate(): CamusObjectId {
    const timestamp = Math.floor(Date.now() / 1000) | 0;
    const increment = nextIncrement();

    const a = timestamp;
    const b = (machine << 8) | ((processId >> 8) & 0xff);
    const c = (processId << 24) | increment;

    return new CamusObjectId(a, b | 0, c | 0);
  }

  /** A new id for the current instant, as its 24-character string. */
  static generateAsString(): string {
    return CamusObjectId.generate().toString();
  }
}

// One machine identity and one process identity per process, exactly as the server's generator
// holds them. Both are random rather than derived from the host: an id must not disclose where it
// was minted, and a container has no stable machine name to derive one from anyway.
const machine = randomInt(0x01000000);
const processId = randomInt(0x00010000);

let increment = randomInt(0x7fffffff);

function nextIncrement(): number {
  increment = (increment + 1) | 0;
  return increment & 0x00ffffff;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function compareUnsigned(left: number, right: number): number {
  const a = left >>> 0;
  const b = right >>> 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
