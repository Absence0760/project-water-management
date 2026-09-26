// Print the catchment report to a PDF in headless Chromium (WP-2.15 Phase B;
// docs/architecture.md § Server-side reports).
//
// It opens the SAME route a person prints from (/projects/:id/report?run=…),
// so there is one implementation of every chart and table:
//   1. exchange the single-use render token for a render session
//      (POST /auth/render-session): a cookie that reads this one project and
//      run, as the requesting user, under RLS (reports/scope.ts);
//   2. open the report, wait for main[data-report-ready] (every section
//      loaded, every chart drawn), or stop at the page's own error message;
//   3. page.pdf({ format: 'A4', printBackground: true }).
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

/** Pages in a Chromium PDF (its page objects are never in compressed object streams). */
export function countPdfPages(pdf: Uint8Array): number {
	return Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g)?.length ?? 0;
}

/** Chromium flags for AWS Lambda (no sandbox, one process, /dev/shm is tiny). */
const LAMBDA_ARGS = ['--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage', '--disable-gpu'];

export async function renderReportPdf(t: RenderTarget, o: RenderOptions): Promise<RenderedPdf> {
	const started = Date.now();
	const { chromium } = await import('playwright-core');
	let browser: import('playwright-core').Browser | undefined;
	let closed = false;

	const work = async (): Promise<RenderedPdf> => {
		browser = await chromium.launch({
			headless: true,
			executablePath: o.executablePath,
			args: process.env.AWS_LAMBDA_FUNCTION_NAME ? LAMBDA_ARGS : []
		});
		// If the timeout fired while Chromium was starting, close it now.
		if (closed) await browser.close();
		// Light, like the print stylesheet forces; the UTC clock the tests pin too.
		const context = await browser.newContext({ colorScheme: 'light', locale: 'en-ZA', timezoneId: 'UTC', viewport: { width: 1200, height: 1600 } });
		const res = await context.request.post(`${o.apiUrl}/auth/render-session`, {
			data: { token: t.token },
			headers: { origin: o.siteUrl },
			failOnStatusCode: false
		});
		if (!res.ok()) {
			const refused = res.status() === 400 || res.status() === 403;
			throw new RenderError(
				refused ? 'the render token was refused (used, expired, or the requester lost access)' : `the render session could not start (HTTP ${res.status()})`,
				{ retry: !refused }
			);
		}
		const page = await context.newPage();
		const url = `${o.siteUrl}/projects/${encodeURIComponent(t.projectId)}/report?run=${encodeURIComponent(t.runId)}`;
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs });
		// Ready, or one of the page's own "can't show this" messages.
		const settled = page.locator('main[data-report-ready="true"], main > [role="alert"], main > .alert-info');
		await settled.first().waitFor({ state: 'attached', timeout: Math.max(1_000, o.timeoutMs - (Date.now() - started)) });
		if ((await page.locator('main[data-report-ready="true"]').count()) === 0) {
			const said = ((await settled.first().textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
			// No run, no project, no access: another attempt shows the same. Anything else (the API unreachable) may pass.
			const permanent = (await page.locator('main > .alert-info').count()) > 0 || /don.t have access/.test(said);
			throw new RenderError(`the report page did not load: ${said || 'no message'}`, { retry: !permanent });
		}
		const pdf = await page.pdf({ format: 'A4', printBackground: true });
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
