/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * Every failure this driver raises for a database-level problem.
 *
 * `code` is the server's `CADBxxxx` code, taken from the HTTP body's `code` field or from the
 * `camus-error-code` gRPC trailer. It is the value to switch on; the message is human text and is
 * not a stable contract. `CADB0000` is the generic code the driver uses when the far end supplied
 * none.
 */
export class CamusError extends Error {
  override readonly name = 'CamusError';

  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;

    // Keeps `instanceof` working when the package is compiled down to ES5 by a consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** True when `value` is a `CamusError`, including one raised by another copy of this package. */
  static is(value: unknown): value is CamusError {
    return (
      value instanceof CamusError ||
      (typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'CamusError' &&
        typeof (value as { code?: unknown }).code === 'string')
    );
  }
}
