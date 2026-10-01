// The CSV download response every CSV route sends (WP-1.29a, issue #283):
// measured against MAX_CSV_EXPORT_BYTES, then streamed (csv.ts csvStream).
// The same Response streams on the Node server (@hono/node-server pipes a
// ReadableStream body) and in Lambda (the API's Function URL is in
// RESPONSE_STREAM mode and lambda.ts uses the streaming adapter,
// http/lambdaStream.ts), so
// dev and production take one code path. docs/api.md § Export.
import type { Context } from 'hono';
import { ApiError } from '../http/errors.js';
import { attachment, csvStream, MAX_CSV_EXPORT_BYTES } from './csv.js';

const MB = (MAX_CSV_EXPORT_BYTES / 1024 / 1024).toFixed(0);

/** The 413 for a CSV past the cap: `hint` says how to narrow it. */
export const csvTooLarge = (hint: string) => new ApiError(413, `export larger than ${MB} MB — ${hint}`);

/**
 * A `200 text/csv` attachment streaming `lines` (a factory: it is walked once
 * to measure and once to send), or a thrown 413 (`tooLarge`) before any byte
 * when the body would pass the cap. `lines` must read only what the route has
 * already loaded: the body is read after the route's transaction ends.
 */
export function csvDownload(c: Context, lines: () => Iterable<string>, filename: string, tooLarge: ApiError, maxBytes = MAX_CSV_EXPORT_BYTES): Response {
	const csv = csvStream(lines, maxBytes);
	if (!csv) throw tooLarge;
	return c.body(csv.body, 200, {
		'Content-Type': 'text/csv; charset=utf-8',
		'Content-Disposition': attachment(filename),
		'Cache-Control': 'no-store'
	});
}
