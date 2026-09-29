import { handle } from 'hono/aws-lambda';
import { assertEdgeSecret, createApp } from './app.js';
import { assertLambdaEnv } from './config/production.js';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';

// The secrets first (config/runtimeSecrets.ts): once per cold start, from
// Secrets Manager into process.env, before the checks below and before any
// request. Every module reads them lazily, so the imports above are safe.
await loadRuntimeSecrets('api');
// Fail closed: without the secret, app.ts skips the CloudFront check (local
// dev), which in Lambda would open the Function URL past the WAF.
assertEdgeSecret();
// And every other setting production needs (config/production.ts).
assertLambdaEnv('api');
export const handler = handle(createApp());
