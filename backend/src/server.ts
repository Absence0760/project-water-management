// Load local-dev env (config/devEnv.ts: the env files, and this checkout's own
// dev database). This is only reached via server.ts (the local Node entry
// point) — the Lambda entry in lambda.ts never imports server.ts, so esbuild
// tree-shakes dotenv out of the deployment bundle.
import { loadDevEnv } from './config/devEnv.js';
loadDevEnv();

import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { keepIdleConnections } from './http/keepAlive.js';

const app = createApp();
const port = Number(process.env.PORT ?? 3001);

const server = serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Backend listening on http://localhost:${info.port}`);
});
// Longer than Node's 5 s, so a client reusing an idle connection isn't reset (http/keepAlive.ts).
keepIdleConnections(server as Server);
