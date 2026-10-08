import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountDeletedMail, erratumNoticeMail, mfaResetMail, resetWhen, escapeHtml, farmerInviteMail, inviteMail, listText, packNoticeMail, reportReadyMail, resetPasswordMail, roleName, siteLink, sitePage, verifyEmailMail } from './templates.js';
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
		expect(mail.text).toContain('the team “"><img src=x onerror=alert(1)>” as an owner');
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
		expect(t('contributor')).toContain('as an applicant');
		expect(t('steward')).toContain('as a steward');
	});

	it('names a team role by the project role it gives, as the app does (#162)', () => {
		const t = (role: string) => inviteMail('x@example.com', url, 'A', { kind: 'team', name: 'T', role }).text;
		expect(t('viewer')).toContain('as a viewer.');
		expect(t('member')).toContain('as an editor.');
		expect(t('admin')).toContain('as an owner.');
		expect(roleName('member')).toBe('editor');
	});

	it('escapeHtml covers the five HTML metacharacters', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
	});
});

describe('the organisation’s privacy contact in invitations (POPIA s18(1)(b), 168)', () => {
	const url = siteLink('/register', TOKEN, 'invite');
	const contact = { organisation: 'Kloof WUA', name: 'Info Officer', email: 'io@kloof.example', postal: 'PO Box 1 <b>' };

	it('names the organisation and whom to ask in a farmer invite, escaped, with the postal address when there is one', () => {
		const mail = farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek'], contact });
		expect(mail.text).toContain('Kloof WUA decides about your information in this catchment. Questions about it: Info Officer, io@kloof.example.');
		expect(mail.text).toContain('Or write to Info Officer at: PO Box 1 <b>');
		expect(mail.html).toContain('PO Box 1 &lt;b&gt;');
		const noPost = farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek'], contact: { ...contact, postal: null } });
		expect(noPost.text).toContain('Questions about it: Info Officer');
		expect(noPost.text).not.toContain('Or write to');
	});

	it('names it in a project or team invite too', () => {
		const mail = inviteMail('x@example.com', url, 'Ann', { kind: 'project', name: 'Kloof', role: 'viewer' }, 'sign-up', contact);
		expect(mail.text).toContain('Kloof WUA decides about your information in its projects. Questions about it: Info Officer, io@kloof.example.');
		expect(mail.text).toContain('Or write to Info Officer at: PO Box 1 <b>');
	});

	it('says nothing of a contact when none is set (positive control: the privacy notice line stays)', () => {
		for (const mail of [
			farmerInviteMail('f@example.com', url, 'Ann', { catchment: 'Kloof', farms: ['Hoek'] }),
			inviteMail('x@example.com', url, 'Ann', { kind: 'team', name: 'T', role: 'member' })
		]) {
			expect(mail.text).not.toContain('decides about your information');
			expect(mail.text).toContain('How we handle your information');
		}
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
		expect(mail.subject).toBe('Wua Manager invited you to see Vaalbank and Rustenvrede in Sandspruit');
		expect(mail.text).toContain('Wua Manager invited you to see Vaalbank and Rustenvrede in Sandspruit.');
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

describe('packNoticeMail (issue #71)', () => {
	const base = {
		projectId: 'p1',
		packId: 'k1',
		projectName: 'Kloof',
		scenarioId: 's1',
		scenarioName: 'Upper dam',
		version: 2,
		supersedesVersion: 1,
		shortCode: 'ab12-cd34-ef56',
		reason: null,
		as: 'applicant'
	} as const;

	it('tells the applicant an issue: version, subject, short code, the public verify link and their own copy of the pack, not the editors’ page, and no figure', () => {
		const m = packNoticeMail('a@example.com', { ...base, event: 'issued' });
		expect(m).toMatchObject({ kind: 'pack_notice', to: 'a@example.com', subject: 'Evidence pack issued: Upper dam — Kloof' });
		expect(m.text).toContain('Version 2 of the evidence pack for the application “Upper dam” in Kloof has been issued.');
		expect(m.text).toContain('It replaces version 1, which is now marked as superseded.');
		expect(m.text).toContain('Its short code is ab12-cd34-ef56.');
		expect(m.text).toContain('Check the pack: http://localhost:7777/verify/ab12-cd34-ef56');
		expect(m.text).toContain('because the application “Upper dam” is yours');
		expect(m.text).toContain('Open the pack in the catchment: http://localhost:7777/projects/p1/scenarios/s1/packs/k1');
		expect(m.text).not.toContain('/projects/p1/packs/k1');
		expect(m.html).toMatch(/<html lang="en">/);
	});

	it('links no pack page for an applicant without an application (they are never emailed about baseline evidence)', () => {
		const m = packNoticeMail('a@example.com', { ...base, event: 'issued', scenarioId: null, scenarioName: null });
		expect(m.text).not.toContain('/packs/');
		expect(m.text).toContain('Check the pack: http://localhost:7777/verify/ab12-cd34-ef56');
	});

	it('gives an editor the pack’s own page too, and says why they get it', () => {
		const m = packNoticeMail('e@example.com', { ...base, event: 'issued', as: 'editor', supersedesVersion: null });
		expect(m.text).toContain('Open the pack in the catchment: http://localhost:7777/projects/p1/packs/k1');
		expect(m.text).toContain('You get this email because you can issue and withdraw evidence packs in Kloof.');
		expect(m.text).not.toContain('replaces version');
	});

	it('names baseline evidence as such', () => {
		const m = packNoticeMail('e@example.com', { ...base, event: 'issued', as: 'editor', scenarioName: null, version: 1, supersedesVersion: null });
		expect(m.subject).toBe('Evidence pack issued: Baseline evidence — Kloof');
		expect(m.text).toContain('Version 1 of the evidence pack for the baseline evidence in Kloof has been issued.');
	});

	it('says a withdrawal with its reason, and never mentions a replaced version', () => {
		const m = packNoticeMail('a@example.com', { ...base, event: 'withdrawn', reason: 'the licence application lapsed' });
		expect(m.subject).toBe('Evidence pack withdrawn: Upper dam — Kloof');
		expect(m.text).toContain('has been withdrawn. It no longer stands as evidence, and the verify page now says so.');
		expect(m.text).toContain('The reason given: “the licence application lapsed”');
		expect(m.text).not.toContain('replaces version');
	});

	it('follows the recipient’s language (an applicant may read Afrikaans), marked lang="af"', () => {
		const m = packNoticeMail('a@example.com', { ...base, event: 'issued' }, 'af');
		expect(m.html).toMatch(/<html lang="af">/);
		expect(m.subject).toBe('Bewyspakket uitgereik: Upper dam — Kloof');
		expect(m.text).toContain('http://localhost:7777/verify/ab12-cd34-ef56');
	});
});

describe('accountDeletedMail (issue #112, POPIA s24(4))', () => {
	it('says what was deleted, what stays without the name and what keeps it, and names what the person left', () => {
		const m = accountDeletedMail('a@example.com', { projects: ['Kloof', 'Vaal'], teams: ['Hydro team'] });
		expect(m).toMatchObject({ kind: 'account_deleted', to: 'a@example.com', subject: 'Your account has been deleted — Water Management' });
		expect(m.text).toContain('As you asked, we deleted the Water Management account for a@example.com.');
		expect(m.text).toContain('Deleted with it: your name, email address and password');
		expect(m.text).toContain('You are no longer a member of Kloof, Vaal and Hydro team.');
		expect(m.text).toContain('Kept without your name:');
		expect(m.text).toContain('Kept with your name: a sign-off keeps the name and registration you typed');
		expect(m.text).toContain('within 35 days');
		expect(m.text).toContain('Read the privacy notice: http://localhost:7777/privacy#retention');
		expect(m.html).toMatch(/<html lang="en">/);
	});

	it('leaves out the "no longer a member" line for an account that belonged to nothing', () => {
		const m = accountDeletedMail('a@example.com', { projects: [], teams: [] });
		expect(m.text).not.toContain('no longer a member');
		expect(m.text).toContain('Kept without your name:');
	});
});

describe('erratumNoticeMail (issue #103, the known-defect procedure)', () => {
	const erratum = { id: 'ER-7', keyedOn: 'run' as const, firstAffected: '0.16.0', fixedIn: '0.19.0', severity: 'Medium', appliesWhen: 'A transfer into a dam that loses water', summary: 'The dam was topped up short' };
	const base = { projectId: 'p 1', projectName: 'Upper dam', erratum, runCount: 3 };

	it('names the bug, when it changes results, the affected runs and the fix, and links the project’s runs', () => {
		const m = erratumNoticeMail('o@example.com', base);
		expect(m).toMatchObject({ kind: 'erratum_notice', to: 'o@example.com', subject: 'Known engine bug ER-7 may affect Upper dam — Water Management' });
		expect(m.text).toContain('We confirmed a bug in the model engine (ER-7, severity medium): The dam was topped up short.');
		expect(m.text).toContain('It changes results only when: A transfer into a dam that loses water.');
		expect(m.text).toContain('3 runs in Upper dam were made by engine 0.16.0 up to (not including) 0.19.0, which had this bug.');
		expect(m.text).toContain('It is fixed in engine 0.19.0.');
		expect(m.text).toContain('/projects/p%201?tab=runs');
		expect(m.text).toContain('You get this email because you own Upper dam.');
	});

	it('one run reads in the singular; an open erratum says it isn’t fixed yet', () => {
		const m = erratumNoticeMail('o@example.com', { ...base, runCount: 1, erratum: { ...erratum, fixedIn: null } });
		expect(m.text).toContain('1 run in Upper dam was made by engine 0.16.0 or later, which had this bug.');
		expect(m.text).toContain('It is not fixed yet.');
		expect(m.text).not.toContain('fixed in engine');
	});

	it('a fit erratum speaks of the calibration the parameters came from', () => {
		const m = erratumNoticeMail('o@example.com', { ...base, erratum: { ...erratum, keyedOn: 'fit' } });
		expect(m.text).toContain('3 runs in Upper dam use parameters from an automatic calibration made by engine 0.16.0 up to (not including) 0.19.0');
		expect(erratumNoticeMail('o@example.com', { ...base, runCount: 1, erratum: { ...erratum, keyedOn: 'fit' } }).text).toContain('1 run in Upper dam uses parameters');
	});
});

describe('mfaResetMail (205_mfa_recovery, recovering a lost second factor)', () => {
	const at = new Date('2026-10-11T21:30:00Z');
	const zone = process.env.TZ;
	afterEach(() => {
		process.env.TZ = zone;
	});

	it('the confirmation link: nothing changes until it is followed, it starts a 3-day wait, and someone else has the password', () => {
		const m = mfaResetMail('a@example.com', { stage: 'confirm', url: `http://localhost:7777/mfa-reset?token=${TOKEN}` });
		expect(m).toMatchObject({ kind: 'mfa_reset', to: 'a@example.com', subject: 'Confirm removing two-step sign-in — Water Management' });
		expect(m.text).toContain('3-day wait');
		expect(m.text).toContain(`Confirm and start the 3-day wait: http://localhost:7777/mfa-reset?token=${TOKEN}`);
		expect(m.text).toContain('This link expires in 1 hour and works once.');
		expect(m.text).toContain('someone knows your password');
	});

	it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'])('the wait: the date and time in South African time whatever the server’s zone (TZ %s)', (tz) => {
		process.env.TZ = tz;
		// 21:30 UTC on the 11th is 23:30 on the 11th in South Africa: the 12th in Kiritimati, still the 11th in Pago Pago.
		expect(resetWhen(at)).toEqual({ date: '11 Oct 2026', time: '23:30 SAST' });
		const m = mfaResetMail('a@example.com', { stage: 'started', cancelUrl: `http://localhost:7777/mfa-reset/cancel?token=${TOKEN}`, effectiveAt: at });
		expect(m.subject).toBe('Two-step sign-in will be removed on 11 Oct 2026 — Water Management');
		expect(m.text).toContain('Two-step sign-in will be removed from your account on 11 Oct 2026 at 23:30 SAST');
		expect(m.text).toContain('was confirmed from this inbox');
		expect(m.text).toContain(`Not you? Cancel it: http://localhost:7777/mfa-reset/cancel?token=${TOKEN}`);
		expect(m.text).toContain('works without signing in');
	});

	it('the daily reminder says it is still waiting, with its own cancel link', () => {
		const m = mfaResetMail('a@example.com', { stage: 'reminder', cancelUrl: 'http://localhost:7777/mfa-reset/cancel?token=x', effectiveAt: at });
		expect(m.text).toContain('is still waiting');
		expect(m.text).toContain('Not you? Cancel it: http://localhost:7777/mfa-reset/cancel?token=x');
	});

	it('the end, and a team admin’s reset: what happened, signed out everywhere, how to set it up again', () => {
		const done = mfaResetMail('a@example.com', { stage: 'done' });
		expect(done.subject).toBe('Two-step sign-in was removed — Water Management');
		expect(done.text).toContain('every device was signed out');
		expect(done.text).toContain('Sign in: http://localhost:7777/login');
		const admin = mfaResetMail('a@example.com', { stage: 'admin', team: 'Upper <WUA>' });
		expect(admin.subject).toBe('Your two-step sign-in was removed — Water Management');
		expect(admin.text).toContain('An admin of the team “Upper <WUA>” removed two-step sign-in');
		expect(admin.html).toContain('Upper &lt;WUA&gt;');
	});

	it('follows the person’s language, marked lang="af"', () => {
		for (const f of [
			{ stage: 'confirm', url: 'http://localhost:7777/mfa-reset?token=x' },
			{ stage: 'started', cancelUrl: 'http://localhost:7777/mfa-reset/cancel?token=x', effectiveAt: at },
			{ stage: 'reminder', cancelUrl: 'http://localhost:7777/mfa-reset/cancel?token=x', effectiveAt: at },
			{ stage: 'done' },
			{ stage: 'admin', team: 'Upper WUA' }
		] as const) {
			const m = mfaResetMail('a@example.com', f, 'af');
			expect(m.html, f.stage).toMatch(/<html lang="af">/);
			expect(m.subject, f.stage).not.toMatch(/two-step/i);
		}
	});
});
