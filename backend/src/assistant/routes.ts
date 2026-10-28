// The assistant (issue #610; docs/api.md § Assistant, docs/architecture.md §
// Assistant):
//
//   GET  /projects/:id/assistant            on or off, the budget left, whether the caller may Apply (viewer)
//   POST /projects/:id/assistant/messages   one turn: text/event-stream of AssistantStreamEvents (viewer)
//
// Viewers and above chat (requireRole 'viewer' also shuts out farmers and
// contributors); applying a proposal is the Settings page's Save, which needs
// an editor, so `canApply` only tells the panel whether to offer it. The
// conversation lives in the page and comes with every turn; the server keeps
// only the usage counters (usage.ts, 258_assistant_usage.sql), never the
// text. Every refusal (off, role, the hourly cap, the month's budget, an
// oversized message, a bad body) is a JSON ApiError before any stream byte.
import { DISCLAIMER } from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { logEvent } from '../logging/logEvent.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { assistantConfig, weightedTokens, type AssistantConfig } from './config.js';
import { capConversation, runTurn } from './orchestrator.js';
import { createProvider } from './providers/index.js';
import { sseBody } from './sse.js';
import { ASSISTANT_TOOLS } from './tools/index.js';
import type { AssistantProvider, AssistantStatus, AssistantTool, ChatMessage } from './types.js';
import { beginTurn, bindingBudget, chargeTurn, monthResetsAt, tokensUsed } from './usage.js';

/** Messages one request may carry; the character cap (maxInputChars) drops the oldest of them anyway. */
export const MAX_MESSAGES = 200;
/** One message's characters as the body schema takes it; the turn's own cap is cfg.maxInputChars. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Under the panel: what the answers are, then the report disclaimer (liability/disclaimer.ts). `{site}` is filled in by the page (withSite). */
export const ASSISTANT_DISCLAIMER = ['The assistant’s answers are advice, not model output, and they can be wrong.', ...DISCLAIMER.paragraphs].join('\n\n');

export const AssistantBody = z
	.object({
		messages: z
			.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_MESSAGE_CHARS) }).strict())
			.min(1)
			.max(MAX_MESSAGES)
			.refine((m) => m.at(-1)?.role === 'user' && m.at(-1)!.content.trim() !== '', 'the last message must be the user’s, and not empty'),
		runId: z.string().regex(UUID, 'runId must be a run id').optional()
	})
	.strict();

/** The provider for a config; tests swap it (setProviderFactory). */
let providerFor: (cfg: AssistantConfig) => AssistantProvider | null = createProvider;
/** The tools; tests swap them (setAssistantTools). */
let tools: readonly AssistantTool[] = ASSISTANT_TOOLS;

/** For tests: a provider other than ASSISTANT_PROVIDER's (null restores it). */
export function setProviderFactory(f: ((cfg: AssistantConfig) => AssistantProvider | null) | null): void {
	providerFor = f ?? createProvider;
}
/** For tests: other tools (null restores ASSISTANT_TOOLS). */
export function setAssistantTools(t: readonly AssistantTool[] | null): void {
	tools = t ?? ASSISTANT_TOOLS;
}

/**
 * How long one tool statement may run (SET LOCAL statement_timeout). Below the
 * 15 s between the turn's deadline and the Lambda's timeout (ASSISTANT_TURN_SECONDS,
 * infra/assistant.tf): the Lambda's pool has one connection, so a read still
 * running when the turn ends holds it until this cuts it, and the turn's charge
 * waits for it.
 */
export const TOOL_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * One tool call in its own read-only transaction as the caller, its statements
 * capped at TOOL_STATEMENT_TIMEOUT_MS. The turn's signal (its deadline, or the
 * client gone) rejects the call at once with an AbortError, so the turn ends and
 * its tokens are charged; the transaction still ends on its own, by the timeout
 * at the latest, and rolls back.
 */
export function runToolBounded<T>(userId: string, run: (db: Db) => Promise<T>, signal?: AbortSignal): Promise<T> {
	const call = withUser(
		userId,
		async (db) => {
			await db.query(`SET LOCAL statement_timeout = ${TOOL_STATEMENT_TIMEOUT_MS}`);
			return run(db);
		},
		{ readOnly: true }
	);
	if (!signal) return call;
	if (signal.aborted) {
		call.catch(() => {});
		return Promise.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			call.catch(() => {});
			reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		call.then(
			(v) => {
				signal.removeEventListener('abort', onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener('abort', onAbort);
				reject(e);
			}
		);
	});
}

const off = () => ApiError.coded(404, 'assistant_off', 'The assistant is off on this server (ASSISTANT_PROVIDER is off).');

export const assistantRoutes = new Hono<AuthEnv>()
	.get('/:id/assistant', async (c) => {
		const id = c.req.param('id');
		const cfg = assistantConfig();
		const status = await withUser(
			c.get('userId'),
			async (db): Promise<AssistantStatus> => {
				const role = await requireRole(db, id, 'viewer');
				if (cfg.provider === 'off') return { available: false };
				return {
					available: true,
					provider: cfg.provider,
					canApply: rank[role] >= rank.editor,
					budget: { ...bindingBudget(cfg, await tokensUsed(db, id)), resetsAt: monthResetsAt() },
					rate: { messagesPerHour: cfg.messagesPerHour },
					disclaimer: ASSISTANT_DISCLAIMER
				};
			},
			{ readOnly: true }
		);
		return c.json(status);
	})
	.post('/:id/assistant/messages', async (c) => {
		const body = AssistantBody.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		const cfg = assistantConfig();
		const conversation: ChatMessage[] | null = capConversation(body.messages, cfg.maxInputChars);

		const { provider, usedBefore } = await withUser(userId, async (db) => {
			await requireRole(db, id, 'viewer');
			const provider = cfg.provider === 'off' ? null : providerFor(cfg);
			if (!provider) throw off();
			if (!conversation) {
				throw ApiError.coded(413, 'assistant_input_too_large', `The message is longer than the assistant takes (${cfg.maxInputChars} characters).`);
			}
			if (body.runId) {
				const { rows } = await db.query('SELECT 1 FROM model_run WHERE id = $1 AND project_id = $2', [body.runId, id]);
				if (!rows.length) throw new ApiError(404, 'run not found');
			}
			// Counted before the stream: the message, or a 429 (nothing counted).
			return { provider, usedBefore: await beginTurn(c, db, id, cfg) };
		});

		const ctx = { userId, projectId: id, runId: body.runId ?? null };
		const stream = sseBody({ keepaliveSeconds: cfg.keepaliveSeconds, requestSignal: c.req.raw.signal }, async (out) => {
			const result = await runTurn(
				{
					provider,
					tools,
					cfg,
					emit: out.send,
					signal: out.signal,
					// Each call its own read-only transaction as the caller: RLS and the routes' withholding decide what it reads.
					runTool: (tool, args, signal) => runToolBounded(userId, (db) => tool.run({ db, ...ctx }, args), signal)
				},
				conversation!
			);
			// Charged whatever the outcome, the client gone included: the tokens were spent.
			const after = await chargeTurn(userId, id, result.inputTokens, result.outputTokens);
			const weighted = weightedTokens(result.inputTokens, result.outputTokens);
			// One line a turn, counts only (no text): the assistant's spend alarm sums weightedTokens (infra/alarms.tf).
			logEvent('info', { event: 'assistant_turn', inputTokens: result.inputTokens, outputTokens: result.outputTokens, weightedTokens: weighted, end: result.end });
			if (result.end === 'aborted') return;
			const used = after ?? { project: usedBefore.project + weighted, user: usedBefore.user + weighted, total: usedBefore.total + weighted };
			out.send({ type: 'usage', inputTokens: result.inputTokens, outputTokens: result.outputTokens, ...bindingBudget(cfg, used) });
			out.send({ type: 'done' });
		});
		return c.body(stream, 200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			// Tells a buffering proxy (nginx and the like) to pass each event on as it comes.
			'X-Accel-Buffering': 'no'
		});
	});
