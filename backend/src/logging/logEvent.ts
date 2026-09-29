// One structured log line: `{ event, ...fields }`. The CloudWatch metric
// filters behind the alarms (infra/alarms.tf, infra/jobs.tf) match on the
// event name, so the shape each line lands in matters.
//
// Every Lambda uses Lambda's JSON log format (infra/, `logging_config`). Its
// Node runtime client (aws-lambda-ric LogPatch) wraps each console call in
// `{ timestamp, level, requestId, message }`, where `message` is the single
// argument itself when there is exactly one, and a util.format string
// otherwise. So on Lambda the fields go in as one object, landing under
// `message` as nested JSON (`$.message.event` in a filter pattern); a
// JSON-encoded string would land as an opaque string that no JSON pattern can
// reach. Off Lambda (local dev, tests) there is no wrapper, and one JSON
// string per line stays greppable and parseable.
//
// Lambda sets AWS_LAMBDA_LOG_FORMAT=JSON when the function's log format is
// JSON; the runtime client reads the same variable to decide how to format.

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = { event: string } & Record<string, unknown>;

/** True when the Lambda runtime wraps console output as JSON (log format JSON). */
export function lambdaJsonLogs(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AWS_LAMBDA_LOG_FORMAT?.toUpperCase() === 'JSON';
}

/**
 * Log one structured event at `level` (console.info / warn / error, which
 * the JSON log format records as INFO / WARN / ERROR, and which the
 * function's application log level can filter out below its threshold).
 */
export function logEvent(level: LogLevel, fields: LogFields): void {
	console[level](lambdaJsonLogs() ? fields : JSON.stringify(fields));
}

/**
 * Write an Embedded Metric Format line straight to stdout. Under the JSON log
 * format a console call would nest it under `message`, and CloudWatch only
 * extracts EMF from a top-level `_aws` key (AWS: "Using embedded metric
 * format client libraries with structured JSON logs"). Lambda records a raw
 * stdout line that has no level as INFO, so the function's application log
 * level must be INFO or lower for the metric to survive (infra/, locals
 * `lambda_logging`).
 */
export function emitMetricLine(line: string): void {
	process.stdout.write(`${line}\n`);
}
