// How long the local Node server keeps an idle keep-alive connection open.
//
// Node closes one after 5 s by default. A client that reuses the connection
// just as the server closes it gets ECONNRESET, a request that never reached
// the app. Playwright's request context does reuse its connections: an e2e test
// that called the API, drove the page for ten seconds, then called it again
// failed that way (outcome-matrix.spec.ts on PR #331). So the server keeps idle
// connections longer than any client here holds one: 65 s, the usual choice
// behind a load balancer's 60 s idle timeout. headersTimeout must exceed it,
// or Node closes a reused connection while it waits for the next request's
// headers.
//
// Only server.ts (local dev and e2e) uses this. Production runs on Lambda
// behind CloudFront, which holds the connections.
import type { Server } from 'node:http';

export const KEEP_ALIVE_MS = 65_000;

export function keepIdleConnections(server: Pick<Server, 'keepAliveTimeout' | 'headersTimeout'>): void {
	server.keepAliveTimeout = KEEP_ALIVE_MS;
	server.headersTimeout = KEEP_ALIVE_MS + 1_000;
}
