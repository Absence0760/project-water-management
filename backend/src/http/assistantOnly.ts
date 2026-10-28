// The assistant Lambda's path filter (lambda-assistant.ts, issue #610): the
// API's app, answering 404 for every path but the assistant's. In its own
// module so a test can load it without the entry point's cold-start checks.
/** The assistant's routes (assistant/routes.ts): the status, and everything under it. */
const ASSISTANT_PATH = /^\/projects\/[^/]+\/assistant(?:\/[^/]+)*\/?$/;

/** Whether this function serves `pathname` (as `new URL(request.url).pathname` gives it). */
export function isAssistantPath(pathname: string): boolean {
	return ASSISTANT_PATH.test(pathname);
}

interface FetchApp {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
}

/** `app`, answering 404 for every path but the assistant's. */
export function assistantOnly(app: FetchApp): FetchApp {
	return {
		fetch(request, env) {
			if (!isAssistantPath(new URL(request.url).pathname)) {
				return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
			}
			return app.fetch(request, env);
		}
	};
}
