// Alert emails end to end through Mailpit (WP-2.13, the roadmap's e2e;
// docs/ui.md § Alerts, docs/architecture.md § Alert emails): a synthetic
// ("fixture") rain forecast, run and published, takes a farm's dam below the
// WUA's alert level; the background worker (support/jobs.ts, one tick)
// evaluates the rule and mails the farmer through Mailpit; the email names
// their farm and the forecast, carries the RFC 8058 one-click headers, and
// its "Stop these emails" link works signed out; after that, the next
// crossing mails the WUA again but not the farmer.
//
// Needs Mailpit (`pnpm dev:mail:up`; CI starts it). Locally, without it the
// spec is skipped and says why; in CI it never skips (server-report.spec.ts's
// rule).
import { putModel, putSeries, seedRunnableProject } from '../support/api.ts';
import { mail as mailFn, words as siteWords } from '../support/lang.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { API_URL } from '../support/env.ts';
import { expect, test } from '../support/fixtures.ts';
import { runJobsTick } from '../support/jobs.ts';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8026';
const reachable = (url: string) =>
	fetch(url, { signal: AbortSignal.timeout(1500) })
		.then((r) => r.ok)
		.catch(() => false);

test.beforeAll(async () => {
	test.skip(!(await reachable(`${MAILPIT}/api/v1/info`)) && !process.env.CI, 'needs Mailpit: pnpm dev:mail:up');
});

// One at a time: each test runs the e2e database's worker tick.
test.describe.configure({ mode: 'default' });

// seedRunnableProject records rain 2021-10-01 … 2022-01-28 (120 days); the
// fixture forecast is the 14 dry days after it.
const FORECAST_FROM = '2022-01-29';

interface MailpitMessage {
	ID: string;
	Subject: string;
}

/** Every Mailpit message to `to`, newest first. */
async function mailsTo(to: string): Promise<MailpitMessage[]> {
	const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`);
	expect(res.ok, 'Mailpit search').toBe(true);
	return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

async function message(id: string): Promise<{ subject: string; text: string; html: string; headers: Record<string, string[]> }> {
	const m = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
	const headers = await (await fetch(`${MAILPIT}/api/v1/message/${id}/headers`)).json();
	return { subject: m.Subject, text: m.Text, html: m.HTML, headers };
}

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = await siteWords('af');
const mailWords = await mailFn('af');

/**
 * The words the farmer's alert email and the unsubscribe page are checked
 * for, per language. The Afrikaans comes from the catalogues
 * (support/lang.ts); the farmer's phone is in that language too (`browser`),
 * so the signed-out unsubscribe page opens in it.
 */
const LANGUAGES: {
	locale: 'en' | 'af' | null;
	lang: string;
	browser: string;
	subject: (farm: string, project: string) => string;
	forecast: RegExp;
	stop: string;
	stopped: (project: string) => string;
}[] = [
	{
		locale: null,
		lang: 'en',
		browser: 'en-ZA',
		subject: (farm, project) => `Dam low on ${farm} — ${project}`,
		forecast: /On the rain forecast of .+, the model expects the dam on Lower farm to fall to about \d+\s% of capacity around .+, below the alert level of \d+\s%\. Forecasts change\./,
		stop: 'Stop these emails',
		stopped: (project) => `You won’t get dam level emails for ${project} any more.`
	},
	{
		locale: 'af',
		lang: 'af',
		browser: 'af-ZA',
		subject: (farm, project) => fill(mailWords('mail.alert.subject'), { what: fill(mailWords('mail.alert.dam.what'), { farm }), project }),
		forecast: new RegExp(escape(mailWords('mail.alert.dam.forecast')).replace(/\\\{(\w+)\\\}/g, (_, name: string) => (name === 'farm' ? 'Lower farm' : '.+'))),
		stop: words('Stop these emails'),
		stopped: (project) => fill(words('You won’t get {kind} emails for {project} any more.'), { kind: words('dam level'), project })
	}
];

for (const L of LANGUAGES) {
	test(`a fixture forecast takes a dam below its alert level: the worker mails the farmer through Mailpit (${L.lang}), and the email's unsubscribe link works`, async ({
		page,
		owner,
		signIn,
		browser
	}) => {
		const projectName = `Mailpit alerts ${L.lang}`;
		const project = await seedRunnableProject(page.request, projectName);
		// No transfer rule: the sample network's Upper → Lower rule (Nov–Feb, while Upper's dam is above 20 %)
		// keeps Lower's dam full through a dry fortnight, so nothing would cross an alert level. The forecast
		// only drew it down before engine 1.27.0 because the tail started from a history the forecast had
		// already drained (engine-audit.md K1).
		await putModel(page.request, project.id, { ...project.model, transfers: [] });
		const lower = project.model.nodes.find((n) => n.name === 'Lower farm')!.id as string;
		const farmer = await signIn('Mailpit farmer');
		expect((await page.request.post(`${API_URL}/projects/${project.id}/farmers`, { data: { email: farmer.user.email, nodeIds: [lower] } })).status()).toBe(201);
		if (L.locale) expect((await farmer.page.request.patch(`${API_URL}/auth/me`, { data: { locale: L.locale } })).status()).toBe(200);

		// The fixture forecast: 14 dry days past the record, run as a forecast and published.
		await putSeries(page.request, project.id, { kind: 'rain_forecast_mm', unit: 'mm', startDate: FORECAST_FROM, values: Array.from({ length: 14 }, () => 0) });
		const run = await page.request.post(`${API_URL}/projects/${project.id}/runs`, { data: { label: 'Next fortnight', forecast: true } });
		expect(run.status(), await run.text()).toBe(201);
		const runId = ((await run.json()) as { run: { id: string } }).run.id;
		expect((await page.request.post(`${API_URL}/projects/${project.id}/publication`, { data: { runId } })).status()).toBe(201);

		// The WUA's alert level goes between the dam today and the forecast's
		// lowest: it is the forecast that crosses it.
		const view = await page.request.get(`${API_URL}/projects/${project.id}/farm/${lower}`);
		expect(view.status(), await view.text()).toBe(200);
		const { farm } = (await view.json()) as { farm: { dam: { pct: number } | null; forecast: { minDamPct: number | null } | null } };
		const today = farm.dam!.pct;
		const lowest = farm.forecast!.minDamPct!;
		expect(lowest, 'the dry forecast draws the dam down').toBeLessThan(today - 0.02);
		const level = Math.round(((today + lowest) / 2) * 1000) / 1000;
		const setLevel = async (threshold: number, enabled = true) => {
			const res = await page.request.put(`${API_URL}/projects/${project.id}/alert-rules`, { data: { rules: [{ kind: 'dam_below', nodeId: lower, threshold, enabled }] } });
			expect(res.status(), await res.text()).toBe(200);
		};
		expect(await mailsTo(farmer.user.email)).toHaveLength(0);
		await setLevel(level);

		// One tick of the worker: the alert check the rule queued, then the send.
		await runJobsTick({ schedule: false });

		const mails = await mailsTo(farmer.user.email);
		expect(mails, 'one alert email for the farmer in Mailpit').toHaveLength(1);
		const mail = await message(mails[0]!.ID);
		expect(mail.subject).toBe(L.subject('Lower farm', projectName));
		expect(mail.text).toMatch(L.forecast);
		expect(mail.text).not.toContain('Upper farm');
		expect(mail.html).toContain(`<html lang="${L.lang}">`);
		// The one-click headers (RFC 8058), at the API, with the same token as the link.
		const token = /\/alerts\/unsubscribe#t=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1];
		expect(token, 'the Stop these emails link').toBeTruthy();
		expect(mail.headers['List-Unsubscribe']).toEqual([`<${API_URL}/alerts/unsubscribe?token=${token}>`]);
		expect(mail.headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click']);
		// The WUA gets it too (the owner, by default), in the owner's own language (none set: English).
		expect((await mailsTo(owner.email)).map((m) => m.Subject)).toContain(LANGUAGES[0]!.subject('Lower farm', projectName));

		// The email's link, opened signed out (a phone, a mail app's browser).
		const link = /(http\S+\/alerts\/unsubscribe#t=[A-Za-z0-9_-]{43})/.exec(mail.text)![1]!;
		const context = await browser.newContext({ viewport: { width: 360, height: 740 }, locale: L.browser });
		const p = await context.newPage();
		try {
			await p.goto(link);
			await expect(p.locator('[data-state="ask"]')).toBeVisible();
			await p.getByRole('button', { name: L.stop }).click();
			await expect(p.locator('html')).toHaveAttribute('lang', L.lang);
			await expect(p.getByRole('status')).toHaveText(L.stopped(projectName));
			await expectNoViolations(p);
		} finally {
			await context.close();
		}

		// The next crossing: the WUA switches the alert off (it clears) and on
		// again (a new event, as a recovery and a fall would make). The owner is
		// mailed again; the farmer, who stopped these emails, isn't.
		await setLevel(level, false);
		await runJobsTick({ schedule: false });
		const ownerBefore = (await mailsTo(owner.email)).length;
		await setLevel(level);
		await runJobsTick({ schedule: false });
		expect(await mailsTo(owner.email)).toHaveLength(ownerBefore + 1);
		expect(await mailsTo(farmer.user.email)).toHaveLength(1);
	});
}
