// Sending alert mails (roadmap WP-2.13): the worker's step after the jobs of
// each tick (jobs/runner.ts), so every delivery an alert_eval queued is
// sent after that job committed.
//
//   1. The kill switch: with ALERTS_ENABLED=false every waiting delivery is
//      skipped (app_alert_skip_all), so nothing floods out when it's turned
//      back on.
//   2. Immediate: claim pending deliveries (app_alert_claim), which applies
//      the daily cap: past DAILY_CAP immediate mails since the last 06:00
//      in the project's time zone, the rest wait for the digest.
//   3. Digest: after 06:00 where the catchment is (project.time_zone,
//      059_local_day), every digest line queued before it, one email per
//      person and project (app_alert_claim_digest).
//
// Each mail is built in a transaction *as its recipient* (withUser), under
// RLS: their access is checked again now (app_alert_my_mode: a member removed
// since the event, or who turned the alert off, gets nothing; nor does an
// address SES has suppressed since, mail/suppression.ts), and the mail
// can only say what they may read, so a farmer's names their own farm and
// nothing of a neighbour's. The mail goes out after that transaction, and the
// outcome is recorded in the worker's own context (app_alert_finish). A
// transport error is retried on the next tick (3 attempts in all); a worker
// that dies mid-send leaves a delivery marked failed, never sent twice.
import { pickNotice } from '@water-management/engine';
import { hashToken } from '../auth/tokens.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { safeError } from '../logging/safeError.js';
import { alertMail, digestMail, type AlertFacts, type Recipient } from '../mail/alerts.js';
import { sendMail, type Mail } from '../mail/transport.js';
import { alertsEnabled } from './evaluate.js';
import type { AlertKind, AlertMode } from './rules.js';
import { alertsTokenSecret, newSubscriptionSecret, oneClickUrl, unsubscribePageUrl, unsubscribeToken } from './tokens.js';

export interface Claimed {
	event_id: string;
	user_id: string;
	project_id: string;
	kind: AlertKind;
	node_id: string | null;
}

export interface SendResult {
	sent: number;
	skipped: number;
	failed: number;
	/** Digest emails sent (each may carry several deliveries). */
	digests: number;
}

const LEASE = '10 minutes';

/**
 * A digest email lists at most this many alerts per catchment, newest first,
 * then "and N more" with a link to the app. The lines past it are counted,
 * marked sent (in the digest), and never sent again.
 */
export const DIGEST_MAX_LINES = 20;
/** Lines claimed per person for one digest (app_alert_claim_digest); older ones are skipped as over the limit. */
export const DIGEST_CLAIM_LINES = 200;

/** At most this many immediate alert mails per person per digest day; the rest wait for the digest. */
export const DEFAULT_DAILY_CAP = 5;

/** At most this many immediate mails per person per digest day (ALERTS_DAILY_CAP, default 5). */
export function dailyCap(): number {
	const n = Number(process.env.ALERTS_DAILY_CAP);
	return process.env.ALERTS_DAILY_CAP?.trim() && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

type Prepared = { mail: Mail } | { skip: string };

interface EventRow {
	id: string;
	kind: AlertKind;
	state: 'firing' | 'cleared';
	value: number | null;
	detail: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
	node_id: string | null;
	threshold: number;
}

/**
 * The recipient's own subscription row for this alert, created with their
 * current mode if they have none yet, and its token. A farmer's dam alert is
 * per farm; everyone else's per kind (turning dam alerts off turns them off
 * for every farm). A row the preferences page wrote (or re-enabled, with a
 * new nonce) has no hash yet: it is stored now, so the token goes live with
 * the first mail that carries it. As the recipient: RLS lets them touch only
 * their own rows.
 */
async function subscriptionToken(db: Db, projectId: string, kind: AlertKind | 'all', nodeId: string | null, mode: AlertMode, secret: string): Promise<string> {
	const { rows } = await db.query<{ id: string; unsubscribe_nonce: Buffer; unsubscribe_hash: Buffer | null }>(
		`SELECT id, unsubscribe_nonce, unsubscribe_hash FROM alert_subscription
		 WHERE user_id = app_current_user_id() AND project_id = $1 AND kind = $2 AND (node_id = $3::uuid OR node_id IS NULL)
		 ORDER BY node_id NULLS LAST LIMIT 1`,
		[projectId, kind, nodeId]
	);
	const row = rows[0];
	if (row) {
		const token = unsubscribeToken(row.unsubscribe_nonce, secret);
		if (!row.unsubscribe_hash) await db.query('UPDATE alert_subscription SET unsubscribe_hash = $2 WHERE id = $1', [row.id, hashToken(token)]);
		return token;
	}
	const { nonce, hash } = newSubscriptionSecret(secret);
	await db.query(
		`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce, unsubscribe_hash)
		 VALUES (app_current_user_id(), $1, $2, $3::uuid, $4, $5, $6)`,
		[projectId, kind, nodeId, kind === 'all' ? 'immediate' : mode, nonce, hash]
	);
	return unsubscribeToken(nonce, secret);
}

interface Context {
	recipient: Recipient;
	role: string;
	project: { id: string; name: string };
}

/** Why a delivery goes unsent when SES has suppressed its address (057_alert_followups). */
export const SUPPRESSED = 'the address is suppressed (a bounce or complaint)';

/**
 * Who the transaction's user is, for this project: why not, when they can't
 * receive mail (no verified address, no access, or SES suppressed the
 * address since the delivery was made: mail/suppression.ts).
 */
async function context(db: Db, projectId: string): Promise<Context | string> {
	const { rows } = await db.query<{ email: string; locale: string | null; verified: boolean; suppressed: boolean; role: string | null; name: string | null }>(
		`SELECT u.email, u.locale, u.email_verified_at IS NOT NULL AS verified, u.mail_suppressed_at IS NOT NULL AS suppressed,
			app_project_role($1)::text AS role, (SELECT p.name FROM project p WHERE p.id = $1) AS name
		 FROM app_user u WHERE u.id = app_current_user_id()`,
		[projectId]
	);
	const r = rows[0];
	if (!r?.verified || !r.role || !r.name) return 'no longer a member, or no confirmed address';
	if (r.suppressed) return SUPPRESSED;
	return { recipient: { email: r.email, locale: r.locale, farmer: r.role === 'farmer' }, role: r.role, project: { id: projectId, name: r.name } };
}

/** One event as the recipient may read it, or why not. */
async function facts(db: Db, c: Claimed): Promise<AlertFacts | string> {
	const { rows: mode } = await db.query<{ mode: AlertMode | null }>('SELECT app_alert_my_mode($1, $2, $3) AS mode', [c.project_id, c.kind, c.node_id]);
	if (!mode[0]?.mode) return 'no longer gets this alert';
	if (mode[0].mode === 'off') return 'turned this alert off';
	const { rows } = await db.query<EventRow>(
		`SELECT e.id, e.kind, e.state, e.value, e.detail, e.node_id, r.threshold
		 FROM alert_event e JOIN alert_rule r ON r.id = e.rule_id WHERE e.id = $1`,
		[c.event_id]
	);
	const e = rows[0];
	if (!e) return 'cannot see this alert';
	const d = e.detail;
	switch (e.kind) {
		case 'dam_below': {
			// The farm's name as the recipient reads it (a farmer: only their own farm).
			const { rows: n } = await db.query<{ name: string }>('SELECT name FROM node WHERE id = $1', [e.node_id]);
			if (!n[0]) return 'cannot see this farm';
			return { kind: 'dam_below', farm: n[0].name, pct: Number(d.pct), threshold: e.threshold, source: d.source === 'forecast' ? 'forecast' : 'latest', date: String(d.date), madeOn: d.madeOn ?? null };
		}
		case 'ewr_forecast_fail':
			return { kind: 'ewr_forecast_fail', days: Number(d.days), of: Number(d.of), from: String(d.from), to: String(d.to), madeOn: String(d.madeOn), threshold: e.threshold };
		case 'data_stale':
			return { kind: 'data_stale', threshold: e.threshold, feeds: Array.isArray(d.feeds) ? d.feeds : [] };
		case 'feed_failing':
			return { kind: 'feed_failing', threshold: e.threshold, feeds: Array.isArray(d.feeds) ? d.feeds : [] };
		case 'job_dead':
			return { kind: 'job_dead', count: Number(d.count) };
		case 'restriction_published': {
			const { rows: p } = await db.query<{ restriction_level: 'none' | 'advisory' | 'restricted'; restriction_pct: string | null; notice: Record<string, string>; published_at: Date }>(
				'SELECT restriction_level, restriction_pct, notice, published_at FROM run_publication WHERE id = $1',
				[d.publicationId]
			);
			if (!p[0]) return 'cannot see the publication';
			const { rows: me } = await db.query<{ locale: string | null }>('SELECT locale FROM app_user WHERE id = app_current_user_id()');
			// The notice in the reader's language, else English, else any (the farm view's rule).
			const notice = pickNotice(p[0].notice, me[0]?.locale)?.text ?? null;
			return {
				kind: 'restriction_published',
				level: d.level ?? p[0].restriction_level,
				pct: d.pct === null || d.pct === undefined ? null : Number(d.pct),
				notice,
				publishedAt: p[0].published_at.toISOString(),
				lifted: d.lifted === true
			};
		}
	}
}

/** One delivery's mail, built as its recipient. */
async function prepareOne(db: Db, c: Claimed, secret: string): Promise<Prepared> {
	const ctx = await context(db, c.project_id);
	if (typeof ctx === 'string') return { skip: ctx };
	const f = await facts(db, c);
	if (typeof f === 'string') return { skip: f };
	const { rows: mode } = await db.query<{ mode: AlertMode }>('SELECT app_alert_my_mode($1, $2, $3) AS mode', [c.project_id, c.kind, c.node_id]);
	const nodeForRow = c.kind === 'dam_below' && ctx.role === 'farmer' ? c.node_id : null;
	const token = await subscriptionToken(db, c.project_id, c.kind, nodeForRow, mode[0]!.mode, secret);
	return { mail: alertMail(ctx.recipient, ctx.project, f, { pageUrl: unsubscribePageUrl(token), oneClickUrl: oneClickUrl(token) }) };
}

const finish = (c: Pick<Claimed, 'event_id' | 'user_id'>, status: 'sent' | 'skipped' | 'failed' | 'retry', reason: string | null = null) =>
	withoutUser((db) => db.query('SELECT app_alert_finish($1, $2, $3, $4)', [c.event_id, c.user_id, status, reason]));

/**
 * A transport or database error, as the delivery's reason: never the raw text
 * (it may hold an address). The log lines below carry the same, through
 * safeError: the error's name and code, never its message.
 */
const failureReason = (err: unknown) => `send failed (${safeError(err).error})`;

async function deliver(c: Claimed, secret: string, r: SendResult): Promise<void> {
	let p: Prepared;
	try {
		p = await withUser(c.user_id, (db) => prepareOne(db, c, secret));
	} catch (err) {
		console.error(JSON.stringify({ event: 'alert_prepare_failed', eventId: c.event_id, ...safeError(err) }));
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	if ('skip' in p) {
		await finish(c, 'skipped', p.skip);
		r.skipped++;
		return;
	}
	try {
		await sendMail(p.mail);
	} catch (err) {
		console.error(JSON.stringify({ event: 'alert_send_failed', eventId: c.event_id, ...safeError(err) }));
		await finish(c, 'retry', failureReason(err));
		r.failed++;
		return;
	}
	await finish(c, 'sent');
	r.sent++;
}

/**
 * One person's digest lines of one project (newest first): one email. The
 * first DIGEST_MAX_LINES the person may still read are written out, each
 * checked as for an immediate mail; the rest are counted ("and N more"),
 * after one check of the person's choice per kind and one RLS read of the
 * events, and marked sent with the email.
 */
async function deliverDigest(lines: Claimed[], secret: string, r: SendResult): Promise<void> {
	const first = lines[0]!;
	type Ready = { mail: Mail; used: Claimed[]; skipped: { c: Claimed; why: string }[] } | { skip: string };
	let ready: Ready;
	try {
		ready = await withUser(first.user_id, async (db): Promise<Ready> => {
			const ctx = await context(db, first.project_id);
			if (typeof ctx === 'string') return { skip: ctx };
			const items: AlertFacts[] = [];
			const used: Claimed[] = [];
			const skipped: { c: Claimed; why: string }[] = [];
			let i = 0;
			for (; i < lines.length && items.length < DIGEST_MAX_LINES; i++) {
				const c = lines[i]!;
				const f = await facts(db, c);
				if (typeof f === 'string') skipped.push({ c, why: f });
				else {
					items.push(f);
					used.push(c);
				}
			}
			const rest = await countable(db, lines.slice(i));
			used.push(...rest.counted);
			skipped.push(...rest.skipped);
			if (!items.length) return { skip: skipped[0]?.why ?? 'nothing to send' };
			const token = await subscriptionToken(db, first.project_id, 'all', null, 'immediate', secret);
			const mail = digestMail(
				ctx.recipient,
				ctx.project,
				items,
				{ pageUrl: unsubscribePageUrl(token), oneClickUrl: oneClickUrl(token) },
				dailyCap(),
				rest.counted.length
			);
			return { mail, used, skipped };
		});
	} catch (err) {
		console.error(JSON.stringify({ event: 'alert_digest_prepare_failed', userId: first.user_id, ...safeError(err) }));
		for (const c of lines) await finish(c, 'retry', failureReason(err));
		r.failed += lines.length;
		return;
	}
	if ('skip' in ready) {
		for (const c of lines) await finish(c, 'skipped', ready.skip);
		r.skipped += lines.length;
		return;
	}
	for (const s of ready.skipped) await finish(s.c, 'skipped', s.why);
	r.skipped += ready.skipped.length;
	try {
		await sendMail(ready.mail);
	} catch (err) {
		console.error(JSON.stringify({ event: 'alert_digest_send_failed', userId: first.user_id, ...safeError(err) }));
		for (const c of ready.used) await finish(c, 'retry', failureReason(err));
		r.failed += ready.used.length;
		return;
	}
	for (const c of ready.used) await finish(c, 'sent');
	r.sent += ready.used.length;
	r.digests++;
}

/**
 * The digest lines past DIGEST_MAX_LINES, as the recipient: the ones they may
 * still read and still get (counted in "and N more"), and the rest (skipped
 * with why). One choice check per kind and farm, one RLS read for them all.
 */
async function countable(db: Db, lines: Claimed[]): Promise<{ counted: Claimed[]; skipped: { c: Claimed; why: string }[] }> {
	if (!lines.length) return { counted: [], skipped: [] };
	const { rows: visible } = await db.query<{ id: string }>('SELECT id FROM alert_event WHERE id = ANY($1::uuid[])', [lines.map((c) => c.event_id)]);
	const seen = new Set(visible.map((v) => v.id));
	const modes = new Map<string, AlertMode | null>();
	const counted: Claimed[] = [];
	const skipped: { c: Claimed; why: string }[] = [];
	for (const c of lines) {
		const key = `${c.kind}/${c.node_id ?? ''}`;
		if (!modes.has(key)) {
			const { rows } = await db.query<{ mode: AlertMode | null }>('SELECT app_alert_my_mode($1, $2, $3) AS mode', [c.project_id, c.kind, c.node_id]);
			modes.set(key, rows[0]?.mode ?? null);
		}
		const mode = modes.get(key);
		if (!mode || mode === 'off') skipped.push({ c, why: mode ? 'turned this alert off' : 'no longer gets this alert' });
		else if (!seen.has(c.event_id)) skipped.push({ c, why: 'cannot see this alert' });
		else counted.push(c);
	}
	return { counted, skipped };
}

/** Send what is due (see the header). Every transport's tick ends here. */
export async function sendAlerts({ now = new Date(), limit = 100 }: { now?: Date; limit?: number } = {}): Promise<SendResult> {
	const r: SendResult = { sent: 0, skipped: 0, failed: 0, digests: 0 };
	if (!alertsEnabled()) {
		const { rows } = await withoutUser((db) => db.query<{ n: number }>("SELECT app_alert_skip_all('alerts switched off (ALERTS_ENABLED=false)') AS n"));
		r.skipped = rows[0]?.n ?? 0;
		if (r.skipped) console.warn(JSON.stringify({ event: 'alerts_disabled_skipped', deliveries: r.skipped }));
		return r;
	}
	let secret: string;
	try {
		secret = alertsTokenSecret();
	} catch (err) {
		// No way to sign unsubscribe links: send nothing (the deliveries wait), and say so loudly.
		console.error(JSON.stringify({ event: 'alerts_not_sent', reason: (err as Error).message }));
		return r;
	}
	// The digest day (from 06:00 to 06:00) is each project's own: the claims work it out from `now` and project.time_zone.
	const { rows: due } = await withoutUser((db) =>
		db.query<Claimed>(`SELECT event_id, user_id, project_id, kind, node_id FROM app_alert_claim($1, $2, $3, $4::interval)`, [limit, now, dailyCap(), LEASE])
	);
	for (const c of due) await deliver(c, secret, r);

	const { rows: digest } = await withoutUser((db) =>
		db.query<Claimed>(`SELECT event_id, user_id, project_id, kind, node_id FROM app_alert_claim_digest($1, $2, $3, $4::interval)`, [now, limit, DIGEST_CLAIM_LINES, LEASE])
	);
	const groups = new Map<string, Claimed[]>();
	for (const c of digest) {
		const key = `${c.user_id}/${c.project_id}`;
		groups.set(key, [...(groups.get(key) ?? []), c]);
	}
	for (const lines of groups.values()) await deliverDigest(lines, secret, r);
	return r;
}
