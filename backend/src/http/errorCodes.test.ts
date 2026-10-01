// Every error the routes behind the translated pages can send carries a code
// (docs/api.md § Errors), or is listed below with why its status says enough.
// The translated pages (sign-in, account, alert, farm and /share) word an
// error from its code; an uncoded one gets only a generic line for its
// status. So a new `new ApiError(…)` in these files fails here until it gets
// `ApiError.coded(…)` (and its words in the frontend's `CODES`,
// frontend/src/lib/i18n/apiError.ts) or a deliberate entry.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The route files the translated pages call. */
const FILES = [
	'auth/routes.ts',
	'auth/email-routes.ts',
	'auth/export.ts',
	'auth/middleware.ts',
	'auth/mfa-routes.ts',
	'auth/stepUp.ts',
	'notes/routes.ts',
	'alerts/routes.ts',
	'farms/view.ts',
	'share/routes.ts'
];

/** Uncoded errors on purpose: `file: message start → why the status's generic line is enough`. */
const UNCODED: Record<string, string> = {
	'auth/middleware.ts: this session can only read one report': 'a report-render session (the PDF renderer), never a person',
	'farms/view.ts: not found': 'the farm page words 403/404 itself ("no longer yours", farm/load.ts classify)',
	'farms/view.ts: not published yet': 'the farm page checks the index first and shows its no-publication state',
	'farms/view.ts: the window is outside the published figures': 'the CSV download link sends no window; no farm page calls the series route yet',
	'farms/view.ts: at most ${FARM_SERIES_MAX_DAYS} days at a time': 'the series route: no farm page calls it yet, and a caller that does picks its own window',
	'farms/view.ts: export too large': 'the CSV download link sends no window; a 413 is the generic "too large"',
	'alerts/routes.ts: applicants get no alerts': 'the alert page lists no project an applicant has',
	'alerts/routes.ts: “all” is on (immediate) or off': 'the alert page never sends it',
	'alerts/routes.ts: your role doesn’t get': 'the alert page offers only the kinds the role gets',
	'alerts/routes.ts: only a farmer’s dam alerts are per farm': 'the alert page never sends it',
	'alerts/routes.ts: not found': 'a farm no longer linked: the generic "isn’t there any more"',
	'share/routes.ts: only a submitted or decided scenario': 'the Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: only the assessors or the applicant': 'the Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: only an application can be shared': 'the Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: only an issued pack can be shared': 'the pack page’s Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: requires owner role': 'revoking a link: the workspace (English); the /share page never revokes one',
	'share/routes.ts: only the editors, or the applicant for their own application, can share this pack':
		'the applicant’s pack view’s Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: only the applicant who made the application can share its pack': 'the applicant’s pack view’s Share dialog, in the workspace (English); the /share page never makes a link',
	'share/routes.ts: requires editor role, or the applicant for their own application': 'listing a pack’s links: the Share dialog, in the workspace (English); the /share page never lists them',
	'share/routes.ts: not found': 'the /share page words a 404 itself (its dead-link state, share/load.ts); the owner-side 404s are the workspace’s',
	'alerts/routes.ts: no token': 'the unsubscribe page shows its own dead-link state for any 400/404'
};

const src = (rel: string) => {
	try {
		return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
	} catch {
		return null;
	}
};

describe('errors on the translated pages’ routes', () => {
	it('carry a code, or are listed with a reason', () => {
		const found: string[] = [];
		for (const f of FILES) {
			const code = src(f);
			if (code === null) {
				found.push(`${f}: (file missing: update FILES)`);
				continue;
			}
			for (const m of code.matchAll(/new ApiError\(\s*\d{3},\s*[`'"]([^`'"]*)/g)) found.push(`${f}: ${m[1]}`);
		}
		const unlisted = found.filter((e) => !Object.keys(UNCODED).some((k) => e.startsWith(k)));
		expect(unlisted, 'use ApiError.coded(…) with a new ERROR_CODES entry, or list it in UNCODED with why').toEqual([]);
	});

	it('lists nothing that no longer exists', () => {
		const all = FILES.map((f) => [f, src(f) ?? ''] as const);
		const stale = Object.keys(UNCODED).filter((k) => {
			const [file, msg] = k.split(': ');
			const code = all.find(([f]) => f === file)?.[1] ?? '';
			return !code.includes(msg!);
		});
		expect(stale).toEqual([]);
	});
});
