// The local server's keep-alive timeouts (http/keepAlive.ts): longer than
// Node's 5 s default, which reset a reused e2e connection, and headersTimeout
// above keepAliveTimeout, as Node requires.
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { KEEP_ALIVE_MS, keepIdleConnections } from './keepAlive.js';

describe('keepIdleConnections', () => {
	it('keeps an idle connection for 65 s, not Node’s 5 s, with headersTimeout above it', () => {
		const server = createServer();
		// Positive control: Node's default is what reset the connection.
		expect(server.keepAliveTimeout).toBe(5_000);
		keepIdleConnections(server);
		expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
		expect(KEEP_ALIVE_MS).toBeGreaterThan(60_000);
		expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
	});
});
