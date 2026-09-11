/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from './errors.js';
import { CamusErrorCode } from './error-codes.js';

/**
 * Parses and redacts a `key=value;key=value` connection string.
 *
 * Keys are matched without regard to case and are trimmed, so `password=`, `Password=` and
 * ` Password ` all reach the same entry. A repeated key is an error rather than a silent
 * first-wins: the two spellings usually disagree, and the one that loses would disappear without a
 * diagnostic.
 *
 * An unquoted value is trimmed and ends at the next `;`. A value that must carry a semicolon, or
 * leading or trailing spaces, is written in single or double quotes (`Password='p;w'`); double the
 * quote character to include one (`Password='p''w'`).
 *
 * A segment with no `=` is ignored, which is what an empty connection string relies on.
 */

/** One parsed key and value, with the positions the value occupied in the source. */
interface Setting {
  readonly key: string;
  readonly value: string;
  readonly valueStart: number;
  readonly valueLength: number;
}

/**
 * The parsed settings, keyed by lowercase key name. The original spelling of each key is kept so a
 * diagnostic can name the key the way the caller wrote it.
 */
export class ConnectionStringSettings {
  private readonly entries = new Map<string, { key: string; value: string }>();

  constructor(entries: Iterable<{ key: string; value: string }>) {
    for (const entry of entries) {
      this.entries.set(entry.key.toLowerCase(), entry);
    }
  }

  /** The value for a key, or `undefined`. Matching ignores case. */
  get(key: string): string | undefined {
    return this.entries.get(key.toLowerCase())?.value;
  }

  /** The first key of `keys` that has a value that is not blank. */
  first(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined && value.trim().length > 0) return value;
    }

    return undefined;
  }

  /** True when the key is present, even with an empty value. */
  has(key: string): boolean {
    return this.entries.has(key.toLowerCase());
  }

  /** Replaces or adds a value. Used by `changeDatabase`. */
  set(key: string, value: string): void {
    const existing = this.entries.get(key.toLowerCase());
    this.entries.set(key.toLowerCase(), { key: existing?.key ?? key, value });
  }

  /** Every key and value, in insertion order. */
  *[Symbol.iterator](): IterableIterator<{ key: string; value: string }> {
    yield* this.entries.values();
  }
}

/**
 * Parses a connection string.
 *
 * @throws {CamusError} `CADB0000` when a key appears twice, or a quoted value is not closed.
 */
export function parseConnectionString(connectionString: string): ConnectionStringSettings {
  const seen = new Set<string>();
  const entries: { key: string; value: string }[] = [];

  for (const setting of enumerateSettings(connectionString)) {
    const lowercase = setting.key.toLowerCase();

    if (seen.has(lowercase)) {
      throw new CamusError(
        CamusErrorCode.Generic,
        `The connection string sets '${setting.key}' more than once. Keys are matched without regard ` +
          'to case; remove the duplicate.',
      );
    }

    seen.add(lowercase);
    entries.push({ key: setting.key, value: setting.value });
  }

  return new ConnectionStringSettings(entries);
}

/** The keys whose values a redacted string masks. */
const SECRET_KEYS = new Set(['password', 'pwd', 'accesstoken']);

/**
 * What a masked secret is replaced with. Not the empty string: an empty value reads as "no
 * password was configured", which is a different fact.
 */
const REDACTED = '***';

/**
 * The connection string with every secret replaced by `***`. Everything else, including the
 * original spelling and order of the keys, is left as written, so the result still identifies the
 * connection.
 *
 * Use it for anything that is logged, printed, or reported as diagnostics.
 */
export function redactConnectionString(connectionString: string | undefined | null): string {
  if (connectionString === undefined || connectionString === null || connectionString.trim().length === 0) {
    return connectionString ?? '';
  }

  let settings: Setting[];

  try {
    settings = enumerateSettings(connectionString);
  } catch {
    // A string that cannot be parsed cannot be masked reliably, and printing it might disclose the
    // secret it failed to parse. Report nothing rather than guess.
    return REDACTED;
  }

  let out = '';
  let copied = 0;

  for (const setting of settings) {
    if (!SECRET_KEYS.has(setting.key.toLowerCase())) continue;

    // The value's text is replaced in place, keeping any quotes around it, so the shape of the
    // string does not change.
    out += connectionString.slice(copied, setting.valueStart) + REDACTED;
    copied = setting.valueStart + setting.valueLength;
  }

  return out + connectionString.slice(copied);
}

function enumerateSettings(source: string): Setting[] {
  const settings: Setting[] = [];
  let position = 0;

  while (position < source.length) {
    // The key runs to the next '=' or ';'.
    const keyStart = position;

    while (position < source.length && source[position] !== '=' && source[position] !== ';') {
      position++;
    }

    if (position >= source.length || source[position] === ';') {
      // A segment with no '=' carries nothing to set. Skip it and take the next one.
      position++;
      continue;
    }

    const key = source.slice(keyStart, position).trim();
    position++; // past the '='

    while (position < source.length && (source[position] === ' ' || source[position] === '\t')) {
      position++;
    }

    let valueStart: number;
    let valueLength: number;
    let value: string;

    const quote = source[position];

    if (quote === "'" || quote === '"') {
      position++;
      valueStart = position;

      for (;;) {
        if (position >= source.length) {
          throw new CamusError(
            CamusErrorCode.Generic,
            `The connection string has an unclosed ${quote} quoted value. Double the quote character ` +
              'to include one in a value.',
          );
        }

        if (source[position] === quote) {
          // A doubled quote is one literal quote, not the end of the value.
          if (source[position + 1] === quote) {
            position += 2;
            continue;
          }

          break;
        }

        position++;
      }

      valueLength = position - valueStart;
      value = source.slice(valueStart, position).replaceAll(quote + quote, quote);
      position++; // past the closing quote

      // Anything between the closing quote and the ';' is whitespace or a typo. Skip to the ';'.
      while (position < source.length && source[position] !== ';') position++;
    } else {
      const rawStart = position;

      while (position < source.length && source[position] !== ';') position++;

      const raw = source.slice(rawStart, position);
      const leading = raw.length - raw.trimStart().length;

      value = raw.trim();
      valueStart = rawStart + leading;
      valueLength = value.length;
    }

    position++; // past the ';'

    if (key.length > 0) {
      settings.push({ key, value, valueStart, valueLength });
    }
  }

  return settings;
}
