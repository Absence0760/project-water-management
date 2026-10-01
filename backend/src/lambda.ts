import { assertEdgeSecret, createApp } from './app.js';
import { streamingHandler } from './http/lambdaStream.js';
import { assertLambdaEnv } from './config/production.js';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';
import { assertDownloadSigner } from './reports/storage.js';

// The secrets first (config/runtimeSecrets.ts): once per cold start, from
// Secrets Manager into process.env, before the checks below and before any
// request. Every module reads them lazily, so the imports above are safe.
await loadRuntimeSecrets('api');
// Fail closed: without the secret, app.ts skips the CloudFront check (local
// dev), which in Lambda would open the Function URL past the WAF.
assertEdgeSecret();
// And every other setting production needs (config/production.ts).
assertLambdaEnv('api');
// The report-download key pair: sops holds the private half, Terraform the
// public one, and only here can the two be compared (reports/storage.ts).
assertDownloadSigner();
// Response streaming (WP-1.29a, issue #283): the Function URL's invoke mode is
// RESPONSE_STREAM (infra/lambda.tf), so a response may pass the 6 MB a
// buffered one stops at (the CSV exports, export/download.ts). Every route
// goes through it (http/lambdaStream.ts). The handler and the URL's mode go
// together: a streamed handler's prelude means nothing to a BUFFERED URL, nor a
// buffered handler's result object to a streaming one, so neither changes
// alone (docs/deployment.md § Response streaming).
export const handler = streamingHandler(createApp());
