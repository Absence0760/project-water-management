// Email bodies: short, plain, accessible HTML (semantic markup, real link
// text, no images, no layout tables) plus a text alternative with the same
// content. Every interpolated value is HTML-escaped — project and team names
// and display names are user-controlled and these emails go to addresses the
// user merely typed in.
import { LOCALES, mailT, type Locale, type MailTranslator } from './i18n/index.js';
import type { Mail, MailKind } from './transport.js';

// The farmer-facing emails (verify, reset, the farmer invite) take their
// words from the catalogue in ./i18n (WP-2.5). The workspace's own emails
// (project/team invites, report ready) stay English, as the workspace does.
export { LOCALES, type Locale };

export const PRODUCT = 'Water Management';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]!);

/** Absolute link into the site: SITE_URL + path + ?<param>=<token>. */
export function siteLink(path: string, token: string, param = 'token'): string {
	const base = (process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '');
	return `${base}${path}?${param}=${encodeURIComponent(token)}`;
}

/** A run of text in another language than the mail's (a WUA notice written in English in an Afrikaans mail): `<span lang>` in HTML (WCAG 3.1.2). */
export type Inline = string | { text: string; lang: string };
/** A paragraph: plain text, or runs of which some carry their own language. */
export type Para = string | Inline[];

/** A paragraph as plain text (the text part, and the digest's one-line items). */
export const paraText = (p: Para): string => (typeof p === 'string' ? p : p.map((x) => (typeof x === 'string' ? x : x.text)).join(''));

const paraHtml = (p: Para): string =>
	typeof p === 'string' ? escapeHtml(p) : p.map((x) => (typeof x === 'string' ? escapeHtml(x) : `<span lang="${escapeHtml(x.lang)}">${escapeHtml(x.text)}</span>`)).join('');

export type Body = {
	heading: string;
	paragraphs: Para[];
	action: { label: string; url: string };
	footer: string[];
	/** Small links under the footer (an alert's unsubscribe and manage links), as real links in HTML and "label: url" in text. */
	links?: { label: string; url: string }[];
	/**
	 * A question with answer links, after the action and before the footer
	 * (an alert's "Was this useful? Yes · No", 151_alert_feedback): plain
	 * links, never an image or a pixel, in HTML; "label: url" in text.
	 */
	ask?: { question: string; answers: { label: string; url: string }[] };
};

/** `tr` supplies the frame's words and, through `tr.lang`, the `<html lang>`; read after the body is built, so it knows whether anything fell back to English. */
export function render(kind: MailKind, to: string, subject: string, b: Body, tr: MailTranslator = mailT('en')): Mail {
	const links = b.links ?? [];
	const fallbackLine = tr.t('mail.buttonFallback');
	const text = [
		b.heading,
		'',
		...b.paragraphs.flatMap((p) => [paraText(p), '']),
		`${b.action.label}: ${b.action.url}`,
		'',
		...(b.ask ? [b.ask.question, ...b.ask.answers.map((a) => `${a.label}: ${a.url}`), ''] : []),
		...b.footer.flatMap((p) => [p, '']),
		...links.flatMap((l) => [`${l.label}: ${l.url}`, '']),
		`— ${PRODUCT}`
	].join('\n');
	const p = (s: Para) => `<p style="margin:0 0 16px">${paraHtml(s)}</p>`;
	const url = escapeHtml(b.action.url);
	const html = `<!doctype html>
<html lang="${tr.lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.5">
<main style="max-width:560px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map(p).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:10px 18px;background:#1d4e89;color:#ffffff;border-radius:6px;text-decoration:underline;font-weight:600">${escapeHtml(b.action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px">${escapeHtml(fallbackLine)}<br><a href="${url}" style="color:#1d4e89;word-break:break-all">${url}</a></p>
${b.ask ? `<p style="margin:0 0 16px">${escapeHtml(b.ask.question)} ${b.ask.answers.map((a) => `<a href="${escapeHtml(a.url)}" style="color:#1d4e89;font-weight:600">${escapeHtml(a.label)}</a>`).join(' · ')}</p>\n` : ''}${b.footer.map(p).join('\n')}${links.length ? `\n<p style="margin:0 0 16px;font-size:14px">${links.map((l) => `<a href="${escapeHtml(l.url)}" style="color:#1d4e89">${escapeHtml(l.label)}</a>`).join(' · ')}</p>` : ''}
<p style="margin:24px 0 0;font-size:14px;color:#4a4a4a">— ${PRODUCT}</p>
</main>
</body>
</html>`;
	return { kind, to, subject, text, html };
}

export function verifyEmailMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'verify',
		to,
		tr.t('mail.verify.subject', v),
		{
			heading: tr.t('mail.verify.heading'),
			paragraphs: [tr.t('mail.verify.body', v)],
			action: { label: tr.t('mail.verify.action'), url },
			footer: [tr.t('mail.verify.expires'), tr.t('mail.verify.ignore')]
		},
		tr
	);
}

/**
 * To the owner of an address someone signed up with again (auth/routes.ts
 * /register): the sign-up page answers the same for a new and a taken
 * address, so the owner learns it here, with a password-reset link in case
 * they forgot theirs.
 */
export function accountExistsMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'account_exists',
		to,
		tr.t('mail.exists.subject', v),
		{
			heading: tr.t('mail.exists.heading'),
			paragraphs: [tr.t('mail.exists.body', v), tr.t('mail.exists.signIn')],
			action: { label: tr.t('mail.exists.action'), url },
			footer: [tr.t('mail.reset.expires'), tr.t('mail.exists.ignore')]
		},
		tr
	);
}

export function resetPasswordMail(to: string, url: string, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	return render(
		'reset',
		to,
		tr.t('mail.reset.subject', v),
		{
			heading: tr.t('mail.reset.heading'),
			paragraphs: [tr.t('mail.reset.body', v), tr.t('mail.reset.signsOut')],
			action: { label: tr.t('mail.reset.action'), url },
			footer: [tr.t('mail.reset.expires'), tr.t('mail.reset.ignore')]
		},
		tr
	);
}

export type InviteTarget = { kind: 'project' | 'team'; name: string; role: string };

/**
 * How the invitee accepts (invites/invites.ts inviteByEmail):
 * `sign-up`: the address has no account; the link is `/register?invite=…`.
 * `confirm`: an unverified account already has the address; the link is a
 * verify-email link, and confirming accepts the invitation.
 * `accept`: a verified account has the address; the link is the invitations
 * page, where its holder signs in and accepts or declines (issue #136).
 */
export type InviteMode = 'sign-up' | 'confirm' | 'accept';

/**
 * A role value as the email names it: the UI's names (frontend
 * lib/api/roleLabels.ts, issue #162), one set for projects and teams. A team
 * `member` is an editor on every team project and an `admin` an owner, so the
 * invitee reads the same word the app will show them. Unknown values as sent.
 */
const ROLE_NAME: Readonly<Record<string, string>> = {
	farmer: 'farmer',
	contributor: 'applicant',
	viewer: 'viewer',
	editor: 'editor',
	owner: 'owner',
	member: 'editor',
	admin: 'owner'
};
export function roleName(role: string): string {
	return Object.hasOwn(ROLE_NAME, role) ? ROLE_NAME[role]! : role;
}

/**
 * The organisation that decides about the information an invite concerns, and whom to ask (POPIA s18(1)(b);
 * 168_team_privacy_contact): the project's team, or the team invited to. Absent when it has set no contact.
 */
export type InviteContact = { organisation: string; name: string; email: string; postal: string | null };

/** An invite to a project or team, in one of the three modes (InviteMode). */
export function inviteMail(
	to: string,
	url: string,
	inviterName: string,
	target: InviteTarget,
	mode: InviteMode = 'sign-up',
	contact: InviteContact | null = null
): Mail {
	const what = target.kind === 'project' ? `the catchment project “${target.name}”` : `the team “${target.name}”`;
	const role = roleName(target.role);
	const invited = `${inviterName} invited you to ${what} as ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}.`;
	const confirm = mode === 'confirm';
	return render('invite', to, `${inviterName} invited you to ${PRODUCT}`, {
		heading: `You're invited to ${PRODUCT}`,
		paragraphs: confirm
			? [invited, `There is already a ${PRODUCT} account for ${to}. Confirm that this is your email address to accept.`]
			: mode === 'accept'
				? [invited, `Sign in to ${PRODUCT} as ${to} to accept or decline. You won't join until you accept.`]
				: [invited, `Create your ${PRODUCT} account with this email address (${to}) to accept.`],
		action: confirm
			? { label: 'Confirm email and accept', url }
			: mode === 'accept'
				? { label: 'See the invitation', url }
				: { label: 'Create account and accept', url },
		// The privacy notice's address: an invitee's details are processed before they reach sign-up (POPIA s18).
		footer: (confirm
			? [
					'This link expires in 48 hours.',
					`If you never created a ${PRODUCT} account, someone else registered your address: don't confirm it — use “Forgot password” on the sign-in page to take the account over instead.`
				]
			: ['This invitation expires in 7 days.', "If you weren't expecting this, you can ignore this email."]
		)
			.concat(
				contact
					? [
							`${contact.organisation} decides about your information in its projects. Questions about it: ${contact.name}, ${contact.email}.`,
							...(contact.postal ? [`Or write to ${contact.name} at: ${contact.postal}`] : [])
						]
					: []
			)
			.concat(`How we handle your information: ${sitePage('/privacy')}`)
	});
}

/** "A", "A and B", "A, B and C". */
export function listText(items: readonly string[], and = 'and'): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
}

export type FarmerInviteFacts = { catchment: string; farms: string[]; contact?: InviteContact | null };

/**
 * A farmer invite (WP-2.2): "{inviter} invited you to see {farm} in
 * {catchment}". The same modes as `inviteMail`; `locale` (invite.locale)
 * picks the wording, English where Afrikaans has none yet.
 */
export function farmerInviteMail(
	to: string,
	url: string,
	inviterName: string,
	facts: FarmerInviteFacts,
	mode: InviteMode = 'sign-up',
	locale: Locale = 'en'
): Mail {
	const tr = mailT(locale);
	const confirm = mode === 'confirm';
	const farms = facts.farms.length ? listText(facts.farms, tr.t('mail.farmer.and')) : tr.t('mail.farmer.yourFarm');
	const v = { inviter: inviterName, farms, catchment: facts.catchment, email: to, product: PRODUCT };
	return render(
		'farmer_invite',
		to,
		tr.t('mail.farmer.subject', v),
		{
			heading: tr.t('mail.farmer.heading', v),
			paragraphs: [
				tr.t('mail.farmer.body', v),
				tr.t('mail.farmer.privacy'),
				// Before the sign-up button: the farmer reads it before they can see a figure (CPA s49 research, R4).
				tr.t('mail.farmer.estimate'),
				tr.t(confirm ? 'mail.invite.confirm' : mode === 'accept' ? 'mail.invite.accept' : 'mail.invite.signUp', v)
			],
			action: { label: tr.t(confirm ? 'mail.invite.confirmAction' : mode === 'accept' ? 'mail.invite.acceptAction' : 'mail.invite.signUpAction'), url },
			// The privacy notice's address: a farmer's details are processed before they reach sign-up (POPIA s18).
			footer: [
				...(confirm
					? [tr.t('mail.invite.confirmExpires'), tr.t('mail.invite.confirmTakeOver', v)]
					: [tr.t('mail.invite.signUpExpires'), tr.t('mail.invite.signUpIgnore')]),
				// Who decides about the farmer's information, when the catchment's team has said (POPIA s18(1)(b), 168).
				...(facts.contact
					? [
							tr.t('mail.invite.contact', { organisation: facts.contact.organisation, name: facts.contact.name, email: facts.contact.email }),
							...(facts.contact.postal ? [tr.t('mail.invite.contactPost', { name: facts.contact.name, postal: facts.contact.postal })] : [])
						]
					: []),
				tr.t('mail.invite.privacy', { url: sitePage('/privacy') })
			]
		},
		tr
	);
}

/** Absolute link to a page of the site (no token). */
export function sitePage(path: string): string {
	return `${(process.env.SITE_URL || 'http://localhost:7777').replace(/\/+$/, '')}${path}`;
}

export type ReportMailFacts = {
	projectName: string;
	/** The run's label, or its date when it has none. */
	runName: string;
	pages: number;
	/** Who asked, or who set up the schedule. */
	requestedBy: string;
	scheduled: boolean;
	/** An impact report (the run against a baseline, 082); a schedule never makes one. */
	impact?: boolean;
};

/**
 * A report PDF is ready (WP-2.15 Phase B). The link opens the app's download
 * page, which needs the reader signed in and still a member of the project
 * before it hands out a short-lived download link: the email itself grants
 * nothing, and a forwarded one opens nothing for a non-member.
 */
export function reportReadyMail(to: string, url: string, f: ReportMailFacts): Mail {
	const pages = `${f.pages} ${f.pages === 1 ? 'page' : 'pages'}`;
	return render('report_ready', to, `Catchment report: ${f.projectName} — ${PRODUCT}`, {
		heading: `The report for ${f.projectName} is ready`,
		paragraphs: [
			f.scheduled
				? `This is the scheduled report of the latest run, ${f.runName} (${pages}), set up by ${f.requestedBy}.`
				: `${f.requestedBy} made a PDF of the ${f.impact ? 'impact report' : 'report'} for the run ${f.runName} (${pages}).`,
			'Sign in to download it. You need to be a member of the project.'
		],
		action: { label: 'Download the report', url },
		footer: ['The PDF is kept for 7 days.', "If you weren't expecting this, a member of the project sent it to you; you can ignore it."]
	});
}

export type PackNoticeFacts = {
	event: 'issued' | 'withdrawn';
	projectId: string;
	packId: string;
	projectName: string;
	/** The application's scenario (its id, for the applicant's pack view); null for baseline evidence. */
	scenarioId: string | null;
	/** The application's scenario name; null for baseline evidence. */
	scenarioName: string | null;
	version: number;
	/** The version this one replaced (an issue that superseded another), or null. */
	supersedesVersion: number | null;
	/** `xxxx-xxxx-xxxx` (engine packShortCode). */
	shortCode: string;
	/** Why it was withdrawn (public on verify); null for an issue. */
	reason: string | null;
	/**
	 * Why this person gets it: `editor` (they issue and withdraw the project's
	 * packs; the mail links the pack's own page too) or `applicant` (the
	 * application is theirs; the mail links their own copy of the pack, the
	 * applicant's pack view of 131_applicant_packs, never the editors' page).
	 */
	as: 'editor' | 'applicant';
};

/**
 * The recipient's own page for the pack: an editor's is the pack's page; an
 * applicant's is their copy (frontend packs/applicantPack.ts
 * applicantPackHref), which they read only for their own application.
 */
function packPagePath(f: PackNoticeFacts): string | null {
	const project = encodeURIComponent(f.projectId);
	const pack = encodeURIComponent(f.packId);
	if (f.as === 'editor') return `/projects/${project}/packs/${pack}`;
	// An applicant is emailed only about their application's pack; without one there is no copy of theirs to link.
	return f.scenarioId ? `/projects/${project}/scenarios/${encodeURIComponent(f.scenarioId)}/packs/${pack}` : null;
}

/**
 * An evidence pack was issued, or one that was issued was withdrawn (issue
 * #71; docs/evidence-pack.md § Notices). Built by the worker as its recipient
 * (evidence/notices.ts). It names the pack (version, subject, short code) and
 * links the public verify page and the recipient's own view of the pack
 * (an editor's pack page, an applicant's copy); never a figure. In the recipient's language
 * (an applicant may read Afrikaans), English where a key has none.
 */
export function packNoticeMail(to: string, f: PackNoticeFacts, locale?: string | null): Mail {
	const tr = mailT(locale);
	const name = f.scenarioName ?? tr.t('mail.pack.name.baseline');
	const what = f.scenarioName === null ? tr.t('mail.pack.what.baseline') : tr.t('mail.pack.what.application', { name: f.scenarioName });
	const v = { name, what, project: f.projectName, version: f.version, code: f.shortCode, product: PRODUCT };
	const issued = f.event === 'issued';
	const page = packPagePath(f);
	const paragraphs: Para[] = issued
		? [tr.t('mail.pack.issued.body', v), ...(f.supersedesVersion !== null ? [tr.t('mail.pack.issued.supersedes', { previous: f.supersedesVersion })] : [])]
		: [tr.t('mail.pack.withdrawn.body', v), ...(f.reason ? [tr.t('mail.pack.withdrawn.reason', { reason: f.reason })] : [])];
	paragraphs.push(tr.t('mail.pack.code', v));
	return render(
		'pack_notice',
		to,
		tr.t(issued ? 'mail.pack.issued.subject' : 'mail.pack.withdrawn.subject', v),
		{
			heading: tr.t(issued ? 'mail.pack.issued.heading' : 'mail.pack.withdrawn.heading'),
			paragraphs,
			action: { label: tr.t('mail.pack.action'), url: sitePage(`/verify/${encodeURIComponent(f.shortCode)}`) },
			footer: [f.as === 'editor' ? tr.t('mail.pack.why.editor', v) : tr.t('mail.pack.why.applicant', { name })],
			links: page ? [{ label: tr.t('mail.pack.open'), url: sitePage(page) }] : []
		},
		tr
	);
}

export type PackSentFacts = {
	projectId: string;
	packId: string;
	projectName: string;
	/** The pack's title as its report gives it (the application's name, or the baseline's). */
	title: string;
	version: number;
	/** `xxxx-xxxx-xxxx` (engine packShortCode). */
	shortCode: string;
	/** Who sent it (their display name). */
	sentBy: string;
	/** settings.responsibleAuthority's name (163), or null when the project names none. */
	authority: string | null;
	/** The sender's note, or null. */
	note: string | null;
};

/**
 * The full evidence pack sent to a member acting for the responsible
 * authority (165, licensing build item 13; provisional position, pre-counsel
 * research, 2026-10-01; docs/evidence-pack.md § Sending it to the authority).
 * The pack's PDF and bundle name every water user, so the mail carries
 * neither and no download link: it links the pack's page, which needs the
 * reader signed in and still an editor of the project before it hands out a
 * one-minute signed download, and the public verify page. A forwarded mail
 * opens nothing. English, as the workspace is.
 */
export function packSentMail(to: string, f: PackSentFacts): Mail {
	const authority = f.authority ?? 'the responsible authority';
	return render('pack_sent', to, `Evidence pack v${f.version} ${f.shortCode} sent to you for ${authority} — ${PRODUCT}`, {
		heading: 'An evidence pack was sent to you',
		paragraphs: [
			`${f.sentBy} sent you version ${f.version} of the evidence pack “${f.title}” in ${f.projectName}, for ${authority}.`,
			...(f.note ? [`Their note: “${f.note}”`] : []),
			'Sign in to download its PDF and its reproduction bundle from the pack’s page. They name every water user in the catchment, so they are for the authority’s assessment: don’t pass them on.',
			`Anyone holding a copy checks it on the verify page, with the code ${f.shortCode}.`
		],
		action: { label: 'Open the pack', url: sitePage(`/projects/${encodeURIComponent(f.projectId)}/packs/${encodeURIComponent(f.packId)}`) },
		footer: [`You get this because the owner of ${f.projectName} marked you as acting for the responsible authority. This email grants nothing by itself: the pack opens only for you, signed in.`],
		links: [{ label: 'Verify page', url: sitePage(`/verify/${encodeURIComponent(f.shortCode)}`) }]
	});
}

export type ErratumNoticeFacts = {
	projectId: string;
	projectName: string;
	/** The erratum (docs/engine-errata.md, the engine's ENGINE_ERRATA): its id and what the table says. */
	erratum: { id: string; keyedOn: 'run' | 'fit'; firstAffected: string; fixedIn: string | null; severity: string; appliesWhen: string; summary: string };
	/** How many of the project's runs were made by an affected engine (or with an affected fit) when it was swept. */
	runCount: number;
};

/**
 * A confirmed engine bug may affect results in a project (issue #103, the
 * known-defect procedure; docs/legal/known-defect-procedure.md). Sent once
 * per erratum, project and owner by the worker (errata/notices.ts), built as
 * its recipient. It says what goes wrong, when it changes results, how many
 * runs may be affected and what to do; it never says the results *are*
 * wrong, since a run is affected only when the erratum's conditions hold.
 * English, as the workspace is.
 */
export function erratumNoticeMail(to: string, f: ErratumNoticeFacts): Mail {
	const e = f.erratum;
	const runs = `${f.runCount} ${f.runCount === 1 ? 'run' : 'runs'}`;
	const made =
		e.keyedOn === 'fit'
			? `${runs} in ${f.projectName} ${f.runCount === 1 ? 'uses' : 'use'} parameters from an automatic calibration made by engine ${e.firstAffected}${e.fixedIn ? ` up to (not including) ${e.fixedIn}` : ' or later'}, which had this bug.`
			: `${runs} in ${f.projectName} ${f.runCount === 1 ? 'was' : 'were'} made by engine ${e.firstAffected}${e.fixedIn ? ` up to (not including) ${e.fixedIn}` : ' or later'}, which had this bug.`;
	return render('erratum_notice', to, `Known engine bug ${e.id} may affect ${f.projectName} — ${PRODUCT}`, {
		heading: `A known engine bug may affect results in ${f.projectName}`,
		paragraphs: [
			`We confirmed a bug in the model engine (${e.id}, severity ${e.severity.toLowerCase()}): ${e.summary}.`,
			`It changes results only when: ${e.appliesWhen}.`,
			made,
			e.fixedIn
				? `It is fixed in engine ${e.fixedIn}. Check whether the conditions apply to your catchment; if they do, re-run on the current engine and compare the two runs. The affected runs are marked in the app, and their validation statement, sign-off and evidence report list ${e.id}.`
				: `It is not fixed yet. Check whether the conditions apply to your catchment; if they do, treat the affected figures with care until it is. The affected runs are marked in the app, and their validation statement, sign-off and evidence report list ${e.id}.`,
			'If a run you published, signed or put in an evidence pack is affected, consider telling the people who rely on it. An issued pack keeps its own record, and its verify page lists the errata found since it was issued.'
		],
		action: { label: 'Open the runs', url: sitePage(`/projects/${encodeURIComponent(f.projectId)}?tab=runs`) },
		footer: [`You get this email because you own ${f.projectName}. The list of known engine bugs is published with the methodology (docs/engine-errata.md).`]
	});
}

/** What a deletion did, for its confirmation: the catchments and teams the person left (their names, as they stood). */
export type AccountDeletedFacts = { projects: string[]; teams: string[] };

/**
 * The account was deleted (issue #112, DELETE /auth/me): what was done, as
 * POPIA s24(4) asks. Sent to the address the account had, after the row is
 * gone, in the language it had chosen. It says what went, what stays
 * without the name and what keeps it, and names the catchments and teams
 * the person left (docs/security.md § Personal information (POPIA)). The
 * button opens the privacy notice, which says how to reach the operator if
 * the person didn't do it.
 */
export function accountDeletedMail(to: string, f: AccountDeletedFacts, locale?: string | null): Mail {
	const tr = mailT(locale);
	const v = { email: to, product: PRODUCT };
	const left = [...f.projects, ...f.teams];
	return render(
		'account_deleted',
		to,
		tr.t('mail.deleted.subject', v),
		{
			heading: tr.t('mail.deleted.heading'),
			paragraphs: [
				tr.t('mail.deleted.body', v),
				tr.t('mail.deleted.gone'),
				...(left.length ? [tr.t('mail.deleted.left', { list: listText(left, tr.t('mail.farmer.and')) })] : []),
				tr.t('mail.deleted.kept'),
				tr.t('mail.deleted.signed'),
				tr.t('mail.deleted.backups')
			],
			action: { label: tr.t('mail.deleted.action'), url: sitePage('/privacy#retention') },
			footer: [tr.t('mail.deleted.notYou')]
		},
		tr
	);
}
