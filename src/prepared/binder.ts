/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { ColumnValue } from '../column-value.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';

/**
 * Orders a call's parameter values the way a prepared statement binds them.
 *
 * The server publishes the statement's placeholder names in binding order when it registers the
 * statement. Every later execution then sends only values, positionally, so neither the SQL nor
 * the names travel again. This function is where a named map becomes that ordered list.
 *
 * A placeholder with no bound value is an error rather than a null. The statement declares it, so
 * a missing value is a mistake in the call, and sending a null would run the statement against a
 * value the caller never wrote.
 */
export function bindPositional(
  parameterNames: readonly string[],
  parameters: ReadonlyMap<string, ColumnValue> | undefined,
): ColumnValue[] {
  const values: ColumnValue[] = new Array<ColumnValue>(parameterNames.length);

  for (let i = 0; i < parameterNames.length; i++) {
    const name = parameterNames[i]!;
    const value = parameters?.get(name);

    if (value === undefined) {
      throw new CamusError(
        CamusErrorCode.InvalidParameter,
        `The prepared statement declares the parameter '${name}' but no value was bound for it.`,
      );
    }

    values[i] = value;
  }

  return values;
}
