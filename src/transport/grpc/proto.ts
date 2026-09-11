/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import { fileURLToPath } from 'node:url';

import { CamusError } from '../../errors.js';
import { CamusErrorCode } from '../../error-codes.js';

/**
 * Loads the gRPC service definitions from `camus_sql.proto` — the same file that is the server's
 * source of truth, so the REST and gRPC surfaces cannot drift apart.
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer dependencies. A REST client is the
 * common case and must not have to install a gRPC stack it will never open, so both are imported
 * only when a gRPC client is actually built, and a missing one is reported with the command that
 * installs it.
 */

/** The generated client stubs, kept as loose shapes because proto-loader builds them at run time. */
export interface CamusGrpcClients {
  readonly sql: GrpcServiceClient;
  readonly auth: GrpcServiceClient;
  readonly rows: GrpcServiceClient;
  readonly close: () => void;
}

/** Enough of a grpc-js client to call it. The method names come from the service definition. */
export interface GrpcServiceClient {
  [method: string]: unknown;
  close?: () => void;
}

/** The subset of `@grpc/grpc-js` this driver uses. */
export interface GrpcRuntime {
  readonly credentials: {
    createInsecure: () => unknown;
    createSsl: () => unknown;
  };
  readonly Metadata: new () => GrpcMetadata;
  readonly loadPackageDefinition: (definition: unknown) => Record<string, unknown>;
  readonly status: Record<string, number>;
}

export interface GrpcMetadata {
  set: (key: string, value: string) => void;
  get: (key: string) => (string | Buffer)[];
}

/** A duplex call as grpc-js hands it back. */
export interface GrpcDuplexCall<TRequest, TResponse> {
  write: (message: TRequest, callback?: (error?: Error | null) => void) => boolean;
  end: () => void;
  cancel: () => void;
  on: ((event: 'data', listener: (message: TResponse) => void) => void) &
    ((event: 'error', listener: (error: GrpcStatusError) => void) => void) &
    ((event: 'end' | 'close', listener: () => void) => void);
  once: (event: string, listener: (...args: never[]) => void) => void;
  removeAllListeners: () => void;
}

/** A gRPC failure as grpc-js raises it. */
export interface GrpcStatusError extends Error {
  readonly code?: number;
  readonly details?: string;
  readonly metadata?: GrpcMetadata;
}

interface LoadedRuntime {
  readonly runtime: GrpcRuntime;
  readonly definition: Record<string, unknown>;
}

let loaded: Promise<LoadedRuntime> | undefined;

/**
 * The gRPC runtime and the parsed service definitions, loaded once per process.
 *
 * Parsing the proto file costs real work and the result is immutable, so it is memoized. A failed
 * load is not memoized, so a missing dependency installed later is picked up without a restart.
 */
export async function loadGrpc(): Promise<LoadedRuntime> {
  loaded ??= loadOnce().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });

  return loaded;
}

async function loadOnce(): Promise<LoadedRuntime> {
  const runtime = (await importOptional('@grpc/grpc-js')) as GrpcRuntime;
  const protoLoader = (await importOptional('@grpc/proto-loader')) as {
    loadSync: (filename: string, options: unknown) => unknown;
  };

  const packageDefinition = protoLoader.loadSync(protoPath(), {
    keepCase: false,
    // A 64-bit field arrives as a decimal string and is converted to a bigint here. Reading it as
    // a JavaScript number would round any value above 2^53, and this driver's whole int64 contract
    // rests on that not happening.
    longs: String,
    enums: Number,
    bytes: Buffer,
    defaults: true,
    oneofs: true,
  });

  return { runtime, definition: runtime.loadPackageDefinition(packageDefinition) };
}

async function importOptional(specifier: string): Promise<unknown> {
  try {
    return (await import(specifier)) as unknown;
  } catch (error) {
    throw new CamusError(
      CamusErrorCode.Generic,
      `The gRPC transport needs the optional package '${specifier}'. Install it with ` +
        "'npm install @grpc/grpc-js @grpc/proto-loader', or use the REST protocol.",
      { cause: error },
    );
  }
}

/**
 * Where `camus_sql.proto` lives, relative to this module.
 *
 * The path holds for both the compiled layout (`dist/transport/grpc/`) and the source layout
 * (`src/transport/grpc/`), because both sit three levels below the package root, and `proto/` is
 * listed in the package's published files.
 */
function protoPath(): string {
  return fileURLToPath(new URL('../../../proto/camus_sql.proto', import.meta.url));
}

/** The constructor for one service, taken from the loaded definitions. */
export function serviceConstructor(
  definition: Record<string, unknown>,
  serviceName: string,
): new (address: string, credentials: unknown, options?: unknown) => GrpcServiceClient {
  const service = definition[serviceName];

  if (typeof service !== 'function') {
    throw new CamusError(
      CamusErrorCode.Generic,
      `camus_sql.proto declares no service named '${serviceName}'.`,
    );
  }

  return service as new (address: string, credentials: unknown, options?: unknown) => GrpcServiceClient;
}
