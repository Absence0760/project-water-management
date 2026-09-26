// SES mail suppression (057_alert_followups.sql, mail/suppression.ts): a
// permanent bounce or a complaint flags the address, its alert emails pause
// (no deliveries made, waiting ones skipped, one already claimed skipped at
// send time), /auth/me says so for the banner, and the person turns mail back
// on (POST /me/alerts/resume) with their choices as they were. Every "gets
// nothing" check has a positive control.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { outbox } from '../mail/transport.js';
import { acceptMailEvent } from '../mail/suppression.js';
import { simulatedSesEvent } from '../../scripts/mail-bounce.js';
import { sendAlerts, SUPPRESSED } from './send.js';

// releaseAddress is a no-op without SES; counted here, so a test can see how many resumes reached it.
const released = vi.hoisted(() => ({ n: 0 }));
vi.mock('../mail/suppression.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../mail/suppression.js')>()),
	releaseAddress: async () => {
		released.n++;
	}
}));

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let other: User;
let projectId: string;

const event = (u: { email: string }, kind: 'bounce' | 'complaint' | 'transient', at = new Date()) => JSON.stringify(simulatedSesEvent(u.email, kind, at));
const me = async (u: User) => (await u.call('GET', '/auth/me')).body.user as { mailSuppressed: { reason: string; at: string } | null };
const recipients = (kind = 'job_dead') =>
	withoutUser(async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM app_alert_recipients($1, $2, NULL)', [projectId, kind])).rows.map((r) => r.user_id));
const clear = (u: User) => asOwner('UPDATE app_user SET mail_suppressed_at = NULL, mail_suppressed_reason = NULL, mail_resumed_at = NULL WHERE id = $1', [u.id]);

/** A job_dead delivery for `u` (as the schema owner: the queue is not what's under test). */
async function delivery(u: User, status: 'pending' | 'digest' = 'pending') {
	const [rule] = await asOwner(
		`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 1)
		 ON CONFLICT (project_id, kind, node_id, feed_id) DO UPDATE SET threshold = 1 RETURNING id`,
		[projectId]
	);
	await asOwner(`UPDATE alert_event SET state = 'cleared' WHERE rule_id = $1 AND state = 'firing'`, [rule.id]);
	const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'firing', 1, '{"count":1}') RETURNING id`, [rule.id, projectId]);
	await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status) VALUES ($1, $2, $3, 'immediate', $4)`, [e.id, u.id, projectId, status]);
	return e.id as string;
}
const deliveryOf = async (eventId: string, u: User) => (await asOwner('SELECT status, reason FROM alert_delivery WHERE event_id = $1 AND user_id = $2', [eventId, u.id]))[0];

beforeAll(async () => {
	[owner, other] = await Promise.all([signUp('Sowner'), signUp('Sother')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Suppression' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: other.email, role: 'owner' })).status).toBe(201);
});

afterAll(async () => {
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('a bounce or complaint pauses the address’s alerts', () => {
	it('a permanent bounce flags the person, drops them from the recipients and skips what was waiting for them (positive control first)', async () => {
		await clear(owner);
		expect(await recipients()).toEqual(expect.arrayContaining([owner.id, other.id]));
		const waiting = await delivery(owner, 'digest');
		expect(await acceptMailEvent(event(owner, 'bounce'))).toEqual({ reason: 'bounce', suppressed: 1 });
		expect((await me(owner)).mailSuppressed).toMatchObject({ reason: 'bounce' });
		expect(await recipients()).not.toContain(owner.id);
		// The other owner is untouched.
		expect(await recipients()).toContain(other.id);
		expect((await me(other)).mailSuppressed).toBeNull();
		expect(await deliveryOf(waiting, owner)).toEqual({ status: 'skipped', reason: 'the address is suppressed (bounce)' });
		// A repeat keeps the first date and flags nobody new.
		const first = (await me(owner)).mailSuppressed!.at;
		expect(await acceptMailEvent(event(owner, 'complaint'))).toEqual({ reason: 'complaint', suppressed: 0 });
		expect((await me(owner)).mailSuppressed).toEqual({ reason: 'bounce', at: first });
	});

	it('matches the address case-insensitively; a complaint flags too; a transient bounce and an unknown address flag nobody', async () => {
		await clear(owner);
		expect(await acceptMailEvent(event({ email: 'nobody-here@example.com' }, 'bounce'))).toEqual({ reason: 'bounce', suppressed: 0 });
		expect(await acceptMailEvent(event(owner, 'transient'))).toBe('ignored');
		expect((await me(owner)).mailSuppressed).toBeNull();
		expect(await acceptMailEvent(event({ email: owner.email.toUpperCase() }, 'complaint'))).toEqual({ reason: 'complaint', suppressed: 1 });
		expect((await me(owner)).mailSuppressed).toMatchObject({ reason: 'complaint' });
		await clear(owner);
	});

	it('skips a delivery already claimed for a person flagged since, at send time (positive control: the other owner’s goes)', async () => {
		await clear(owner);
		const e = await delivery(owner);
		await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [e, other.id, projectId]);
		// Flagged after the fan-out, straight in the table (the function would have skipped it already).
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [owner.id]);
		const before = outbox.length;
		await sendAlerts();
		expect(await deliveryOf(e, owner)).toEqual({ status: 'skipped', reason: SUPPRESSED });
		expect(await deliveryOf(e, other)).toMatchObject({ status: 'sent' });
		expect(outbox.slice(before).map((m) => m.to)).toEqual([other.email]);
		await clear(owner);
	});

	it('only the worker’s own context records a suppression', async () => {
		await expect(withUser(owner.id, (db) => db.query("SELECT app_mail_suppress($1, 'bounce', NULL)", [other.email]))).rejects.toMatchObject({ code: '42501' });
		await expect(withoutUser((db) => db.query("SELECT app_mail_suppress($1, 'spam', NULL)", [other.email]))).rejects.toMatchObject({ code: '22023' });
		expect((await me(other)).mailSuppressed).toBeNull();
	});
});

describe('turning mail back on (POST /me/alerts/resume)', () => {
	it('clears the caller’s own flag only, keeps their choices, and an event about a mail sent before is stale', async () => {
		await clear(owner);
		await clear(other);
		expect((await owner.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'job_dead', mode: 'daily_digest' }] })).status).toBe(200);
		expect(await acceptMailEvent(event(owner, 'bounce'))).toMatchObject({ suppressed: 1 });
		expect(await acceptMailEvent(event(other, 'bounce'))).toMatchObject({ suppressed: 1 });
		const sentBefore = new Date(Date.now() - 60_000);
		const res = await owner.call('POST', '/me/alerts/resume');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ mailSuppressed: null });
		expect((await me(owner)).mailSuppressed).toBeNull();
		expect((await me(other)).mailSuppressed).not.toBeNull();
		expect(await recipients()).toContain(owner.id);
		// The digest choice made before the bounce is still theirs.
		const mode = await withUser(owner.id, async (db) => (await db.query<{ mode: string }>("SELECT app_alert_my_mode($1, 'job_dead', NULL) AS mode", [projectId])).rows[0]!.mode);
		expect(mode).toBe('daily_digest');
		// SES reporting a mail sent before the resume flags nobody; one sent after does.
		expect(await acceptMailEvent(event(owner, 'bounce', sentBefore))).toMatchObject({ suppressed: 0 });
		expect((await me(owner)).mailSuppressed).toBeNull();
		expect(await acceptMailEvent(event(owner, 'bounce', new Date(Date.now() + 1000)))).toMatchObject({ suppressed: 1 });
		// Bounced again within a day of turning it back on: wait until tomorrow.
		const again = await owner.call('POST', '/me/alerts/resume');
		expect(again.status).toBe(429);
		expect(again.body.code).toBe('alerts_resume_throttled');
		expect((await me(owner)).mailSuppressed).not.toBeNull();
		// A day later it works again.
		await asOwner(`UPDATE app_user SET mail_resumed_at = now() - interval '25 hours' WHERE id = $1`, [owner.id]);
		expect((await owner.call('POST', '/me/alerts/resume')).status).toBe(200);
		expect((await me(owner)).mailSuppressed).toBeNull();
		// Nothing to resume is harmless.
		expect((await owner.call('POST', '/me/alerts/resume')).status).toBe(200);
		await clear(owner);
		await clear(other);
	});

	it('lets only one of two resumes at once through the day’s limit (checked and stamped in one UPDATE)', async () => {
		await clear(owner);
		// Resumed more than a day ago, then bounced again: one resume is due.
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce', mail_resumed_at = now() - interval '25 hours' WHERE id = $1`, [owner.id]);
		released.n = 0;
		const statuses = (await Promise.all([owner.call('POST', '/me/alerts/resume'), owner.call('POST', '/me/alerts/resume')])).map((r) => r.status).sort();
		// The second either waited and saw it done (200, nothing to resume) or lost the day's slot (429); never two resumes.
		expect(statuses[0]).toBe(200);
		const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM app_user WHERE id = $1 AND mail_suppressed_at IS NULL AND mail_resumed_at > now() - interval '1 minute'`, [owner.id]);
		expect(n).toBe(1);
		// Only one of them took the address off SES's list.
		expect(released.n).toBe(1);
		// Bounced again: the day's resume is spent.
		await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce' WHERE id = $1`, [owner.id]);
		expect((await owner.call('POST', '/me/alerts/resume')).status).toBe(429);
		await clear(owner);
	});
});
