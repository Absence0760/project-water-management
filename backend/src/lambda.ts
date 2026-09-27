import { handle } from 'hono/aws-lambda';
import { assertEdgeSecret, createApp } from './app.js';

// Fail closed: without the secret, app.ts skips the CloudFront check (local
// dev), which in Lambda would open the Function URL past the WAF.
assertEdgeSecret();
export const handler = handle(createApp());
