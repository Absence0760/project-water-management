// Every email the app builds, fed hostile text in every user-controlled
// field, and sent through each real transport (nodemailer and the SES SDK
// mocked at the module): no markup survives into the HTML, no line break
// reaches a header, and a mail goes to exactly one recipient
// (docs/security.md § Email content).
//
// The template list is the modules' own exports: a new `…Mail` builder in
// mail/templates.ts or mail/alerts.ts fails the inventory test until it has
// a hostile call here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as alertTemplates from './alerts.js';
import * as templates from './templates.js';
import type { AlertFacts } from './alerts.js';
import type { Mail, MailKind } from './transport.js';

const smtpSent: Record<string, unknown>[] = [];
vi.mock('nodemailer', () => ({
	createTransport: () => ({
		sendMail: async (m: Record<string, unknown>) => {
			smtpSent.push(m);
		}
	})
}));
const sesSent: { Content: { Simple: { Subject: { Data: string }; Headers?: { Name: string; Value: string }[] } }; Destination: { ToAddresses: string[] } }[] = [];
vi.mock('@aws-sdk/client-sesv2', () => ({
	SESv2Client: class {
		send(cmd: { input: (typeof sesSent)[number] }) {
			sesSent.push(cmd.input);
			return Promise.resolve({ MessageId: 'test' });
		}
	},
	SendEmailCommand: class {
		constructor(readonly input: unknown) {}
	}
}));
const { outbox, sendMail } = await import('./transport.js');

afterEach(() => {
	vi.unstubAllEnvs();
	outbox.length = 0;
	smtpSent.length = 0;
	sesSent.length = 0;
});

/** Markup, both quotes, an ampersand, and a header injection, in one value. */
const EVIL = `Eve\r\nBcc: evil@example.com\n<script>alert(1)</script><img src=x onerror=alert(2)> "q" 'a' &amp;`;
const TO = 'ann@example.com';
const URL_ = 'http://localhost:7777/reset-password?token=abc';
const unsub = { pageUrl: 'http://localhost:7777/alerts/unsubscribe#t=T', oneClickUrl: 'http://localhost:3001/alerts/unsubscribe?token=T' };
const project = { id: 'p1', name: EVIL };

const alertKinds: AlertFacts[] = [
	{ kind: 'dam_below', farm: EVIL, pct: 0.2, threshold: 0.3, source: 'forecast', date: '2026-09-20', madeOn: '2026-09-19' },
	{ kind: 'ewr_forecast_fail', days: 3, of: 16, from: '2026-09-20', to: '2026-10-05', madeOn: '2026-09-19', threshold: 0.5 },
	{ kind: 'data_stale', threshold: 3, feeds: [{ label: EVIL, newest: '2026-09-01', overdue: 10 }] },
	{ kind: 'feed_failing', threshold: 3, feeds: [{ label: EVIL, failures: 5 }] },
	{ kind: 'job_dead', count: 2 },
	{ kind: 'restriction_published', level: 'restricted', pct: 20, notice: EVIL, publishedAt: '2026-09-26T08:00:00Z', lifted: false }
];

/** One hostile call per template (and locale); every free-text argument is EVIL. */
const builders: Record<string, () => Mail[]> = {
	verifyEmailMail: () => templates.LOCALES.map((l) => templates.verifyEmailMail(TO, URL_, l)),
	resetPasswordMail: () => templates.LOCALES.map((l) => templates.resetPasswordMail(TO, URL_, l)),
	accountExistsMail: () => templates.LOCALES.map((l) => templates.accountExistsMail(TO, URL_, l)),
	inviteMail: () =>
		(['sign-up', 'confirm'] as const).flatMap((mode) =>
			(['project', 'team'] as const).map((kind) => templates.inviteMail(TO, URL_, EVIL, { kind, name: EVIL, role: 'editor' }, mode))
		),
	farmerInviteMail: () =>
		(['sign-up', 'confirm'] as const).flatMap((mode) =>
			templates.LOCALES.map((l) => templates.farmerInviteMail(TO, URL_, EVIL, { catchment: EVIL, farms: [EVIL, EVIL] }, mode, l))
		),
	reportReadyMail: () => [true, false].map((scheduled) => templates.reportReadyMail(TO, URL_, { projectName: EVIL, runName: EVIL, pages: 3, requestedBy: EVIL, scheduled })),
	alertMail: () =>
		[null, 'af'].flatMap((locale) =>
			[true, false].flatMap((farmer) => alertKinds.map((f) => alertTemplates.alertMail({ email: TO, locale, farmer }, project, f, unsub)))
		),
	digestMail: () => [null, 'af'].map((locale) => alertTemplates.digestMail({ email: TO, locale, farmer: false }, project, alertKinds, unsub, 20, 4)),
	packNoticeMail: () =>
		(['issued', 'withdrawn'] as const).flatMap((event) =>
			(['editor', 'applicant'] as const).flatMap((as) =>
				templates.LOCALES.map((l) =>
					templates.packNoticeMail(
						TO,
						{ event, as, projectId: 'p1', packId: 'k1', projectName: EVIL, scenarioId: 's1', scenarioName: EVIL, version: 2, supersedesVersion: 1, shortCode: 'ab12-cd34-ef56', reason: EVIL },
						l
					)
				)
			)
		),
	packSentMail: () =>
		[EVIL, null].flatMap((authority) =>
			[EVIL, null].map((note) =>
				templates.packSentMail(TO, { projectId: 'p1', packId: 'k1', projectName: EVIL, title: EVIL, version: 2, shortCode: 'ab12-cd34-ef56', sentBy: EVIL, authority, note })
			)
		),
	accountDeletedMail: () =>
		templates.LOCALES.map((l) => templates.accountDeletedMail(TO, { projects: [EVIL, EVIL], teams: [EVIL] }, l)),
	erratumNoticeMail: () =>
		(['run', 'fit'] as const).flatMap((keyedOn) =>
			['1.2.0', null].map((fixedIn) =>
				templates.erratumNoticeMail(TO, {
					projectId: 'p1',
					projectName: EVIL,
					erratum: { id: 'ER-1', keyedOn, firstAffected: '1.0.0', fixedIn, severity: 'High', appliesWhen: EVIL, summary: EVIL },
					runCount: 2
				})
			)
		),
	// The licence record's review and closing notices (161, licence/record.ts), the owners' and the operator's copy.
	licenceRecordMail: () =>
		(['review', 'closes'] as const).flatMap((event) =>
			[false, true].map((operator) => templates.licenceRecordMail(TO, { projectId: 'p1', projectName: EVIL, event, dueOn: '2031-10-01', operator }))
		)
};

const exportedBuilders = [...Object.entries(templates), ...Object.entries(alertTemplates)]
	.filter(([name, v]) => typeof v === 'function' && /Mail$/.test(name))
	.map(([name]) => name)
	.sort();


describe('every email template, against hostile names', () => {
	it('covers every exported …Mail builder (a new template joins this sweep)', () => {
		expect(exportedBuilders).toEqual(Object.keys(builders).sort());
	});

	it('every template says its kind (the mail_send_failed log line names it; never the subject)', () => {
		const expected: Record<string, MailKind> = {
			verifyEmailMail: 'verify',
			resetPasswordMail: 'reset',
			accountExistsMail: 'account_exists',
			inviteMail: 'invite',
			farmerInviteMail: 'farmer_invite',
			reportReadyMail: 'report_ready',
			alertMail: 'alert',
			digestMail: 'alert_digest',
			packNoticeMail: 'pack_notice',
			packSentMail: 'pack_sent',
			accountDeletedMail: 'account_deleted',
			erratumNoticeMail: 'erratum_notice',
			licenceRecordMail: 'licence_record'
		};
		expect(Object.keys(expected).sort()).toEqual(Object.keys(builders).sort());
		for (const [name, build] of Object.entries(builders)) for (const m of build()) expect(m.kind, name).toBe(expected[name]);
	});

	it.each(Object.keys(builders))('%s: user text is escaped in the HTML, never markup, and reaches the mail (positive control)', (name) => {
		const mails = builders[name]!();
		expect(mails.length).toBeGreaterThan(0);
		for (const m of mails) {
			expect(m.html).not.toMatch(/<script|<img/i);
			// Nothing of EVIL survives unescaped: its quotes and brackets come out as entities.
			expect(m.html).not.toContain(`"q"`);
			expect(m.html).not.toContain(`'a'`);
			expect(m.html).not.toContain('&amp;"');
			// The only tags are the frame's own.
			const tags = new Set([...m.html.matchAll(/<\/?([a-z0-9]+)/gi)].map((t) => t[1]!.toLowerCase()));
			for (const t of tags) expect(['html', 'head', 'meta', 'title', 'body', 'main', 'h1', 'p', 'a', 'br', 'span']).toContain(t);
			// The text alternative keeps it readable, and it's plain text (no HTML part leaks into it).
			if (name !== 'verifyEmailMail' && name !== 'resetPasswordMail' && name !== 'accountExistsMail') {
				expect(m.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
				expect(m.text).toContain('<script>alert(1)</script>');
			}
		}
	});
});

describe('headers and recipients, through each transport', () => {
	const every = () => Object.values(builders).flatMap((b) => b());

	it('SMTP (Mailpit locally): the subject and every header value is one line; one recipient', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		const mails = every();
		for (const m of mails) await sendMail(m);
		expect(smtpSent).toHaveLength(mails.length);
		// Positive control: the hostile name did reach a subject.
		expect(smtpSent.some((s) => String(s.subject).includes('Bcc: evil@example.com'))).toBe(true);
		for (const s of smtpSent) {
			expect(s.subject).not.toMatch(/[\r\n]/);
			expect(s.to).toBe(TO);
			for (const v of Object.values((s.headers ?? {}) as Record<string, string>)) expect(v).not.toMatch(/[\r\n]/);
		}
	});

	it('SES (production): the subject and every header value is one line; one recipient', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'ses');
		const mails = every();
		for (const m of mails) await sendMail(m);
		expect(sesSent).toHaveLength(mails.length);
		expect(sesSent.some((s) => s.Content.Simple.Subject.Data.includes('Bcc: evil@example.com'))).toBe(true);
		for (const s of sesSent) {
			expect(s.Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
			expect(s.Destination.ToAddresses).toEqual([TO]);
			for (const h of s.Content.Simple.Headers ?? []) expect(h.Value).not.toMatch(/[\r\n]/);
		}
	});

	it('refuses a recipient that is not one bare address, before any transport (nodemailer reads "a Bcc: b" as a group to b)', async () => {
		vi.stubEnv('MAIL_TRANSPORT', 'smtp');
		const m = templates.resetPasswordMail(TO, URL_);
		for (const to of [
			`${TO}\r\nBcc: evil@example.com`,
			`${TO} Bcc: evil@example.com`,
			`${TO}, evil@example.com`,
			`${TO};evil@example.com`,
			`Ann <evil@example.com>`,
			`team: evil@example.com;`,
			'not-an-address'
		]) {
			await expect(sendMail({ ...m, to })).rejects.toThrow('not a single email address');
		}
		expect(smtpSent).toEqual([]);
		// Positive control: a plain address (and one with a stray trailing newline, trimmed) goes.
		await sendMail({ ...m, to: TO });
		await sendMail({ ...m, to: `${TO}\n` });
		expect(smtpSent.map((s) => s.to)).toEqual([TO, TO]);
	});
});
