// What the assistant may spend (issue #610; 258_assistant_usage.sql,
// docs/security.md § Assistant): a token budget per project per UTC month
// (cfg.tokensPerMonth) and a message cap per person per hour across projects
// (cfg.messagesPerHour). A turn is begun (checked and counted as a message)
// before its stream starts, in the transaction that checked the caller's
// role, and charged its tokens after it ends, whatever the outcome.
import type { Context } from 'hono';
import { withUser, type Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import type { AssistantConfig } from './config.js';

/** When this UTC month's budget starts again: the first instant of next month, ISO. */
export function monthResetsAt(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** The project's tokens this UTC month (the caller is a viewer or above; the route checked). */
export async function projectTokensUsed(db: Db, projectId: string): Promise<number> {
	const { rows } = await db.query<{ used: string | null }>('SELECT app_assistant_used($1) AS used', [projectId]);
	return Number(rows[0]?.used ?? 0);
}

/**
 * Begin one turn as the transaction's user: counts the message, or throws
 * 429 with Retry-After (`assistant_rate_limited` past the hourly cap,
 * `assistant_budget_spent` once the project's month is spent; nothing
 * counted). Returns the project's tokens used so far this month.
 */
export async function beginTurn(c: Context, db: Db, projectId: string, cfg: Pick<AssistantConfig, 'tokensPerMonth' | 'messagesPerHour'>): Promise<number> {
	const { rows } = await db.query<{ outcome: 'ok' | 'rate' | 'budget'; wait_seconds: number; tokens_used: string }>(
		'SELECT outcome, wait_seconds, tokens_used FROM app_assistant_begin($1, $2, $3)',
		[projectId, cfg.tokensPerMonth, cfg.messagesPerHour]
	);
	const r = rows[0]!;
	if (r.outcome === 'rate') {
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, 'assistant_rate_limited', `You have sent ${cfg.messagesPerHour} messages to the assistant in the last hour; try again in ${Math.ceil(r.wait_seconds / 60)} min.`, {
			seconds: r.wait_seconds
		});
	}
	if (r.outcome === 'budget') {
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, 'assistant_budget_spent', `This project has used its assistant budget for the month (${cfg.tokensPerMonth} tokens); it starts again on ${monthResetsAt().slice(0, 10)}.`, {
			seconds: r.wait_seconds
		});
	}
	return Number(r.tokens_used);
}

/**
 * Charge a finished turn's tokens to the caller's row this month. Returns
 * the project's month total after it, or null if the charge failed (logged,
 * not thrown: the answer is already sent; the error alarm counts it).
 */
export async function chargeTurn(userId: string, projectId: string, inputTokens: number, outputTokens: number): Promise<number | null> {
	try {
		return await withUser(userId, async (db) => {
			const { rows } = await db.query<{ total: string }>('SELECT app_assistant_charge($1, $2, $3) AS total', [
				projectId,
				Math.max(0, Math.round(inputTokens)),
				Math.max(0, Math.round(outputTokens))
			]);
			return Number(rows[0]!.total);
		});
	} catch (err) {
		logEvent('error', { event: 'assistant_charge_failed', ...safeError(err) });
		return null;
	}
}
