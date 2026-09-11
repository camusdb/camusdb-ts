/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType } from '../column-type.js';
import type { ColumnValue } from '../column-value.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { dateToDayTicks, dateToTicks } from './ticks.js';
import { isUuid, uuidToHalves } from './uuid.js';

const TYPED = Symbol.for('camusdb.typedParameter');

/**
 * A parameter whose column type the caller stated, rather than one the driver inferred from the
 * JavaScript value. Build one with a helper from `camus` below and pass it as a parameter value.
 */
export interface TypedParameter {
  readonly [TYPED]: true;
  readonly value: ColumnValue;
}

/** True when `value` came from one of the `camus.*` helpers. */
export function isTypedParameter(value: unknown): value is TypedParameter {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[TYPED] === true;
}

function typed(value: ColumnValue): TypedParameter {
  return { [TYPED]: true, value };
}

function invalid(message: string): never {
  throw new CamusError(CamusErrorCode.InvalidParameter, message);
}

/**
 * Explicit column types for parameters.
 *
 * The driver infers a column type from the JavaScript value, which is right for most parameters. A
 * helper here states the type instead, for the cases inference cannot reach: a `uuid` column (a
 * UUID is an ordinary string in JavaScript), an `id` column, a `float32` column, a date-only
 * column, and an empty array, whose element type nothing can be read from.
 */
export const camus = {
  /** An `id` column value: an ObjectId as its 24-character string. */
  id(value: string): TypedParameter {
    return typed({ type: ColumnType.Id, strValue: value });
  },

  /** A `uuid` column value, from the canonical hyphenated string. */
  uuid(value: string): TypedParameter {
    if (!isUuid(value)) {
      invalid(`'${value}' is not a canonical UUID string.`);
    }

    const { high, low } = uuidToHalves(value);
    return typed({ type: ColumnType.Uuid, strValue: value, uuidHigh: high, longValue: low });
  },

  /** An `int64` column value. */
  int64(value: number | bigint): TypedParameter {
    return typed({ type: ColumnType.Integer64, longValue: toBigInt(value) });
  },

  /** A `float64` column value. */
  float64(value: number): TypedParameter {
    return typed({ type: ColumnType.Float64, floatValue: value });
  },

  /** A `float32` column value. The server narrows it to single precision. */
  float32(value: number): TypedParameter {
    return typed({ type: ColumnType.Float32, floatValue: value });
  },

  /** A `bool` column value. */
  bool(value: boolean): TypedParameter {
    return typed({ type: ColumnType.Bool, boolValue: value });
  },

  /** A `string` column value. */
  string(value: string): TypedParameter {
    return typed({ type: ColumnType.String, strValue: value });
  },

  /** A `bytes` column value. */
  bytes(value: Uint8Array | ArrayBuffer): TypedParameter {
    return typed({ type: ColumnType.Bytes, bytesValue: toBytes(value) });
  },

  /**
   * A `bytes` column value holding an embedding: tightly packed little-endian float32 elements.
   * The same layout `CamusVector` reads back.
   */
  vector(value: ArrayLike<number>): TypedParameter {
    const bytes = new Uint8Array(value.length * 4);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < value.length; i++) {
      view.setFloat32(i * 4, value[i] as number, true);
    }

    return typed({ type: ColumnType.Bytes, bytesValue: bytes });
  },

  /** A `date` column value. The instant is truncated to UTC midnight, as the column stores it. */
  date(value: Date): TypedParameter {
    return typed({ type: ColumnType.Date, longValue: dateToDayTicks(value) });
  },

  /** A `datetime` column value. */
  dateTime(value: Date): TypedParameter {
    return typed({ type: ColumnType.DateTime, longValue: dateToTicks(value) });
  },

  /**
   * An array column value with a stated element type. Use it for an empty array, whose element
   * type cannot be inferred, and whenever the element type is not the one inference would pick.
   */
  array(items: readonly unknown[], elementType: ColumnType): TypedParameter {
    // Imported lazily to break the cycle with the encoder, which imports this module.
    const encode = arrayEncoder;

    if (encode === undefined) {
      throw new Error('The value encoder is not registered yet.');
    }

    return typed({
      type: ColumnType.Array,
      arrayElementType: elementType,
      arrayValues: items.map((item) =>
        item === null || item === undefined ? { type: ColumnType.Null } : encode(item, elementType),
      ),
    });
  },

  /** A typed `NULL`. */
  null(): TypedParameter {
    return typed({ type: ColumnType.Null });
  },

  /** A value built by hand, sent as written. The escape hatch when nothing above fits. */
  raw(value: ColumnValue): TypedParameter {
    return typed(value);
  },
} as const;

/**
 * The element encoder `camus.array` uses, registered by the encoder module at load time. The two
 * modules genuinely need each other — an array holds values, and a value can be an array — and a
 * one-way registration is clearer than a cycle the bundler has to resolve.
 */
let arrayEncoder: ((value: unknown, declared: ColumnType) => ColumnValue) | undefined;

/** @internal */
export function registerArrayEncoder(encode: (value: unknown, declared: ColumnType) => ColumnValue): void {
  arrayEncoder = encode;
}

function toBigInt(value: number | bigint): bigint {
  if (typeof value === 'bigint') return value;

  if (!Number.isInteger(value)) {
    invalid(`An int64 parameter needs an integer; got ${String(value)}.`);
  }

  return BigInt(value);
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
