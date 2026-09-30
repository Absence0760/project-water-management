// Print the catchment report to a PDF in headless Chromium (WP-2.15 Phase B;
// docs/architecture.md § Server-side reports).
//
// It opens the SAME route a person prints from (/projects/:id/report?run=…,
// with `&against=<project>:<run>` for an impact report), so there is one
// implementation of every chart and table:
//   1. exchange the single-use render token for a render session
//      (POST /auth/render-session): a cookie that reads this one project and
//      run (and an impact report's one comparison with its baseline), as the
//      requesting user, under RLS (reports/scope.ts);
//   2. open the report, wait for main[data-report-ready] (every section
//      loaded, every chart drawn), or stop at the page's own error message;
//   3. page.pdf({ format: 'A4', printBackground: true }). The running footer
//      on every page (the project, the run and the disclaimer's key point,
//      engine REPORT_FOOTER, and "Page X of Y") is the page's own: CSS
//      page-margin boxes (frontend report/printPage.ts), so a browser's print
//      and this PDF carry the same one. Chromium's footerTemplate would draw a
//      second on top of it.
// The whole thing has a hard timeout, and the browser is closed in `finally`
// whatever happens.
//
// Where it runs: the local worker (REPORT_RENDERER=inline) with the Chromium
// Playwright installed for e2e (`pnpm test:e2e:install`), and in production
// the renderer Lambda's container image (lambda-renderer.ts).
//
// playwright-core is imported lazily: the API never loads it.

/** The report is refused, or the page broke: a message safe to store and show (no URLs, no tokens). */
export class RenderError extends Error {
	/** Whether another attempt could succeed (a timeout, a browser crash), or not (access refused, the page's own error). */
	readonly retry: boolean;
	constructor(message: string, { retry = true }: { retry?: boolean } = {}) {
		super(message);
		this.name = 'RenderError';
		this.retry = retry;
	}
}

export interface RenderTarget {
	projectId: string;
	runId: string;
	/** An impact report's baseline (the report route's `against`); absent for the plain report. */
	against?: { projectId: string; runId: string };
	/** The raw render token (reports/tokens.ts). */
	token: string;
}

export interface RenderOptions {
	/** Where the site is served: the report route is `${siteUrl}/projects/…`. */
	siteUrl: string;
	/** Where the API answers: `${apiUrl}/auth/render-session`. */
	apiUrl: string;
	/** Hard limit for the whole render, launch to PDF. */
	timeoutMs: number;
	/** A Chromium other than Playwright's own (the Lambda image's). */
	executablePath?: string;
}

export interface RenderedPdf {
	pdf: Buffer;
	pages: number;
	ms: number;
}

/** Hard limit for one render (REPORT_RENDER_TIMEOUT_MS; the Lambda's is 120 s, so under it). */
export const DEFAULT_RENDER_TIMEOUT_MS = 90_000;

const trimSlash = (u: string) => u.replace(/\/+$/, '');

/**
 * Why POST /auth/render-session didn't give a session, and whether another
 * attempt could. Only the API's own coded refusal (`render_token_refused`,
 * reports/routes.ts: the token is used, expired, or the requester lost
 * access) is final. Anything else may pass next time and is retried with
 * backoff: in production the request goes through CloudFront and the WAF,
 * whose rate rules answer a plain 403 (infra/waf.tf) that would otherwise
 * read as a refused token, and a 429, a 5xx or a body that isn't the API's
 * JSON is the same kind of passing trouble.
 */
export function sessionRefusal(status: number, body: unknown): RenderError {
	const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
	if ((status === 400 || status === 403) && code === 'render_token_refused') {
		return new RenderError('the render token was refused (used, expired, or the requester lost access)', { retry: false });
	}
	return new RenderError(`the render session could not start (HTTP ${status})`);
}

/** Render settings from the environment (the worker's and the renderer Lambda's). */
export function renderOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RenderOptions {
	const n = Number(env.REPORT_RENDER_TIMEOUT_MS);
	return {
		siteUrl: trimSlash(env.RENDER_SITE_URL?.trim() || env.SITE_URL?.trim() || 'http://localhost:7777'),
		apiUrl: trimSlash(env.RENDER_API_URL?.trim() || 'http://localhost:3001'),
		timeoutMs: Number.isInteger(n) && n >= 5_000 && n <= 600_000 ? n : DEFAULT_RENDER_TIMEOUT_MS,
		executablePath: env.CHROMIUM_PATH?.trim() || undefined
	};
}

/** The report route's query for a target: its run, and an impact report's baseline. */
export function reportQuery(t: Pick<RenderTarget, 'runId' | 'against'>): string {
	return new URLSearchParams({ run: t.runId, ...(t.against ? { against: `${t.against.projectId}:${t.against.runId}` } : {}) }).toString();
}

/** Pages in a Chromium PDF (its page objects are never in compressed object streams). */
export function countPdfPages(pdf: Uint8Array): number {
	return Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
}

/** The page margins; the bottom one holds the page's footer. Same as the report page's own @page rule (report/printPage.ts PAGE_MARGIN). */
export const PDF_MARGIN = { top: '14mm', right: '12mm', bottom: '18mm', left: '12mm' } as const;

/** Chromium flags for AWS Lambda (no sandbox, one process, /dev/shm is tiny). */
const LAMBDA_ARGS = ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--disable-gpu'];

const originOf = (url: string) => URL.parse(url)?.origin ?? 'null';

/**
 * Chromium flags that confine the browser itself to the site and API, below
 * Playwright's routing (docs/security.md § Render tokens). Playwright routes
 * only the requests a page makes; the hops of a subresource redirect, a
 * WebSocket, a preconnect and WebRTC's UDP go out beneath it. So:
 *   - every host but the site's and the API's fails to resolve, IP literals
 *     included (no DNS lookup leaves either, so no DNS-prefetch channel);
 *   - every connection goes to a proxy that can't exist (`.invalid` never
 *     resolves), except the site's and the API's origins, which go direct
 *     (`<-loopback>` first: Chromium otherwise sends every loopback address
 *     direct, whatever the list says). That is the origin-level check: the
 *     site's own host on another port or scheme is refused too. An origin
 *     on its scheme's default port is listed without one, which Chromium
 *     matches on any port of that scheme and host;
 *   - WebRTC may use only proxied UDP, so none.
 */
export function confinementArgs(o: Pick<RenderOptions, 'siteUrl' | 'apiUrl'>): string[] {
	const urls = [o.siteUrl, o.apiUrl].map((u) => new URL(u));
	const hosts = [...new Set(urls.map((u) => u.hostname))];
	const origins = [...new Set(urls.map((u) => `${u.protocol}//${u.host}`))];
	return [
		`--host-resolver-rules=MAP * ~NOTFOUND, ${hosts.map((h) => `EXCLUDE ${h}`).join(', ')}`,
		'--proxy-server=http://egress-refused.invalid:9',
		`--proxy-bypass-list=<-loopback>;${origins.join(';')}`,
		'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
	];
}

/**
 * The browser may talk to the configured site and API and nothing else
 * (docs/security.md § Render tokens). The renderer Lambda has open egress
 * and a live render session, so a subresource, a fetch, a script navigation
 * or a redirect to another origin is aborted before it leaves, whatever the
 * page asks for (the site's CSP is a second layer, in production only).
 * Playwright doesn't route the redirect hops a browser follows itself, so a
 * navigation's redirect chain is walked first, hop by hop without following
 * any, and the navigation goes ahead only if every hop stays on the allowed
 * origins. (It then continues in the browser rather than being fulfilled
 * from that walk: a fulfilled document counts as "public" to Chromium's
 * local network checks, which would refuse the local API.) What Playwright
 * can't route (a subresource's redirect hops, WebSockets, preconnects,
 * WebRTC) is refused by the browser's own launch flags (confinementArgs),
 * and renderReportPdf prints only a page of the configured site.
 * Inline data: and blob: resources never reach the network and aren't routed.
 */
const MAX_NAVIGATION_REDIRECTS = 5;

/**
 * Routes `context` through the origin check. Resolves once the route is in
 * place, to a promise that rejects (a permanent RenderError) as soon as the
 * page's own top-level navigation is refused, so a render that tried to
 * leave fails at once instead of waiting out its timeout on an error page.
 */
async function confineToOrigins(context: import('playwright-core').BrowserContext, o: RenderOptions): Promise<{ left: Promise<never> }> {
	const allowed = new Set([originOf(o.siteUrl), originOf(o.apiUrl)]);
	let leave: (err: RenderError) => void = () => {};
	const left = new Promise<never>((_, reject) => (leave = reject));
	left.catch(() => {});
	await context.route('**/*', async (route) => {
		const request = route.request();
		const refuse = () => {
			let topLevel = false;
			try {
				topLevel = request.isNavigationRequest() && request.frame().parentFrame() === null;
			} catch {
				// A request with no frame (a service worker's): not the page's navigation.
			}
			if (topLevel) leave(new RenderError('the report page tried to leave the site', { retry: false }));
			return route.abort('blockedbyclient');
		};
		if (!allowed.has(originOf(request.url()))) return refuse();
		if (!request.isNavigationRequest()) return route.continue();
		let url = request.url();
		for (let hop = 0; ; hop++) {
			const response = await route.fetch({ url, maxRedirects: 0 }).catch(() => null);
			if (!response) return route.abort('failed');
			const status = response.status();
			const location = status >= 300 && status <= 399 ? response.headers()['location'] : undefined;
			await response.dispose();
			if (location === undefined) return route.continue();
			const next = URL.parse(location, url)?.href;
			if (!next || !allowed.has(originOf(next)) || hop === MAX_NAVIGATION_REDIRECTS) return refuse();
			url = next;
		}
	});
	return { left };
}

export async function renderReportPdf(t: RenderTarget, o: RenderOptions): Promise<RenderedPdf> {
	const started = Date.now();
	const { chromium } = await import('playwright-core');
	let browser: import('playwright-core').Browser | undefined;
	let closed = false;

	const work = async (): Promise<RenderedPdf> => {
		browser = await chromium.launch({
			headless: true,
			executablePath: o.executablePath,
			args: [...(process.env.AWS_LAMBDA_FUNCTION_NAME ? LAMBDA_ARGS : []), ...confinementArgs(o)]
		});
		// If the timeout fired while Chromium was starting, close it now.
		if (closed) await browser.close();
		// Light, like the print stylesheet forces; the UTC clock the tests pin too.
		// No service workers: the report needs none, and a worker's requests outlive the page's routing.
		const context = await browser.newContext({ colorScheme: 'light', locale: 'en-ZA', timezoneId: 'UTC', viewport: { width: 1200, height: 1600 }, serviceWorkers: 'block' });
		const { left } = await confineToOrigins(context, o);
		const res = await context.request.post(`${o.apiUrl}/auth/render-session`, {
			data: { token: t.token },
			headers: { origin: o.siteUrl },
			failOnStatusCode: false
		});
		if (!res.ok()) {
			// A WAF block's body is HTML, not the API's JSON: no code, so retried.
			const body: unknown = await res.json().catch(() => null);
			throw sessionRefusal(res.status(), body);
		}
		const page = await context.newPage();
		const url = `${o.siteUrl}/projects/${encodeURIComponent(t.projectId)}/report?${reportQuery(t)}`;
		await Promise.race([page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs }), left]);
		// Ready, or one of the page's own "can't show this" messages.
		const settled = page.locator('main[data-report-ready="true"], main > [role="alert"], main > .alert-info');
		await Promise.race([settled.first().waitFor({ state: 'attached', timeout: Math.max(1_000, o.timeoutMs - (Date.now() - started)) }), left]);
		if ((await page.locator('main[data-report-ready="true"]').count()) === 0) {
			const said = ((await settled.first().textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
			// No run, no project, no access: another attempt shows the same. Anything else (the API unreachable) may pass.
			const permanent = (await page.locator('main > .alert-info').count()) > 0 || /don.t have access/.test(said);
			throw new RenderError(`the report page did not load: ${said || 'no message'}`, { retry: !permanent });
		}
		// Whatever happened on the way, print only a page of the configured site.
		if (originOf(page.url()) !== originOf(o.siteUrl)) throw new RenderError('the report page left the site', { retry: false });
		// The footer is the page's (its @page margin boxes), as in a browser's print.
		const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: PDF_MARGIN });
		return { pdf, pages: countPdfPages(pdf), ms: Date.now() - started };
	};

	let timer: NodeJS.Timeout | undefined;
	const running = work();
	// Whichever loses the race below must not surface as an unhandled rejection.
	running.catch(() => {});
	try {
		return await Promise.race([
			running,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new RenderError(`the render took longer than ${Math.round(o.timeoutMs / 1000)} s`)), o.timeoutMs);
			})
		]);
	} catch (err) {
		if (err instanceof RenderError) throw err;
		// Playwright's own errors carry URLs and call logs: keep only what failed.
		const name = (err as Error).name === 'TimeoutError' ? 'timed out waiting for the report page' : 'the browser failed';
		console.error('report render failed:', (err as Error).message);
		throw new RenderError(`the report could not be rendered (${name})`);
	} finally {
		clearTimeout(timer);
		closed = true;
		await browser?.close().catch(() => {});
	}
}
