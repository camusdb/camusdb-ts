/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import type {
  CamusTransport,
  PipelineStatementOutcome,
  PipelineTransportResult,
  StartTransactionResult,
  TransportPipelineRequest,
  TransportSqlRequest,
} from './transport.js';

/**
 * Runs a `TransportPipelineRequest` one exchange per step over a transport's ordinary calls:
 * `BEGIN`, each statement in order, then the commit.
 *
 * It is the fallback that the pipeline API promises when the transport cannot send the request as
 * one exchange. That is REST always, and gRPC against a server that announced no pipeline contract.
 * The caller gets the same outcome shape either way, and only the exchange count differs.
 *
 * A failed statement ends the transaction on the server, which rolls it back. So the statements
 * after it are not sent. They are reported with that same failure, which is in substance what the
 * server would answer them with. The commit is then not tried, and it reports the failure too.
 */
export async function runSequentialPipeline(
  transport: CamusTransport,
  request: TransportPipelineRequest,
): Promise<PipelineTransportResult> {
  let exchanges = 0;
  let started: StartTransactionResult | undefined;
  let txnIdPT = request.txnIdPT;
  let txnIdCounter = request.txnIdCounter;
  let streamSlot = request.streamSlot;

  if (request.start !== undefined) {
    try {
      started = await transport.startTransaction(
        request.endpoint,
        request.database,
        request.start,
        request.timeoutSeconds,
        request.signal,
      );

      exchanges++;
    } catch (error) {
      // A rejected credential is thrown and not reported, so the authenticating wrapper can renew
      // it and replay. Nothing ran, so the replay is safe.
      if (isCancelled(request) || isAuthenticationFailure(error)) throw error;

      const failure = toError(error);

      return {
        startFailure: failure,
        statements: request.statements.map(() => ({ failure })),
        committed: false,
        commitFailure: request.commit ? failure : undefined,
        exchanges,
      };
    }

    txnIdPT = started.txnIdPT;
    txnIdCounter = started.txnIdCounter;
    streamSlot = started.streamSlot;
  }

  const outcomes: PipelineStatementOutcome[] = [];
  let first: Error | undefined;

  for (const statement of request.statements) {
    if (first !== undefined) {
      outcomes.push({ failure: first });
      continue;
    }

    const sql: TransportSqlRequest = {
      endpoint: request.endpoint,
      database: request.database,
      sql: statement.sql,
      parameters: statement.parameters,
      txnIdPT,
      txnIdCounter,
      streamSlot,
      timeoutSeconds: request.timeoutSeconds,
      prepared: statement.prepared,
      routingAcceptVersion: statement.routingAcceptVersion,
      ...(statement.discardReturningRows === true ? { discardReturningRows: true } : {}),
      signal: request.signal,
    };

    try {
      outcomes.push(
        statement.kind === 'query'
          ? { query: await transport.executeQuery(sql) }
          : { nonQuery: await transport.executeNonQuery(sql) },
      );
    } catch (error) {
      if (isCancelled(request)) throw error;

      first = toError(error);
      outcomes.push({ failure: first });
    }

    exchanges++;
  }

  if (!request.commit) return { started, statements: outcomes, committed: false, exchanges };

  if (first !== undefined) {
    return { started, statements: outcomes, committed: false, commitFailure: first, exchanges };
  }

  if (txnIdPT === undefined || txnIdCounter === undefined) {
    const failure = new CamusError(CamusErrorCode.Generic, 'The pipeline has no transaction to commit.');
    return { started, statements: outcomes, committed: false, commitFailure: failure, exchanges };
  }

  try {
    await transport.finalizeTransaction(
      true,
      request.endpoint,
      request.database,
      txnIdPT,
      txnIdCounter,
      streamSlot,
      request.timeoutSeconds,
      request.signal,
    );

    return { started, statements: outcomes, committed: true, exchanges: exchanges + 1 };
  } catch (error) {
    if (isCancelled(request)) throw error;

    return {
      started,
      statements: outcomes,
      committed: false,
      commitFailure: toError(error),
      exchanges: exchanges + 1,
    };
  }
}

/** True when the caller ended the call. That is a failure of the whole call, so it is thrown. */
function isCancelled(request: TransportPipelineRequest): boolean {
  return request.signal?.aborted === true;
}

function isAuthenticationFailure(error: unknown): boolean {
  return CamusError.is(error) && error.code === CamusErrorCode.AuthenticationFailed;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
