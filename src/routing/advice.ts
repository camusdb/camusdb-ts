/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

/** Whether routing advice asks the client to remember a destination or to forget one. */
export const CamusRoutingDisposition = {
  /** A disposition this driver does not know. The advice is ignored. */
  Unknown: 'unknown',
  /** Remember the advertised node for future executions of this statement. */
  Prefer: 'prefer',
  /** Forget any destination learned for this statement. */
  Clear: 'clear',
} as const;

export type CamusRoutingDisposition = (typeof CamusRoutingDisposition)[keyof typeof CamusRoutingDisposition];

/** The only routing metadata version this driver accepts. */
export const ROUTING_ACCEPT_VERSION = 1;

/**
 * Advisory routing metadata attached to a successful statement response.
 *
 * It is a performance hint, never an instruction: the statement that carried it already ran
 * normally, and a client that ignores it loses nothing but a network hop. It never carries SQL
 * literals, row values, encoded keys, credentials, or a cluster map.
 *
 * `preferredNodeId` is an opaque node identity, not an address to dial. It becomes a destination
 * only through the client's configured `routingNodes` trust map.
 */
export interface CamusRoutingAdvice {
  /** The metadata contract version. Advice of any other version is ignored. */
  readonly version: number;

  readonly disposition: CamusRoutingDisposition;

  /** The opaque node identity to prefer. */
  readonly preferredNodeId?: string | undefined;

  /**
   * True when the destination holds across different parameter values for this statement. A
   * narrower scope is not reusable, so the advice is ignored.
   */
  readonly parametersIndependentScope: boolean;

  /**
   * An opaque change detector over the statement's resolved physical dependencies. It changes when
   * the dependency set changes: a schema change, a TRUNCATE, a view refresh, a recreated database.
   * It is not sortable and it is not authentication.
   */
  readonly dependencyToken?: string | undefined;

  /** The longest period the route may be reused, in milliseconds, measured from receipt. */
  readonly maxAgeMs: number;

  /** Why the server chose this disposition. Diagnostic only. */
  readonly reason?: string | undefined;
}

/** Builds the public object from decoded parts, whichever transport decoded them. */
export function makeRoutingAdvice(parts: {
  version: number;
  disposition: string | undefined;
  preferredNodeId: string | undefined;
  reuseScope: string | undefined;
  dependencyToken: string | undefined;
  maxAgeMs: number;
  reason: string | undefined;
}): CamusRoutingAdvice {
  return {
    version: parts.version,
    disposition: parseDisposition(parts.disposition),
    preferredNodeId: parts.preferredNodeId,
    parametersIndependentScope: parts.reuseScope === 'statementParametersIndependent',
    dependencyToken: parts.dependencyToken,
    maxAgeMs: parts.maxAgeMs,
    reason: parts.reason,
  };
}

function parseDisposition(disposition: string | undefined): CamusRoutingDisposition {
  switch (disposition) {
    case 'prefer':
      return CamusRoutingDisposition.Prefer;
    case 'clear':
      return CamusRoutingDisposition.Clear;
    default:
      return CamusRoutingDisposition.Unknown;
  }
}

/** Reads advice out of a REST response body, or reports `undefined` when the body carried none. */
export function routingAdviceFromJson(body: unknown): CamusRoutingAdvice | undefined {
  if (typeof body !== 'object' || body === null) return undefined;

  const routing = (body as { routing?: unknown }).routing;
  if (typeof routing !== 'object' || routing === null) return undefined;

  const record = routing as Record<string, unknown>;

  return makeRoutingAdvice({
    version: typeof record.version === 'number' ? record.version : 0,
    disposition: readString(record.disposition),
    preferredNodeId: readString(record.preferredNodeId),
    reuseScope: readString(record.reuseScope),
    dependencyToken: readString(record.dependencyToken),
    maxAgeMs: typeof record.maxAgeMs === 'number' ? record.maxAgeMs : 0,
    reason: readString(record.reason),
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
