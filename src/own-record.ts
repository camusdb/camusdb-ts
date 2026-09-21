/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Stores a value under a key that came from outside the driver.
 *
 * Plain assignment through `record[key]` reaches the `__proto__` setter on `Object.prototype`. A
 * column or a parameter literally named `__proto__` — which a caller can produce from `JSON.parse`
 * output — would therefore rewrite the record's prototype and never become a property of its own.
 * `Object.defineProperty` installs an own property for every key, so the name survives.
 */
export function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, writable: true, enumerable: true, configurable: true });
}
