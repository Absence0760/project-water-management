// The sign-in CAPTCHA (issue #126, infra/waf.tf SignInCaptchaPerIP). Past a
// per-IP rate of sign-ins, AWS WAF answers POST /api/auth/login with 405 and
// `x-amzn-waf-action: captcha` (the API client turns that into an ApiError
// with code CAPTCHA_REQUIRED). The sign-in page then renders the puzzle with
// AWS WAF's CAPTCHA JavaScript API and sends the sign-in again with the
// token it gives (api.auth.login's wafToken).
//
// Dormant unless configured: the script URL and API key are baked in at
// build time (deploy-frontend.yml, from Terraform's outputs) and empty
// locally and in tests, so nothing here runs without a WAF in front. The
// script loads only when a sign-in actually got the CAPTCHA answer, never on
// page load, and the site's CSP allows exactly its origin (infra/
// security_headers.tf, frontend/svelte.config.js).

/** What `renderCaptcha` takes (AWS WAF CAPTCHA JavaScript API specification). */
export type CaptchaRenderOptions = {
	apiKey: string;
	onSuccess: (wafToken: string) => void;
	onError?: (error: { kind?: string; statusCode?: number }) => void;
	onLoad?: () => void;
	onPuzzleTimeout?: () => void;
	defaultLocale?: string;
	disableLanguageSelector?: boolean;
	dynamicWidth?: boolean;
	skipTitle?: boolean;
};

export type AwsWafCaptchaApi = { renderCaptcha: (container: Element, options: CaptchaRenderOptions) => void };

export type CaptchaConfig = { scriptUrl: string; apiKey: string };

/** The one script this module will load: AWS's CAPTCHA SDK, as the site's CSP allows it. */
export const CAPTCHA_SCRIPT = /^https:\/\/[a-z0-9]+\.[a-z0-9-]+\.captcha-sdk\.awswaf\.com\/[a-z0-9]+\/jsapi\.js$/;

/**
 * The build's CAPTCHA settings, or null when either is missing (local dev,
 * tests, or a deploy before the integration URL was set), in which case the
 * page says to wait instead. The URL must be the CAPTCHA SDK's jsapi.js on
 * https, the only script origin the CSP will allow.
 */
export function captchaConfig(scriptUrl: string | undefined, apiKey: string | undefined): CaptchaConfig | null {
	const url = scriptUrl?.trim() ?? '';
	const key = apiKey?.trim() ?? '';
	if (!url || !key) return null;
	if (!CAPTCHA_SCRIPT.test(url)) return null;
	return { scriptUrl: url, apiKey: key };
}

let loading: Promise<AwsWafCaptchaApi> | null = null;

/**
 * Load the CAPTCHA SDK once (one <script> for the page's life) and resolve
 * with `window.AwsWafCaptcha`. A failed load rejects and lets the next call
 * try again. Refuses any URL but the SDK's (CAPTCHA_SCRIPT).
 */
export function loadCaptchaSdk(scriptUrl: string, doc: Document = document): Promise<AwsWafCaptchaApi> {
	if (!CAPTCHA_SCRIPT.test(scriptUrl)) return Promise.reject(new Error('not the CAPTCHA SDK’s script URL'));
	const win = doc.defaultView as (Window & { AwsWafCaptcha?: AwsWafCaptchaApi }) | null;
	if (win?.AwsWafCaptcha) return Promise.resolve(win.AwsWafCaptcha);
	loading ??= new Promise<AwsWafCaptchaApi>((resolve, reject) => {
		const script = doc.createElement('script');
		script.src = scriptUrl;
		script.async = true;
		script.dataset.wafCaptcha = '';
		script.onload = () => {
			const sdk = (doc.defaultView as (Window & { AwsWafCaptcha?: AwsWafCaptchaApi }) | null)?.AwsWafCaptcha;
			if (sdk) resolve(sdk);
			else reject(new Error('the CAPTCHA script loaded without AwsWafCaptcha'));
		};
		script.onerror = () => reject(new Error('the CAPTCHA script did not load'));
		doc.head.appendChild(script);
	}).catch((err: unknown) => {
		loading = null;
		doc.querySelectorAll('script[data-waf-captcha]').forEach((s) => s.remove());
		throw err;
	});
	return loading;
}

/** Test hook: forget a loaded or failed script. */
export function resetCaptchaSdkForTests(): void {
	loading = null;
}
