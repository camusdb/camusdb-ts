/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/**
 * The server error codes this driver reacts to or documents. Every other `CADBxxxx` code reaches the
 * caller unchanged on `CamusError.code`.
 */
export const CamusErrorCode = {
  /** The driver's own generic code, used when the far end supplied none. */
  Generic: 'CADB0000',

  /**
   * The request never reached a server: the transport could not connect to the endpoint. Because
   * nothing was sent, the work is safe to run again on another endpoint. The driver sets this
   * endpoint aside as it raises the code. Raised locally, so it never arrives from a server.
   *
   * It is distinct from `Generic`, which also covers a call that was sent and then lost, and whose
   * outcome is therefore unknown.
   */
  EndpointUnreachable: 'CADB0001',

  /** A parameter cannot be mapped to a wire value. Raised locally, before any request. */
  InvalidParameter: 'CADB0400',

  /** A byte payload read as a vector has a length that is not a multiple of four. */
  InvalidVector: 'CADB0410',

  /**
   * A column storage strategy (`STORAGE PLAIN | MAIN | EXTERNAL | EXTENDED`) was given for a column
   * whose type has no variable-length value. Only `string`, `bytes`, and array columns take one.
   */
  ColumnStorageNotApplicable: 'CADB0414',

  /** The database already exists. Also raised when `IF NOT EXISTS` loses a registration race. */
  DatabaseAlreadyExists: 'CADB0012',

  /**
   * The commit or rollback outcome is not resolved yet. The transaction is not dead: the same
   * finalize must be re-issued on the same handle, never replayed from `BEGIN`.
   */
  FinalizeUnresolved: 'CADB0509',

  /**
   * No token, an invalid or expired token, an unknown user, or a wrong password (HTTP 401). Every
   * authentication failure returns this one code so replies cannot be used to enumerate accounts.
   */
  AuthenticationFailed: 'CADB0516',

  /** Authenticated, but without the privilege the statement needs (HTTP 403). Never retried. */
  InsufficientPrivilege: 'CADB0517',

  /** The login rate limit was exceeded, or the key derivation function is saturated (HTTP 429). */
  TooManyAuthAttempts: 'CADB0518',

  /** A request that carries a credential arrived over a plaintext connection (HTTP 400). */
  InsecureTransport: 'CADB0519',

  /** The named prepared statement is gone: it expired, or the node that held it restarted. */
  UnknownPreparedStatement: 'CADB0520',

  /** The per-principal prepared-statement cap is full. */
  PreparedStatementLimitExceeded: 'CADB0521',

  /** The statement runs in its own internal transaction and is refused inside an explicit one. */
  StatementNotAllowedInTransaction: 'CADB0538',

  /**
   * A stored large value could not be read back. A compressed value failed to decompress, or an
   * out-of-line value was missing or did not match its checksum. The server retries a concurrent
   * update before it raises this code, so the code means damaged data, not a race.
   */
  LargeValueCorrupt: 'CADB0540',

  /**
   * A server defect: a read path decoded a large value that it did not fetch. The server raises it so
   * that no internal pointer reaches a result. Report it.
   */
  LargeValueNotResolved: 'CADB0541',
} as const;

export type CamusErrorCode = (typeof CamusErrorCode)[keyof typeof CamusErrorCode];
