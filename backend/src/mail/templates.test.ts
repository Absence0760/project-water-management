import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, farmerInviteMail, inviteMail, listText, reportReadyMail, resetPasswordMail, siteLink, sitePage, verifyEmailMail } from './templates.js';
import { en } from './i18n/en.js';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234';

afterEach(() => vi.unstubAllEnvs());

describe('siteLink', () => {
	it('joins SITE_URL, path and token, tolerating a trailing slash', () => {
		vi.stubEnv('SITE_URL', 'https://water-management.jaredhoward.com/');
		expect(siteLink('/reset-password', TOKEN)).toBe(`https://water-management.jaredhoward.com/reset-password?token=${TOKEN}`);
		expect(siteLink('/register', TOKEN, 'invite')).toBe(`https://water-management.jaredhoward.com/register?invite=${TOKEN}`);
	});

	it('falls back to the local dev site', () => {
		vi.stubEnv('SITE_URL', '');
		expect(siteLink('/verify-email', TOKEN)).toBe(`http://localhost:7777/verify-email?token=${TOKEN}`);
	});
});

describe('email templates', () => {
	const url = `http://localhost:7777/reset-password?token=${TOKEN}`;

	it.each([
		['verify', verifyEmailMail('ann@example.com', url), /Confirm your email address — Water Management/, /48 hours/],
		['verify (no locale chosen: English)', verifyEmailMail('ann@example.com', url, null), /Confirm your email address — Water Management/, /48 hours/],
		['reset', resetPasswordMail('ann@example.com', url), /Reset your password — Water Management/, /1 hour/],
		[
			'invite',
			inviteMail('ann@example.com', url, 'Ben', { kind: 'project', name: 'Kloof', role: 'viewer' }),
			/Ben invited you to Water Management/,
			/7 days/
		],
		[
			'invite (existing unverified account)',
			inviteMail('ann@example.com', url, 'Ben', { kind: 'project', name: 'Kloof', role: 'viewer' }, 'confirm'),
			/Ben invited you to Water Management/,
			/48 hours/
		]
	])('%s: subject, link and expiry in both the HTML and the text alternative', (_name, mail, subject, expiry) => {
		expect(mail.to).toBe('ann@example.com');
		expect(mail.subject).toMatch(subject);
		expect(mail.text).toContain(url);
		expect(mail.text).toMatch(expiry);
		expect(mail.text).toContain('Water Management');
		expect(mail.text).not.toMatch(/<[a-z]/i);
		expect(mail.html).toContain(`href="${url}"`);
		expect(mail.html).toMatch(expiry);
		// Accessible basics: language, title, one heading, descriptive link text, no images.
		expect(mail.html).toMatch(/<html lang="en">/);
		expect(mail.html).toMatch(/<title>[^<]+<\/title>/);
		expect(mail.html.match(/<h1/g)).toHaveLength(1);
		expect(mail.html).not.toMatch(/<img|click here/i);
	});

	it('escapes user-controlled names in the HTML and keeps them readable in the text', () => {
		const mail = inviteMail('x@example.com', url, 'Eve <script>', {
			kind: 'team',
			name: '"><img src=x onerror=alert(1)>',
			role: 'admin'
		});
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).not.toContain('<img');
		expect(mail.html).toContain('Eve &lt;script&gt;');
		expect(mail.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
		expect(mail.text).toContain('the team “"><img src=x onerror=alert(1)>” as an admin');
	});

	it('asks an existing unverified account to confirm, and says how to take a squatted address back', () => {
		const mail = inviteMail('x@example.com', url, 'A', { kind: 'team', name: 'T', role: 'member' }, 'confirm');
		expect(mail.text).toContain('There is already a Water Management account for x@example.com');
		expect(mail.text).toContain(`Confirm email and accept: ${url}`);
		expect(mail.text).toMatch(/Forgot password/);
		expect(mail.text).not.toMatch(/Create account/);
	});

	it('uses the right article for the role', () => {
		const t = (role: string) => inviteMail('x@example.com', url, 'A', { kind: 'project', name: 'P', role }).text;
		expect(t('viewer')).toContain('as a viewer');
		expect(t('editor')).toContain('as an editor');
		expect(t('owner')).toContain('as an owner');
		expect(t('member')).toContain('as a member');
	});

	it('escapeHtml covers the five HTML metacharacters', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
	});
});

describe('reportReadyMail', () => {
	const url = 'https://water.example.com/projects/p/reports/j';
	it('links to the sign-in-gated download page, names the run and pages, and escapes user text', () => {
		const m = reportReadyMail('ann@example.com', url, { projectName: 'Upper <Kleinberg>', runName: 'Baseline & wet', pages: 9, requestedBy: 'Bob', scheduled: false });
		expect(m.subject).toBe('Catchment report: Upper <Kleinberg> — Water Management');
		expect(m.text).toContain('Bob made a PDF of the report for the run Baseline & wet (9 pages).');
		expect(m.text).toContain(`Download the report: ${url}`);
		expect(m.text).toContain('The PDF is kept for 7 days.');
		expect(m.html).toContain('Upper &lt;Kleinberg&gt;');
		expect(m.html).toContain('Baseline &amp; wet');
		expect(m.html).not.toContain('<Kleinberg>');
	});
	it('says a scheduled one is the latest run, and who set it up; one page is singular', () => {
		const m = reportReadyMail('ann@example.com', url, { projectName: 'P', runName: 'R', pages: 1, requestedBy: 'Cy', scheduled: true });
		expect(m.text).toContain('This is the scheduled report of the latest run, R (1 page), set up by Cy.');
	});
	it('names an impact report as one', () => {
		const m = reportReadyMail('ann@example.com', url, { projectName: 'P', runName: 'What-if', pages: 10, requestedBy: 'Bob', scheduled: false, impact: true });
		expect(m.text).toContain('Bob made a PDF of the impact report for the run What-if (10 pages).');
	});
	it('sitePage joins SITE_URL and a path', () => {
		vi.stubEnv('SITE_URL', 'https://water.example.com/');
		expect(sitePage('/projects/p/reports/j')).toBe(url);
		vi.unstubAllEnvs();
	});
});

describe('farmer invite email (WP-2.2)', () => {
	const url = `http://localhost:7777/register?invite=${TOKEN}`;

	it('lists farms in plain English', () => {
		expect(listText([])).toBe('');
		expect(listText(['Vaalbank'])).toBe('Vaalbank');
		expect(listText(['A', 'B'])).toBe('A and B');
		expect(listText(['A', 'B', 'C'])).toBe('A, B and C');
	});

	it('says who gave access to which farms in which catchment, with the sign-up link', () => {
		const mail = farmerInviteMail('farmer@example.com', url, 'Wua Manager', { catchment: 'Sandspruit', farms: ['Vaalbank', 'Rustenvrede'] });
		expect(mail.subject).toBe('Wua Manager has given you access to Vaalbank and Rustenvrede in Sandspruit');
		expect(mail.text).toContain('Wua Manager has given you access to Vaalbank and Rustenvrede in Sandspruit.');
		expect(mail.text).toContain(`Create account and accept: ${url}`);
		expect(mail.text).toMatch(/7 days/);
		expect(mail.html).toContain(`href="${url}"`);
		expect(mail.html).toMatch(/<html lang="en">/);
		expect(mail.html.match(/<h1/g)).toHaveLength(1);
	});

	// The estimate line before the button, so the farmer has it before they can see a figure (CPA s49 research, R4).
	it('says the figures are model estimates, before the sign-up or confirm button', () => {
		for (const mode of ['sign-up', 'confirm'] as const) {
			const mail = farmerInviteMail('farmer@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek'] }, mode);
			const at = mail.text.indexOf(en['mail.farmer.estimate']);
			expect(at, mode).toBeGreaterThan(-1);
			expect(at).toBeLessThan(mail.text.indexOf(url));
		}
	});

	it('asks an existing unverified account to confirm instead', () => {
		const mail = farmerInviteMail('farmer@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek'] }, 'confirm');
		expect(mail.text).toContain('Confirm email and accept');
		expect(mail.text).toMatch(/48 hours/);
		expect(mail.text).toContain('There is already a Water Management account for farmer@example.com');
	});

	it('defaults to English (the Afrikaans wording is in templates.af.test.ts)', () => {
		const facts = { catchment: 'Kloof', farms: ['Hoek'] };
		expect(farmerInviteMail('f@example.com', url, 'Ann', facts, 'sign-up', 'en')).toEqual(farmerInviteMail('f@example.com', url, 'Ann', facts));
	});

	it('escapes farm, catchment and inviter names in the HTML', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Eve <b>', { catchment: '"><img src=x>', farms: ['<script>x</script>'] });
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).not.toContain('<img');
		expect(mail.html).toContain('&lt;script&gt;');
		expect(mail.text).toContain('<script>x</script>');
	});
});
