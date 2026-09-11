import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the fake server received, with its body already read. */
export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody: string;
  readonly body: unknown;
}

/** How the fake server answers one route. */
export type RouteHandler = (
  request: RecordedRequest,
  response: ServerResponse,
  callNumber: number,
) => void | Promise<void>;

/**
 * A CamusDB server stand-in over real HTTP.
 *
 * The driver's REST path runs on `fetch`, streams, timeouts, and abort signals, and none of those
 * behave the same against a stubbed function as against a socket. So the tests talk to a real
 * server on a loopback port, and assert on what actually crossed the wire.
 */
export class FakeCamusServer {
  private readonly server: Server;

  private readonly routes = new Map<string, RouteHandler>();

  private readonly callCounts = new Map<string, number>();

  /** Every request received, in order. */
  readonly requests: RecordedRequest[] = [];

  private constructor(server: Server) {
    this.server = server;
  }

  /** Starts a server on a free loopback port. */
  static async start(): Promise<FakeCamusServer> {
    const server = createServer();
    const fake = new FakeCamusServer(server);

    server.on('request', (request, response) => {
      void fake.handle(request, response);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return fake;
  }

  /** The base URL a client connects to. */
  get endpoint(): string {
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** Answers one path. The handler receives how many times that path has been called. */
  on(path: string, handler: RouteHandler): this {
    this.routes.set(path, handler);
    return this;
  }

  /** Answers one path with a JSON body and a status. */
  json(path: string, body: unknown, status = 200): this {
    return this.on(path, (_request, response) => {
      respondJson(response, status, body);
    });
  }

  /** How many times a path was called. */
  callCount(path: string): number {
    return this.callCounts.get(path) ?? 0;
  }

  /** The requests that reached one path. */
  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  /** Forgets every recorded request and call count. Routes are kept. */
  reset(): void {
    this.requests.length = 0;
    this.callCounts.clear();
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.endpoint);
    const path = url.pathname.replace(/^\//, '');

    const rawBody = await readBody(request);

    const recorded: RecordedRequest = {
      method: request.method ?? 'GET',
      path,
      query: url.searchParams,
      headers: request.headers,
      rawBody,
      body: rawBody.length > 0 ? safeParse(rawBody) : undefined,
    };

    this.requests.push(recorded);

    const callNumber = (this.callCounts.get(path) ?? 0) + 1;
    this.callCounts.set(path, callNumber);

    const handler = this.routes.get(path);

    if (handler === undefined) {
      respondJson(response, 404, { status: 'failed', code: 'CADB0000', message: `no route for ${path}` });
      return;
    }

    try {
      await handler(recorded, response, callNumber);
    } catch (error) {
      if (!response.writableEnded) {
        respondJson(response, 500, { status: 'failed', message: String(error) });
      }
    }
  }
}

/** Writes a JSON body. */
export function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(text);
}

/** Writes newline-delimited JSON, one record per line. */
export function respondNdjson(response: ServerResponse, lines: readonly unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

  for (const line of lines) {
    response.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
  }

  response.end();
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
