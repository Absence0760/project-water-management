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
import { withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { rank, requireRole, UUID } from '../projects/access.js';
import { assistantConfig, type AssistantConfig } from './config.js';
import { capConversation, runTurn } from './orchestrator.js';
import { createProvider } from './providers/index.js';
import { sseBody } from './sse.js';
import { ASSISTANT_TOOLS } from './tools/index.js';
import type { AssistantProvider, AssistantStatus, AssistantTool, ChatMessage } from './types.js';
import { beginTurn, chargeTurn, monthResetsAt, projectTokensUsed } from './usage.js';

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
					budget: { tokensPerMonth: cfg.tokensPerMonth, tokensUsed: await projectTokensUsed(db, id), resetsAt: monthResetsAt() },
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
					runTool: (tool, args) => withUser(userId, (db) => tool.run({ db, ...ctx }, args), { readOnly: true })
				},
				conversation!
			);
			// Charged whatever the outcome, the client gone included: the tokens were spent.
			const total = await chargeTurn(userId, id, result.inputTokens, result.outputTokens);
			if (result.end === 'aborted') return;
			out.send({ type: 'usage', inputTokens: result.inputTokens, outputTokens: result.outputTokens, tokensUsed: total ?? usedBefore + result.inputTokens + result.outputTokens, tokensPerMonth: cfg.tokensPerMonth });
			out.send({ type: 'done' });
		});
		return c.body(stream, 200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-store',
			// Tells a buffering proxy (nginx and the like) to pass each event on as it comes.
			'X-Accel-Buffering': 'no'
		});
	});
