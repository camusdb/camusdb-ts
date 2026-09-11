/**
 * This file is part of CamusDB
 *
 * For the full copyright and license information, please view the LICENSE.txt
 * file that was distributed with this source code.
 */

import type { ColumnType } from '../column-type.js';
import type { ColumnValue } from '../column-value.js';
import { NULL_VALUE } from '../column-value.js';
import { CamusError } from '../errors.js';
import { CamusErrorCode } from '../error-codes.js';
import { parseLossless } from '../json.js';
import type { CamusRowSource } from '../row-source.js';
import { sanitizeErrorText } from './error-text.js';
import { decodeCell, readSchema } from './rest-decode.js';

/** The content type the streaming query endpoint serves and expects in `Accept`. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/**
 * Rows pulled off the network one line at a time.
 *
 * The streaming query endpoint writes newline-delimited JSON: one header object naming the output
 * columns, then one array per row, then one trailer object. So a result of many thousands of rows
 * never fully materializes on this side — the caller advances, and one more line is read.
 *
 * The trailer is what makes the framing more than a convenience. A conflict that surfaces after
 * the first row has already been sent cannot be reported as an HTTP status, because the status
 * line is long gone. The server reports it in the trailer instead, and this source raises it from
 * the read that reaches it.
 */
export class NdjsonRowSource implements CamusRowSource {
  readonly columnNames: readonly string[];

  readonly columnTypes: readonly ColumnType[];

  readonly recordsAffected = -1;

  private readonly lines: LineReader;

  private finished = false;

  private closed = false;

  private constructor(lines: LineReader, names: readonly string[], types: readonly ColumnType[]) {
    this.lines = lines;
    this.columnNames = names;
    this.columnTypes = types;
  }

  /** Reads the header line and reports a source positioned before the first row. */
  static async create(body: ReadableStream<Uint8Array>): Promise<NdjsonRowSource> {
    const lines = new LineReader(body);

    let header: string | undefined;

    try {
      header = await readNonEmptyLine(lines);
    } catch (error) {
      await lines.close();
      throw error;
    }

    if (header === undefined) {
      await lines.close();
      throw new CamusError(
        CamusErrorCode.Generic,
        'The streaming query response ended before its schema header.',
      );
    }

    let parsed: unknown;

    try {
      parsed = parseLossless(header);
    } catch (error) {
      await lines.close();
      throw new CamusError(
        CamusErrorCode.Generic,
        'The streaming query response did not start with a schema header.',
        { cause: error },
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      await lines.close();
      throw new CamusError(
        CamusErrorCode.Generic,
        'The streaming query response did not start with a schema header.',
      );
    }

    try {
      // A header can already carry a failure. The server writes it before pulling rows, so this is
      // rare, but it is the one place such a failure can appear.
      throwIfFailed(parsed as Record<string, unknown>);
    } catch (error) {
      await lines.close();
      throw error;
    }

    const { names, types } = readSchema((parsed as { columns?: unknown }).columns);

    return new NdjsonRowSource(lines, names, types);
  }

  async next(): Promise<readonly ColumnValue[] | undefined> {
    if (this.finished) return undefined;

    const line = await readNonEmptyLine(this.lines);

    if (line === undefined) {
      this.finished = true;
      return undefined;
    }

    const parsed = parseLossless(line);

    if (Array.isArray(parsed)) {
      const cells: ColumnValue[] = new Array<ColumnValue>(this.columnTypes.length).fill(NULL_VALUE);
      const limit = Math.min(cells.length, parsed.length);

      for (let c = 0; c < limit; c++) {
        cells[c] = decodeCell(parsed[c] as unknown, this.columnTypes[c]!);
      }

      return cells;
    }

    // An object is the trailer. It is the terminal line, and a failed status on it is an error
    // reported in band.
    this.finished = true;

    if (typeof parsed === 'object' && parsed !== null) {
      throwIfFailed(parsed as Record<string, unknown>);
    }

    return undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;
    this.finished = true;
    await this.lines.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * The server writes exactly one record per line, but a blank line is skipped so stray framing
 * never reads as an early end of stream.
 */
async function readNonEmptyLine(lines: LineReader): Promise<string | undefined> {
  for (;;) {
    const line = await lines.read();

    if (line === undefined) return undefined;
    if (line.trim().length > 0) return line;
  }
}

function throwIfFailed(meta: Record<string, unknown>): void {
  if (meta.status !== 'failed') return;

  const code = typeof meta.code === 'string' ? meta.code : CamusErrorCode.Generic;
  const message = typeof meta.message === 'string' ? meta.message : '';

  throw new CamusError(code, sanitizeErrorText(message));
}

/**
 * Splits a byte stream into newline-terminated strings.
 *
 * A JSON line can be split across any number of network reads, so the tail of an incomplete line
 * is held and the search for the next newline resumes where the last one stopped. Without that
 * resume point, a line of N bytes arriving in fragments would be rescanned from its start on every
 * read, which is what short reads from a network stream produce routinely.
 */
class LineReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  private readonly decoder = new TextDecoder('utf-8');

  private buffer = '';

  private searched = 0;

  private eof = false;

  private closed = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** The next line without its terminator, or `undefined` at the end of the stream. */
  async read(): Promise<string | undefined> {
    for (;;) {
      const newline = this.buffer.indexOf('\n', this.searched);

      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);

        this.buffer = this.buffer.slice(newline + 1);
        this.searched = 0;

        return line.endsWith('\r') ? line.slice(0, -1) : line;
      }

      // Everything held has now been examined; the next search resumes at what the next read adds.
      this.searched = this.buffer.length;

      if (this.eof) return this.takeRemainder();

      const { done, value } = await this.reader.read();

      if (done) {
        this.eof = true;
        this.buffer += this.decoder.decode();
        continue;
      }

      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;

    this.closed = true;

    try {
      await this.reader.cancel();
    } catch {
      // The stream is already gone. Nothing is left to release.
    }

    this.reader.releaseLock();
  }

  /** The unterminated tail after the last newline, taken once at the end of the stream. */
  private takeRemainder(): string | undefined {
    if (this.buffer.length === 0) return undefined;

    const line = this.buffer;

    this.buffer = '';
    this.searched = 0;

    return line.endsWith('\r') ? line.slice(0, -1) : line;
  }
}
