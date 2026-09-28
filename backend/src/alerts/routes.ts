// Alert routes (roadmap WP-2.13, docs/api.md § Alerts):
//
//   GET  /me/alerts                       your alert choices, per project and kind
//   PUT  /me/alerts/:projectId            change them (immediate / daily / off)
//   POST /me/alerts/resume                turn alert mail back on after SES suppressed the address
//   GET  /projects/:id/alert-rules        the project's rules (editor)
//   PUT  /projects/:id/alert-rules        switch kinds on and set thresholds (editor)
//   GET  /projects/:id/alert-events       firing (or recent) alerts, as RLS lets the caller see them (farmer+)
//   POST /alerts/unsubscribe              public: the token is the credential
//
// Everything signed-in runs as the caller under RLS (051_alerts.sql). The
// unsubscribe route runs with no user, through app_alert_unsubscribe, and
// can only turn its own token's subscription off.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { parseToken } from '../auth/tokens.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { recordAudit } from '../history/record.js';
import { releaseAddress } from '../mail/suppression.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { wakeWorker } from '../jobs/wake.js';
import { SOURCES, type FeedSource } from '../feeds/config.js';
import { rank, requireRole, UUID, type Role } from '../projects/access.js';
import { feedLabel } from './evaluate.js';
import { queueAlertEval } from './queue.js';
import { ALERT_KINDS, ALERT_MODES, DEFAULT_THRESHOLDS, defaultMode, THRESHOLD, type AlertKind, type AlertMode } from './rules.js';
import { newNonce } from './tokens.js';

// ---------------------------------------------------------------------------
// Preferences (/me/alerts)
// ---------------------------------------------------------------------------

/** One choice on the preferences page. */
export interface AlertChoice {
	kind: AlertKind;
	/** A farmer's farm (dam alerts are per farm for farmers); null for a kind-wide choice. */
	nodeId: string | null;
	nodeName: string | null;
	/** What you get now. */
	mode: AlertMode;
	/** What your role gets by default. */
	defaultMode: AlertMode;
	/** You chose it (a row), rather than the default. */
	chosen: boolean;
	/** The project has this alert switched on (a rule): off, you get nothing whatever you choose. */
	ruleOn: boolean;
	/**
	 * A farm's dam alert: the level it warns below, a fraction of the dam
	 * (0.3 = 30 %), the WUA's rule for that farm (issue #51); null for every
	 * other choice, and for a farm with no rule.
	 */
	threshold: number | null;
}

export interface ProjectAlerts {
	id: string;
	name: string;
	role: Exclude<Role, 'contributor'>;
	/** Every alert email for this project is off (the digest's one-click unsubscribe). */
	muted: boolean;
	choices: AlertChoice[];
}

const KindOrAll = z.enum([...ALERT_KINDS, 'all']);
export const PreferencesBody = z
	.object({
		items: z
			.array(z.object({ kind: KindOrAll, nodeId: z.string().regex(UUID).nullable().optional(), mode: z.enum(ALERT_MODES) }).strict())
			.min(1)
			.max(100)
	})
	.strict();

/** The kinds a role sees on the page, farm by farm for a farmer's dam alerts. */
async function projectAlerts(db: Db, p: { id: string; name: string; role: Role }): Promise<ProjectAlerts> {
	const role = p.role as Exclude<Role, 'contributor'>;
	const farms =
		role === 'farmer'
			? (await db.query<{ id: string; name: string }>('SELECT id, name FROM node WHERE project_id = $1 AND id IN (SELECT app_farm_nodes($1)) ORDER BY sort_order, name', [p.id])).rows
			: [];
	const slots: { kind: AlertKind; nodeId: string | null; nodeName: string | null; defaultMode: AlertMode }[] = [];
	for (const kind of ALERT_KINDS) {
		const d = defaultMode(role, kind);
		if (!d) continue;
		if (kind === 'dam_below' && role === 'farmer') for (const f of farms) slots.push({ kind, nodeId: f.id, nodeName: f.name, defaultMode: d });
		else slots.push({ kind, nodeId: null, nodeName: null, defaultMode: d });
	}
	// One query for every slot's effective mode (the audience's own rule), its row and its rule.
	const { rows } = await db.query<{ i: number; mode: AlertMode | null; chosen: boolean; rule_on: boolean; threshold: number | null }>(
		`SELECT s.i, app_alert_my_mode($1, s.kind, s.node) AS mode,
			(SELECT r.threshold FROM alert_rule r WHERE r.project_id = $1 AND r.kind = 'dam_below' AND s.kind = 'dam_below' AND r.node_id = s.node) AS threshold,
			EXISTS (SELECT 1 FROM alert_subscription a WHERE a.user_id = app_current_user_id() AND a.project_id = $1
				AND a.kind = s.kind AND a.node_id IS NOT DISTINCT FROM s.node) AS chosen,
			EXISTS (SELECT 1 FROM alert_rule r WHERE r.project_id = $1 AND r.kind = s.kind AND r.enabled
				AND (s.node IS NULL OR r.node_id = s.node)) AS rule_on
		 FROM unnest($2::text[], $3::uuid[]) WITH ORDINALITY AS s(kind, node, i)`,
		[p.id, slots.map((s) => s.kind), slots.map((s) => s.nodeId)]
	);
	const byI = new Map(rows.map((r) => [Number(r.i), r]));
	const { rows: muted } = await db.query<{ muted: boolean }>(
		`SELECT EXISTS (SELECT 1 FROM alert_subscription WHERE user_id = app_current_user_id() AND project_id = $1 AND kind = 'all' AND mode = 'off') AS muted`,
		[p.id]
	);
	return {
		id: p.id,
		name: p.name,
		role,
		muted: muted[0]?.muted === true,
		choices: slots.map((s, i) => {
			const r = byI.get(i + 1);
			return { ...s, mode: r?.mode ?? s.defaultMode, chosen: r?.chosen ?? false, ruleOn: r?.rule_on ?? false, threshold: r?.threshold ?? null };
		})
	};
}

/** The projects the caller can get alerts for: every one they can open, bar an applicant's. */
async function myProjects(db: Db, projectId?: string): Promise<{ id: string; name: string; role: Role }[]> {
	const { rows } = await db.query<{ id: string; name: string; role: Role }>(
		`SELECT p.id, p.name, app_project_role(p.id)::text AS role FROM project p
		 WHERE app_has_role(p.id, 'farmer') AND app_project_role(p.id) <> 'contributor' AND ($1::uuid IS NULL OR p.id = $1)
		 ORDER BY p.name, p.id`,
		[projectId ?? null]
	);
	return rows;
}

/**
 * After turning mail back on, a person waits this long before they can do it
 * again: an address that keeps bouncing costs the sending account its SES
 * reputation, so a bounce loop is held to one mail a day.
 */
export const RESUME_GAP_HOURS = 24;

/**
 * POST /me/alerts/resume: SES suppressed the caller's address (a bounce or a
 * complaint, mail/suppression.ts), and they have fixed it. Takes the address
 * off SES's suppression list (MAIL_TRANSPORT=ses; nothing locally), then
 * clears the flag, so their alert choices apply again as they were. Only the
 * caller's own flag. 429 within RESUME_GAP_HOURS of the last resume (checked
 * and stamped in one UPDATE, so parallel calls can't both pass).
 */
async function resumeMail(userId: string): Promise<void> {
	// Claim the day's resume in one conditional UPDATE, so two calls at once
	// can't both pass the check: only one stamps mail_resumed_at.
	const claim = await withUser(userId, async (db) => {
		const { rows } = await db.query<{ email: string; previous: Date | null; claimed: Date }>(
			`WITH old AS (SELECT id, mail_resumed_at FROM app_user WHERE id = app_current_user_id() FOR UPDATE)
			 UPDATE app_user u SET mail_resumed_at = clock_timestamp()
			 FROM old
			 WHERE u.id = old.id AND u.mail_suppressed_at IS NOT NULL
			   AND (old.mail_resumed_at IS NULL OR old.mail_resumed_at <= now() - make_interval(hours => $1))
			 RETURNING u.email::text AS email, old.mail_resumed_at AS previous, u.mail_resumed_at AS claimed`,
			[RESUME_GAP_HOURS]
		);
		if (rows[0]) return rows[0];
		const { rows: me } = await db.query<{ suppressed: boolean }>('SELECT mail_suppressed_at IS NOT NULL AS suppressed FROM app_user WHERE id = app_current_user_id()');
		return me[0]?.suppressed ? ('too soon' as const) : null;
	});
	if (claim === null) return;
	if (claim === 'too soon') throw ApiError.coded(429, 'alerts_resume_throttled', 'you turned alert emails back on less than a day ago and the address was refused again: check it, then try again tomorrow');
	try {
		await releaseAddress(claim.email);
	} catch (err) {
		// The flag stays (mail would be dropped and bounce again), and the day's resume is given back: a 500, without the SDK's text.
		await withUser(userId, (db) =>
			db.query('UPDATE app_user SET mail_resumed_at = $1 WHERE id = app_current_user_id() AND mail_resumed_at = $2', [claim.previous, claim.claimed])
		);
		console.error(JSON.stringify({ event: 'mail_release_failed', userId, error: (err as { name?: string }).name ?? 'Error' }));
		throw new Error('releasing the address from the SES suppression list failed');
	}
	await withUser(userId, (db) =>
		db.query(`UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL WHERE id = app_current_user_id() AND mail_suppressed_at IS NOT NULL`)
	);
}

export const meAlertRoutes = new Hono<AuthEnv>()
	.post('/alerts/resume', async (c) => {
		await resumeMail(c.get('userId'));
		return c.json({ mailSuppressed: null });
	})
	.get('/alerts', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const projects = [];
			for (const p of await myProjects(db)) projects.push(await projectAlerts(db, p));
			return c.json({ projects });
		})
	)
	.put('/alerts/:projectId', async (c) => {
		const body = PreferencesBody.parse(await readJson(c));
		const id = c.req.param('projectId');
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'farmer');
			if (role === 'contributor') throw new ApiError(403, 'applicants get no alerts');
			const project = (await myProjects(db, id))[0]!;
			const myFarms = new Set((await db.query<{ id: string }>('SELECT app_farm_nodes($1) AS id', [id])).rows.map((r) => r.id));
			for (const item of body.items) {
				const nodeId = item.nodeId ?? null;
				if (item.kind === 'all') {
					if (nodeId || item.mode === 'daily_digest') throw new ApiError(400, '“all” is on (immediate) or off, for the whole project');
				} else {
					if (!defaultMode(role, item.kind)) throw new ApiError(400, `your role doesn’t get ${item.kind} alerts`);
					// A farmer chooses per farm (their own); everyone else once for every farm, as the page shows it.
					if (nodeId && (item.kind !== 'dam_below' || role !== 'farmer')) throw new ApiError(400, 'only a farmer’s dam alerts are per farm');
					if (role === 'farmer' && item.kind === 'dam_below' && (!nodeId || !myFarms.has(nodeId))) throw new ApiError(404, 'not found');
				}
				// Turning a choice back on draws a new nonce, so a link in an old mail can't undo it
				// (the worker stores the new token's hash with the next mail: alerts/tokens.ts).
				await db.query(
					`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce)
					 VALUES (app_current_user_id(), $1, $2, $3::uuid, $4, $5)
					 ON CONFLICT (user_id, project_id, kind, node_id) DO UPDATE SET mode = EXCLUDED.mode,
						unsubscribe_nonce = CASE WHEN alert_subscription.mode = 'off' AND EXCLUDED.mode <> 'off' THEN EXCLUDED.unsubscribe_nonce ELSE alert_subscription.unsubscribe_nonce END,
						unsubscribe_hash = CASE WHEN alert_subscription.mode = 'off' AND EXCLUDED.mode <> 'off' THEN NULL ELSE alert_subscription.unsubscribe_hash END`,
					[id, item.kind, nodeId, item.mode, newNonce()]
				);
			}
			return c.json({ project: await projectAlerts(db, project) });
		});
	});

// ---------------------------------------------------------------------------
// Rules and events (/projects/:id/…)
// ---------------------------------------------------------------------------

export interface AlertRuleView {
	/** null for a rule not saved yet (a default, off). */
	id: string | null;
	kind: AlertKind;
	nodeId: string | null;
	nodeName: string | null;
	/** The data feed a data_stale rule watches (one rule per feed, 057); null for every other kind. */
	feedId: string | null;
	/** That feed as the feeds page names it ("CHIRPS daily rainfall (Upper)"), and whether it is enabled. */
	feedName: string | null;
	feedEnabled: boolean | null;
	threshold: number;
	enabled: boolean;
	/** Firing now. */
	firing: boolean;
}

export const RulesBody = z
	.object({
		rules: z
			.array(
				z
					.object({
						kind: z.enum(ALERT_KINDS),
						nodeId: z.string().regex(UUID).nullable().optional(),
						feedId: z.string().regex(UUID).nullable().optional(),
						threshold: z.number().finite(),
						enabled: z.boolean()
					})
					.strict()
					.superRefine((r, ctx) => {
						const t = THRESHOLD[r.kind].safeParse(r.threshold);
						if (!t.success) ctx.addIssue({ code: 'custom', path: ['threshold'], message: `not a threshold for ${r.kind}` });
						if ((r.kind === 'dam_below') !== !!r.nodeId) ctx.addIssue({ code: 'custom', path: ['nodeId'], message: 'a dam alert names its farm; no other kind does' });
						if ((r.kind === 'data_stale') !== !!r.feedId) ctx.addIssue({ code: 'custom', path: ['feedId'], message: 'a data-feed alert names its feed; no other kind does' });
					})
			)
			.min(1)
			.max(500)
	})
	.strict();

/**
 * The project's rules, with a default (off, not saved) for every kind, farm
 * and feed that has none: every project-wide kind, a dam_below per farm in
 * network order, and a data_stale per data feed (at its source's default
 * level, SOURCES[source].staleAlertDays) in the feeds page's order.
 */
async function listRules(db: Db, projectId: string): Promise<AlertRuleView[]> {
	const { rows: saved } = await db.query<{ id: string; kind: AlertKind; node_id: string | null; feed_id: string | null; threshold: number; enabled: boolean; firing: boolean }>(
		`SELECT r.id, r.kind, r.node_id, r.feed_id, r.threshold, r.enabled,
			EXISTS (SELECT 1 FROM alert_event e WHERE e.rule_id = r.id AND e.state = 'firing') AS firing
		 FROM alert_rule r WHERE r.project_id = $1`,
		[projectId]
	);
	const { rows: farms } = await db.query<{ id: string; name: string }>("SELECT id, name FROM node WHERE project_id = $1 AND kind = 'farm' ORDER BY sort_order, name", [projectId]);
	const { rows: feeds } = await db.query<{ id: string; source: FeedSource; target_name: string; enabled: boolean }>(
		'SELECT id, source, target_name, enabled FROM data_feed WHERE project_id = $1 ORDER BY source, target_kind, target_name',
		[projectId]
	);
	const key = (kind: string, node: string | null, feed: string | null) => `${kind}/${node ?? ''}/${feed ?? ''}`;
	const byKey = new Map(saved.map((r) => [key(r.kind, r.node_id, r.feed_id), r]));
	const view = (
		kind: AlertKind,
		nodeId: string | null,
		nodeName: string | null,
		feed: { id: string; name: string; enabled: boolean; defaultThreshold: number } | null = null
	): AlertRuleView => {
		const r = byKey.get(key(kind, nodeId, feed?.id ?? null));
		const where = { kind, nodeId, nodeName, feedId: feed?.id ?? null, feedName: feed?.name ?? null, feedEnabled: feed?.enabled ?? null };
		return r
			? { id: r.id, ...where, threshold: r.threshold, enabled: r.enabled, firing: r.firing }
			: { id: null, ...where, threshold: feed?.defaultThreshold ?? DEFAULT_THRESHOLDS[kind], enabled: false, firing: false };
	};
	const out: AlertRuleView[] = [];
	for (const kind of ALERT_KINDS) {
		if (kind === 'dam_below') for (const f of farms) out.push(view(kind, f.id, f.name));
		else if (kind === 'data_stale')
			for (const f of feeds) out.push(view(kind, null, null, { id: f.id, name: feedLabel(f.source, f.target_name), enabled: f.enabled, defaultThreshold: SOURCES[f.source].staleAlertDays }));
		else out.push(view(kind, null, null));
	}
	return out;
}

export interface AlertEventView {
	id: string;
	kind: AlertKind;
	state: 'firing' | 'cleared';
	value: number | null;
	threshold: number;
	nodeId: string | null;
	nodeName: string | null;
	/** The feed a data_stale alert is about (its rule's); null for every other kind. */
	feedId: string | null;
	openedAt: string;
	clearedAt: string | null;
	detail: Record<string, unknown>;
}

const EventsQuery = z.object({ state: z.enum(['firing', 'all']).default('firing') });

export const alertProjectRoutes = new Hono<AuthEnv>()
	.get('/:id/alert-rules', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'editor');
			return c.json({ rules: await listRules(db, id) });
		})
	)
	.put('/:id/alert-rules', async (c) => {
		const body = RulesBody.parse(await readJson(c));
		const id = c.req.param('id');
		const { rules, job } = await withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			for (const r of body.rules) {
				const nodeId = r.nodeId ?? null;
				const feedId = r.feedId ?? null;
				if (nodeId) {
					const { rows } = await db.query("SELECT 1 FROM node WHERE id = $1 AND project_id = $2 AND kind = 'farm'", [nodeId, id]);
					if (!rows[0]) throw new ApiError(404, 'not found');
				}
				if (feedId) {
					const { rows } = await db.query('SELECT 1 FROM data_feed WHERE id = $1 AND project_id = $2', [feedId, id]);
					if (!rows[0]) throw new ApiError(404, 'not found');
				}
				await db.query(
					`INSERT INTO alert_rule (project_id, kind, node_id, feed_id, threshold, enabled) VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6)
					 ON CONFLICT (project_id, kind, node_id, feed_id) DO UPDATE SET threshold = EXCLUDED.threshold, enabled = EXCLUDED.enabled`,
					[id, r.kind, nodeId, feedId, r.threshold, r.enabled]
				);
			}
			const kinds = [...new Set(body.rules.map((r) => r.kind))];
			await recordAudit(db, id, 'alert_rules.changed', {
				rules: body.rules.length,
				kinds,
				on: body.rules.filter((r) => r.enabled).length,
				off: body.rules.filter((r) => !r.enabled).length
			});
			// Evaluate at once: a rule switched on over a figure already past it fires now.
			return { rules: await listRules(db, id), job: await queueAlertEval(db, id, 'rules') };
		});
		if (job?.created) await wakeWorker(job.id);
		return c.json({ rules });
	})
	.get('/:id/alert-events', async (c) => {
		const id = c.req.param('id');
		const q = EventsQuery.parse(c.req.query());
		return withUser(c.get('userId'), async (db) => {
			const role = await requireRole(db, id, 'farmer');
			if (role === 'contributor') return c.json({ events: [] });
			// RLS decides what the caller sees: a farmer, their farms' events and the notice events.
			const { rows } = await db.query<{
				id: string;
				kind: AlertKind;
				state: 'firing' | 'cleared';
				value: number | null;
				threshold: number;
				node_id: string | null;
				node_name: string | null;
				feed_id: string | null;
				opened_at: Date;
				cleared_at: Date | null;
				detail: Record<string, unknown>;
			}>(
				`SELECT e.id, e.kind, e.state, e.value, r.threshold, e.node_id, n.name AS node_name, r.feed_id, e.opened_at, e.cleared_at, e.detail - 'signature' AS detail
				 FROM alert_event e JOIN alert_rule r ON r.id = e.rule_id LEFT JOIN node n ON n.id = e.node_id
				 WHERE e.project_id = $1 AND ($2 = 'all' OR e.state = 'firing')
				 ORDER BY e.opened_at DESC, e.id DESC LIMIT 100`,
				[id, q.state]
			);
			const events: AlertEventView[] = rows.map((r) => ({
				id: r.id,
				kind: r.kind,
				state: r.state,
				value: r.value,
				threshold: r.threshold,
				nodeId: r.node_id,
				nodeName: r.node_name,
				feedId: r.feed_id,
				openedAt: r.opened_at.toISOString(),
				clearedAt: r.cleared_at?.toISOString() ?? null,
				detail: r.detail
			}));
			// A farmer sees their own farms' events: never a row naming another farm (RLS already refuses those).
			return c.json({ events: rank[role] < rank.viewer ? events.filter((e) => e.nodeId === null || e.nodeName !== null) : events });
		});
	});

// ---------------------------------------------------------------------------
// Unsubscribe (public)
// ---------------------------------------------------------------------------

export const UnsubscribeBody = z.object({ token: z.string().max(200) }).strict();

/** The subscription a token turns off, or null (unknown, replaced, or its person's access is gone). */
async function unsubscribe(token: string): Promise<{ kind: AlertKind | 'all'; projectName: string; nodeName: string | null } | null> {
	const hash = parseToken(token);
	if (!hash) return null;
	const { rows } = await withoutUser((db) =>
		db.query<{ kind: AlertKind | 'all'; project_name: string; node_name: string | null }>('SELECT kind, project_name, node_name FROM app_alert_unsubscribe($1)', [hash])
	);
	return rows[0] ? { kind: rows[0].kind, projectName: rows[0].project_name, nodeName: rows[0].node_name } : null;
}

const gone = () => ApiError.coded(404, 'unsubscribe_link_gone', 'this unsubscribe link is not valid any more');

/**
 * POST /alerts/unsubscribe. Two callers:
 *   - the landing page (JSON `{ token }`, the token from its URL fragment):
 *     200 with what was turned off, for the page to say so;
 *   - a mail client's RFC 8058 one-click (form body
 *     `List-Unsubscribe=One-Click`, token in `?token=`): 204.
 * Exempt from the CSRF check (app.ts): it reads no session, so a forged
 * cross-site post can do only what the token's holder could do anyway.
 */
export const alertPublicRoutes = new Hono().post('/unsubscribe', async (c) => {
	const type = c.req.header('content-type') ?? '';
	if (/^application\/json\b/i.test(type)) {
		const { token } = UnsubscribeBody.parse(await readJson(c));
		const done = await unsubscribe(token);
		if (!done) throw gone();
		return c.json({ kind: done.kind, project: { name: done.projectName }, farm: done.nodeName });
	}
	const token = c.req.query('token');
	if (!token) throw new ApiError(400, 'no token');
	if (!(await unsubscribe(token))) throw gone();
	return c.body(null, 204);
});
