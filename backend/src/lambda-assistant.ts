// The AI assistant's Lambda (issue #610; infra/assistant.tf, docs/deployment.md
// § The assistant).
//
// The same app as the API (lambda.ts), behind its own Function URL in
// RESPONSE_STREAM mode, for one reason: a turn is several model calls and tool
// reads and can run past the API's 30 s timeout, which must stay under
// CloudFront's 35 s origin read timeout (infra/variables.tf). CloudFront sends
// /api/projects/*/assistant/* here (infra/s3_cloudfront.tf), this function
// gets a 120 s timeout, and the stream's keepalive comments keep each gap
// under the origin's read timeout.
//
// Serving the whole app keeps one middleware chain for every route: the
// CloudFront shared-secret check, the ambiguous-path refusal, CORS, CSRF and
// the body limit, then requireUser and the routes' own role checks, exactly as
// on the API. But only the assistant's paths: every other path is a 404 here,
// before the app sees it. This function has a longer timeout, its own reserved
// concurrency and the one IAM role that may call the model, so it must not
// become a second way in to routes the API serves (an export, a model run or a
// delineation would then run on its budget and its long timeout). The paths
// are matched on the request's URL as the app parses it (dot segments already
// resolved, percent-encoding kept), so a path that only decodes to an
// assistant path, or only looks like one before its dots resolve, is refused
// here or by the app's own refuseAmbiguousPaths (http/assistantOnly.ts).
//
// Like lambda.ts, this must never import a module that loads dotenv
// (docs/STACK.md § Two backend entry points; infra/scripts/package-lambdas.sh
// refuses the bundle).
import { assertEdgeSecret, createApp } from './app.js';
import { assistantOnly } from './http/assistantOnly.js';
import { streamingHandler } from './http/lambdaStream.js';
import { assertLambdaEnv } from './config/production.js';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';

// As lambda.ts: the runtime secret first (once per cold start), then the
// edge secret, without which app.ts would skip the CloudFront check and leave
// the Function URL open past the WAF, then every other production setting.
await loadRuntimeSecrets('assistant');
assertEdgeSecret();
assertLambdaEnv('assistant');
export const handler = streamingHandler(assistantOnly(createApp()));
