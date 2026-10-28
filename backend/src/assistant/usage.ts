// What the assistant may spend (issue #610; 262_assistant_usage.sql,
// docs/security.md § Assistant): token budgets per UTC month, in weighted
// tokens (input + 5 × output, config.ts weightedTokens), per project
// (cfg.tokensPerMonth), per person across projects (cfg.tokensPerUserMonth)
// and for the whole deployment (cfg.tokensTotalPerMonth), and a message cap
// per person per hour across projects (cfg.messagesPerHour). A turn is begun
// before its stream starts, in the transaction that checked the caller's
// role: counted as a message, and its budget reserved
// (264_assistant_reservation: what no cap is passed by, however many turns
// run at once). It is charged its tokens after it ends, whatever the
// outcome, which settles the reservation; one never settled (the Lambda
// died) is charged in full once it expires.
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

/** This UTC month's weighted tokens (config.ts weightedTokens): the project's, the caller's across projects, the deployment's. */
export interface MonthUsed {
	project: number;
	user: number;
	total: number;
}

/** Which cap a budget is: the project's month, the person's, or the deployment's. */
export type BudgetScope = 'project' | 'user' | 'total';

/**
 * The cap nearest its end, for the panel's "share of the budget left": the one
 * with the fewest tokens left (ties go to the widest, which is the one that
 * refuses first, as app_assistant_begin checks the deployment's first).
 */
export function bindingBudget(
	cfg: Pick<AssistantConfig, 'tokensPerMonth' | 'tokensPerUserMonth' | 'tokensTotalPerMonth'>,
	used: MonthUsed
): { scope: BudgetScope; tokensPerMonth: number; tokensUsed: number } {
	const caps: { scope: BudgetScope; tokensPerMonth: number; tokensUsed: number }[] = [
		{ scope: 'total', tokensPerMonth: cfg.tokensTotalPerMonth, tokensUsed: used.total },
		{ scope: 'user', tokensPerMonth: cfg.tokensPerUserMonth, tokensUsed: used.user },
		{ scope: 'project', tokensPerMonth: cfg.tokensPerMonth, tokensUsed: used.project }
	];
	return caps.reduce((a, b) => (b.tokensPerMonth - b.tokensUsed < a.tokensPerMonth - a.tokensUsed ? b : a));
}

type UsedRow = { project_used: string | null; user_used: string | null; total_used: string | null };
const monthUsed = (r: UsedRow | undefined): MonthUsed => ({ project: Number(r?.project_used ?? 0), user: Number(r?.user_used ?? 0), total: Number(r?.total_used ?? 0) });

/** This month's tokens (the caller is a viewer or above; the route checked). */
export async function tokensUsed(db: Db, projectId: string): Promise<MonthUsed> {
	const { rows } = await db.query<UsedRow>('SELECT project_used, user_used, total_used FROM app_assistant_used($1)', [projectId]);
	return monthUsed(rows[0]);
}

/** The refusal for a spent month, by the cap that refused. */
const SPENT: Record<BudgetScope, { code: 'assistant_budget_spent' | 'assistant_user_budget_spent' | 'assistant_total_budget_spent'; what: string }> = {
	project: { code: 'assistant_budget_spent', what: 'This project has used its assistant budget for the month' },
	user: { code: 'assistant_user_budget_spent', what: 'You have used your assistant budget for the month, across your projects' },
	total: { code: 'assistant_total_budget_spent', what: 'The assistant has used this server’s budget for the month' }
};

/**
 * Seconds past the turn's deadline (cfg.turnSeconds) a reservation lasts
 * before it is charged in full as unsettled: past the assistant Lambda's
 * timeout (the deadline + 15 s, infra/assistant.tf), so a turn that ends
 * normally always settles first, and only a Lambda that died leaves one.
 */
export const RESERVATION_MARGIN_SECONDS = 120;

/** A begun turn: this month's tokens before it, and the budget reserved for it. */
export interface BegunTurn {
	used: MonthUsed;
	/** The reservation app_assistant_charge settles (chargeTurn). */
	reservationId: string;
	/** Weighted tokens the turn may spend (runTurn's budget). */
	budget: number;
}

/**
 * Begin one turn as the transaction's user: counts the message and reserves
 * the turn's budget (the least of cfg.maxTurnTokens and what each monthly cap
 * has left), or throws 429 with Retry-After (`assistant_rate_limited` past
 * the hourly cap; once a month has less than `minTokens` left
 * `assistant_total_budget_spent` for the deployment's,
 * `assistant_user_budget_spent` for the person's, `assistant_budget_spent`
 * for the project's; nothing counted). `minTokens` is the turn's floor
 * (orchestrator.ts turnFloor), no more than cfg.maxTurnTokens.
 */
export async function beginTurn(
	c: Context,
	db: Db,
	projectId: string,
	cfg: Pick<AssistantConfig, 'tokensPerMonth' | 'tokensPerUserMonth' | 'tokensTotalPerMonth' | 'messagesPerHour' | 'maxTurnTokens' | 'turnSeconds'>,
	minTokens: number
): Promise<BegunTurn> {
	const { rows } = await db.query<
		UsedRow & { outcome: 'ok' | 'rate' | 'budget' | 'user_budget' | 'total_budget'; wait_seconds: number; reservation_id: string | null; budget: string | null }
	>(
		'SELECT outcome, wait_seconds, project_used, user_used, total_used, reservation_id, budget FROM app_assistant_begin($1, $2, $3, $4, $5, $6, $7, $8)',
		[
			projectId,
			cfg.tokensPerMonth,
			cfg.messagesPerHour,
			cfg.tokensPerUserMonth,
			cfg.tokensTotalPerMonth,
			cfg.maxTurnTokens,
			Math.ceil(minTokens),
			cfg.turnSeconds + RESERVATION_MARGIN_SECONDS
		]
	);
	const r = rows[0]!;
	if (r.outcome === 'rate') {
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, 'assistant_rate_limited', `You have sent ${cfg.messagesPerHour} messages to the assistant in the last hour; try again in ${Math.ceil(r.wait_seconds / 60)} min.`, {
			seconds: r.wait_seconds
		});
	}
	if (r.outcome !== 'ok') {
		const scope: BudgetScope = r.outcome === 'budget' ? 'project' : r.outcome === 'user_budget' ? 'user' : 'total';
		c.header('Retry-After', String(r.wait_seconds));
		throw ApiError.coded(429, SPENT[scope].code, `${SPENT[scope].what}; it starts again on ${monthResetsAt().slice(0, 10)}.`, { seconds: r.wait_seconds, scope });
	}
	return { used: monthUsed(r), reservationId: r.reservation_id!, budget: Number(r.budget) };
}

/**
 * Charge a finished turn's tokens to the caller's row and settle its
 * reservation (null: a charge with no reservation, this month). Returns this
 * month's tokens after it, or null if the charge failed (logged as
 * `assistant_charge_failed`, not thrown: the answer is already sent; the
 * assistant's charge-failed alarm reads that line, infra/alarms.tf). A
 * reservation left by a failed charge is charged in full once it expires.
 */
export async function chargeTurn(
	userId: string,
	projectId: string,
	reservationId: string | null,
	inputTokens: number,
	outputTokens: number
): Promise<MonthUsed | null> {
	try {
		return await withUser(userId, async (db) => {
			const { rows } = await db.query<UsedRow>('SELECT project_used, user_used, total_used FROM app_assistant_charge($1, $2, $3, $4)', [
				projectId,
				reservationId,
				Math.max(0, Math.round(inputTokens)),
				Math.max(0, Math.round(outputTokens))
			]);
			return monthUsed(rows[0]);
		});
	} catch (err) {
		logEvent('error', { event: 'assistant_charge_failed', ...safeError(err) });
		return null;
	}
}
