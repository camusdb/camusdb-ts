/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { ColumnType, columnTypeName } from '../column-type.js';
import type { ColumnValue } from '../column-value.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { CamusObjectId } from '../object-id.js';
import { dateToDayTicks, dateToTicks } from './ticks.js';
import { isUuid, uuidToHalves } from './uuid.js';
import { isTypedParameter, registerArrayEncoder } from './typed.js';

/**
 * A value a caller may bind to a parameter: a plain JavaScript value the driver infers a column
 * type from, or a `camus.*` helper that states the type.
 */
export type ParameterValue = unknown;

/** Bound parameters, keyed by placeholder name. A leading `@` is optional. */
export type Parameters = Readonly<Record<string, ParameterValue>>;

/**
 * The wire form of one bound parameter.
 *
 * A `camus.*` helper carries its own column type. Anything else is inferred from the JavaScript
 * value:
 *
 * - `null` and `undefined` — `Null`.
 * - `boolean` — `Bool`.
 * - `number` — `Integer64` when it is an integer, `Float64` otherwise.
 * - `bigint` — `Integer64`.
 * - `string` — `String`. A UUID string is **not** detected: state it with `camus.uuid`.
 * - `Date` — `DateTime`. Use `camus.date` for a date-only column.
 * - `Uint8Array`, `Buffer`, `ArrayBuffer` — `Bytes`.
 * - `Float32Array` — `Bytes`, packed as a vector. It is the natural JavaScript form of an
 *   embedding, and a packed float32 buffer has no other meaning in CamusDB.
 * - `CamusObjectId` — `Id`.
 * - an array — `Array`, with the element type inferred from the first element that is not null.
 */
export function encodeParameter(value: ParameterValue): ColumnValue {
  if (isTypedParameter(value)) return value.value;

  return encodeInferred(value);
}

/**
 * Builds the wire dictionary for a statement's parameters, or `undefined` when there are none.
 *
 * Placeholder names reach the server with a leading `@`, which is how the server publishes them
 * for a prepared statement. A caller may write the name either way: `{ year: 1974 }` and
 * `{ '@year': 1974 }` produce the same request.
 */
export function encodeParameters(parameters: Parameters | undefined): Map<string, ColumnValue> | undefined {
  if (parameters === undefined) return undefined;

  const names = Object.keys(parameters);
  if (names.length === 0) return undefined;

  const encoded = new Map<string, ColumnValue>();

  for (const name of names) {
    if (name.length === 0) {
      throw new CamusError(CamusErrorCode.InvalidParameter, 'A parameter name cannot be empty.');
    }

    const wireName = name.startsWith('@') ? name : `@${name}`;

    if (encoded.has(wireName)) {
      throw new CamusError(
        CamusErrorCode.InvalidParameter,
        `The parameter '${wireName}' is bound twice. A name with and without its leading '@' is the same parameter.`,
      );
    }

    encoded.set(wireName, encodeParameter(parameters[name]));
  }

  return encoded;
}

/** Encodes one value against a declared column type. Used for array elements. */
export function encodeAs(value: unknown, declared: ColumnType): ColumnValue {
  if (value === null || value === undefined) return { type: ColumnType.Null };
  if (isTypedParameter(value)) return value.value;

  switch (declared) {
    case ColumnType.Null:
      return { type: ColumnType.Null };

    case ColumnType.Id: {
      const id = asIdString(value);

      // A UUID is 16 bytes and an object id is 12, so a UUID string can never be an object id. Sent
      // as Id, its 36 characters equal no stored value and the server refuses it; as a Uuid it
      // compares with a uuid column.
      return isUuid(id) ? encodeUuid(id) : { type: ColumnType.Id, strValue: id };
    }

    case ColumnType.String:
      return { type: ColumnType.String, strValue: asString(value) };

    case ColumnType.Uuid:
      return encodeUuid(asString(value));

    case ColumnType.Integer64:
      return { type: ColumnType.Integer64, longValue: asBigInt(value) };

    case ColumnType.Float64:
    case ColumnType.Float32:
      return { type: declared, floatValue: asNumber(value) };

    case ColumnType.Bool:
      return { type: ColumnType.Bool, boolValue: asBoolean(value) };

    case ColumnType.Bytes:
      return { type: ColumnType.Bytes, bytesValue: asBytes(value) };

    case ColumnType.Date:
      return { type: ColumnType.Date, longValue: dateToDayTicks(asDate(value)) };

    case ColumnType.DateTime:
      return { type: ColumnType.DateTime, longValue: dateToTicks(asDate(value)) };

    case ColumnType.Array:
      return encodeArray(value, ColumnType.Null);

    default:
      return invalid(`Cannot encode a value as ${columnTypeName(declared)}.`);
  }
}

registerArrayEncoder(encodeAs);

function encodeInferred(value: unknown): ColumnValue {
  if (value === null || value === undefined) return { type: ColumnType.Null };

  switch (typeof value) {
    case 'boolean':
      return { type: ColumnType.Bool, boolValue: value };

    case 'bigint':
      return { type: ColumnType.Integer64, longValue: value };

    case 'string':
      return { type: ColumnType.String, strValue: value };

    case 'number':
      return Number.isInteger(value)
        ? { type: ColumnType.Integer64, longValue: BigInt(value) }
        : { type: ColumnType.Float64, floatValue: value };

    case 'object':
      break;

    default:
      return invalid(`Cannot bind a value of type ${typeof value}.`);
  }

  if (value instanceof Date) {
    return { type: ColumnType.DateTime, longValue: dateToTicks(value) };
  }

  if (value instanceof CamusObjectId) {
    return { type: ColumnType.Id, strValue: value.toString() };
  }

  if (value instanceof Float32Array) {
    return { type: ColumnType.Bytes, bytesValue: packVector(value) };
  }

  if (value instanceof Uint8Array) {
    return { type: ColumnType.Bytes, bytesValue: value };
  }

  if (value instanceof ArrayBuffer) {
    return { type: ColumnType.Bytes, bytesValue: new Uint8Array(value) };
  }

  if (ArrayBuffer.isView(value)) {
    return {
      type: ColumnType.Bytes,
      bytesValue: new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength),
    };
  }

  if (Array.isArray(value)) {
    return encodeArray(value, ColumnType.Null);
  }

  return invalid(`Cannot bind a value of type ${describe(value)}.`);
}

function encodeArray(value: unknown, declaredElementType: ColumnType): ColumnValue {
  if (!Array.isArray(value)) {
    return invalid(`An array parameter needs an array; got ${describe(value)}.`);
  }

  let elementType = declaredElementType;

  if (elementType === ColumnType.Null) {
    for (const item of value) {
      if (item === null || item === undefined) continue;
      elementType = inferElementType(item);
      break;
    }

    if (elementType === ColumnType.Null && value.length > 0) {
      return invalid(
        'Cannot infer the element type of an array parameter whose elements are all null. ' +
          'State it with camus.array(items, ColumnType.…).',
      );
    }
  }

  const items: ColumnValue[] = new Array<ColumnValue>(value.length);

  for (let i = 0; i < value.length; i++) {
    const item = value[i] as unknown;
    items[i] = item === null || item === undefined ? { type: ColumnType.Null } : encodeAs(item, elementType);
  }

  return { type: ColumnType.Array, arrayElementType: elementType, arrayValues: items };
}

function inferElementType(item: unknown): ColumnType {
  if (isTypedParameter(item)) return item.value.type;

  return encodeInferred(item).type;
}

function encodeUuid(value: string): ColumnValue {
  if (!isUuid(value)) {
    return invalid(`'${value}' is not a canonical UUID string.`);
  }

  const { high, low } = uuidToHalves(value);
  return { type: ColumnType.Uuid, strValue: value, uuidHigh: high, longValue: low };
}

function packVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < vector.length; i++) {
    view.setFloat32(i * 4, vector[i] as number, true);
  }

  return bytes;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }

  return invalid(`Cannot use ${describe(value)} as a string value.`);
}

function asIdString(value: unknown): string {
  if (value instanceof CamusObjectId) return value.toString();
  return asString(value);
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      return invalid(`An int64 parameter needs an integer; got ${String(value)}.`);
    }

    return BigInt(value);
  }

  if (typeof value === 'boolean') return value ? 1n : 0n;

  return invalid(`Cannot use ${describe(value)} as an int64 value.`);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;

  return invalid(`Cannot use ${describe(value)} as a float value.`);
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;

  return invalid(`Cannot use ${describe(value)} as a bool value.`);
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Float32Array) return packVector(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
  }

  if (Array.isArray(value)) return Uint8Array.from(value as unknown[] as number[]);

  return invalid(`Cannot use ${describe(value)} as a bytes value.`);
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;

  if (typeof value === 'number') return new Date(value);

  if (typeof value === 'string') {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return invalid(`'${value}' is not a date this driver can read.`);
    }

    return parsed;
  }

  return invalid(`Cannot use ${describe(value)} as a date value.`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return typeof value;

  return value.constructor?.name ?? 'object';
}

function invalid(message: string): never {
  throw new CamusError(CamusErrorCode.InvalidParameter, message);
}
