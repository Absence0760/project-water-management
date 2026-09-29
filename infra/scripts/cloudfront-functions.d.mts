// Types for cloudfront-functions.mjs, for the TypeScript that imports it (e2e/support/site.ts).

/** A CloudFront Functions viewer-request event, as much of it as the functions here read. */
export interface ViewerRequestEvent {
	request: { method: string; uri: string; querystring: Record<string, unknown>; headers: Record<string, { value: string }>; cookies: Record<string, unknown> };
	viewer: { ip: string };
}

/** A response the function answers with itself, instead of forwarding the request. */
export interface FunctionResponse {
	statusCode: number;
	statusDescription?: string;
	headers?: Record<string, { value: string }>;
	body?: { encoding: 'text' | 'base64'; data: string };
}

export function functionCode(name: string, source?: string): string;
export function loadFunction(
	name: string,
	vars?: string[]
): { handler: (event: ViewerRequestEvent) => ViewerRequestEvent['request'] | FunctionResponse; [name: string]: unknown };
