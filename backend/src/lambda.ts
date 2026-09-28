import { handle } from 'hono/aws-lambda';
import { assertEdgeSecret, createApp } from './app.js';
import { assertLambdaEnv } from './config/production.js';

// Fail closed: without the secret, app.ts skips the CloudFront check (local
// dev), which in Lambda would open the Function URL past the WAF.
assertEdgeSecret();
// And every other setting production needs (config/production.ts).
assertLambdaEnv('api');
export const handler = handle(createApp());
