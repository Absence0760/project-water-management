// The Bedrock provider with a stand-in for the runtime client (issue #610):
// ConverseStream's events as the SDK hands them over, no AWS, no network.
import type { ConverseStreamCommandInput, ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { describe, expect, it } from 'vitest';
import type { ProviderEvent, ProviderRequest } from '../types.js';
import { bedrockProvider, converseInput, toConverseMessages, type BedrockSender } from './bedrock.js';

const MODEL = 'anthropic.claude-sonnet-5-5';
const cfg = { model: MODEL, bedrockRegion: 'af-south-1' };

const req = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
	system: 'You help with a catchment model.',
	messages: [{ role: 'user', content: 'Why no response at gauge X?' }],
	tools: [{ name: 'get_series', description: 'A series', parameters: { type: 'object', properties: { node: { type: 'string' } } } }],
	maxOutputTokens: 512,
	...over
});

/** A client whose one call streams `events`, recording each command's input. */
function fake(events: ConverseStreamOutput[] | (() => AsyncIterable<ConverseStreamOutput>), sent: ConverseStreamCommandInput[] = []): BedrockSender {
	return {
		async send(command) {
			sent.push(command.input);
			const stream =
				typeof events === 'function'
					? events()
					: (async function* () {
							for (const e of events) yield e;
						})();
			return { stream };
		}
	};
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
	const out: ProviderEvent[] = [];
	for await (const e of it) out.push(e);
	return out;
}

const ev = (e: Record<string, unknown>) => e as unknown as ConverseStreamOutput;
const usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens = 0) => ev({ metadata: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadInputTokens }, metrics: { latencyMs: 1 } } });

describe('bedrock provider', () => {
	it('streams text and reports the usage from the metadata event, cached input counted', async () => {
		const sent: ConverseStreamCommandInput[] = [];
		const events = await collect(
			bedrockProvider(cfg, {
				client: fake(
					[
						ev({ messageStart: { role: 'assistant' } }),
						ev({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'The gauge ' } } }),
						ev({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'sits below a dam.' } } }),
						ev({ contentBlockStop: { contentBlockIndex: 0 } }),
						ev({ messageStop: { stopReason: 'end_turn' } }),
						usage(90, 11, 30)
					],
					sent
				)
			}).complete(req())
		);
		expect(events).toEqual([
			{ type: 'text', delta: 'The gauge ' },
			{ type: 'text', delta: 'sits below a dam.' },
			{ type: 'usage', inputTokens: 120, outputTokens: 11 }
		]);
		expect(sent[0]).toEqual({
			modelId: MODEL,
			system: [{ text: 'You help with a catchment model.' }, { cachePoint: { type: 'default' } }],
			messages: [{ role: 'user', content: [{ text: 'Why no response at gauge X?' }, { cachePoint: { type: 'default' } }] }],
			inferenceConfig: { maxTokens: 512 },
			toolConfig: { tools: [{ toolSpec: { name: 'get_series', description: 'A series', inputSchema: { json: { type: 'object', properties: { node: { type: 'string' } } } } } }] }
		});
	});

	it('caches the tools + system prompt and the turn so far: a cachePoint after the system prompt and after the newest message only', () => {
		const input = converseInput(
			'global.anthropic.claude-sonnet-5-5',
			req({
				messages: [
					{ role: 'user', content: 'q' },
					{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: {} }, { id: 't2', name: 'b', arguments: {} }] },
					{ role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
					{ role: 'tool', toolCallId: 't2', name: 'b', content: 'r2' }
				]
			})
		);
		expect(input.system).toEqual([{ text: 'You help with a catchment model.' }, { cachePoint: { type: 'default' } }]);
		// The tools come before the system prompt in Bedrock's cache order, so they carry no checkpoint of their own.
		expect(JSON.stringify(input.toolConfig)).not.toContain('cachePoint');
		expect(input.messages).toEqual([
			{ role: 'user', content: [{ text: 'q' }] },
			{ role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'a', input: {} } }, { toolUse: { toolUseId: 't2', name: 'b', input: {} } }] },
			{
				role: 'user',
				content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'r1' }] } }, { toolResult: { toolUseId: 't2', content: [{ text: 'r2' }] } }, { cachePoint: { type: 'default' } }]
			}
		]);
		// Two checkpoints of the four a request may carry.
		expect(JSON.stringify(input).match(/cachePoint/g)).toHaveLength(2);
	});

	it('sends no cachePoint to a model that isn’t Claude', () => {
		const input = converseInput('amazon.nova-pro-v1:0', req());
		expect(JSON.stringify(input)).not.toContain('cachePoint');
		expect(['anthropic.claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5-5', 'arn:aws:bedrock:af-south-1:000000000000:inference-profile/global.anthropic.claude-sonnet-5-5'].every((m) => JSON.stringify(converseInput(m, req())).includes('cachePoint'))).toBe(true);
	});

	it('counts cache reads and writes as input tokens', async () => {
		const events = await collect(
			bedrockProvider(cfg, { client: fake([ev({ metadata: { usage: { inputTokens: 20, outputTokens: 7, totalTokens: 1227, cacheReadInputTokens: 900, cacheWriteInputTokens: 300 } } })]) }).complete(req())
		);
		expect(events).toEqual([{ type: 'usage', inputTokens: 1220, outputTokens: 7 }]);
	});

	it('assembles tool calls from input deltas, after the text; JSON that doesn’t parse goes to the tool as text', async () => {
		const events = await collect(
			bedrockProvider(cfg, {
				client: fake([
					ev({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Let me look.' } } }),
					ev({ contentBlockStop: { contentBlockIndex: 0 } }),
					ev({ contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tu_1', name: 'get_series' } } } }),
					ev({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"node": "Ga' } } } }),
					ev({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'uge X"}' } } } }),
					ev({ contentBlockStop: { contentBlockIndex: 1 } }),
					ev({ contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu_2', name: 'get_run_summary' } } } }),
					ev({ contentBlockStop: { contentBlockIndex: 2 } }),
					ev({ contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: 'tu_3', name: 'get_network' } } } }),
					ev({ contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: '{"a":' } } } }),
					ev({ contentBlockStop: { contentBlockIndex: 3 } }),
					ev({ messageStop: { stopReason: 'tool_use' } }),
					usage(40, 25)
				])
			}).complete(req())
		);
		expect(events).toEqual([
			{ type: 'text', delta: 'Let me look.' },
			{ type: 'tool_call', call: { id: 'tu_1', name: 'get_series', arguments: { node: 'Gauge X' } } },
			{ type: 'tool_call', call: { id: 'tu_2', name: 'get_run_summary', arguments: {} } },
			{ type: 'tool_call', call: { id: 'tu_3', name: 'get_network', arguments: '{"a":' } },
			{ type: 'usage', inputTokens: 40, outputTokens: 25 }
		]);
	});

	it('runs no tool when a guardrail stops the answer, and says so', async () => {
		const events = await collect(
			bedrockProvider(cfg, {
				client: fake([
					ev({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tu_1', name: 'get_series' } } } }),
					ev({ contentBlockStop: { contentBlockIndex: 0 } }),
					ev({ messageStop: { stopReason: 'guardrail_intervened' } }),
					usage(10, 2)
				])
			}).complete(req())
		);
		expect(events).toEqual([
			{ type: 'text', delta: '\n\n(The model declined to continue this answer.)' },
			{ type: 'usage', inputTokens: 10, outputTokens: 2 }
		]);
	});

	it('throws on an error in the stream or from the call by its name alone, never its message', async () => {
		const inStream = await collect(
			bedrockProvider(cfg, { client: fake([ev({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'a' } } }), ev({ throttlingException: { message: 'secret detail arn:aws:iam::123456789012:role/x' } })]) }).complete(req())
		).catch((e: Error) => e);
		expect((inStream as Error).message).toBe('Bedrock is throttling this account; try again shortly.');

		const denied = Object.assign(new Error('User arn:aws:sts::123456789012:assumed-role/secret is not authorized'), { name: 'AccessDeniedException' });
		const failing: BedrockSender = {
			send: async () => {
				throw denied;
			}
		};
		const err = (await collect(bedrockProvider(cfg, { client: failing }).complete(req())).catch((e: unknown) => e)) as Error;
		expect(err.message).toContain('the role may not invoke this model');
		expect(err.message).not.toContain('123456789012');
		expect(err.cause).toBeUndefined();
	});

	it('needs a model id, and refuses before any call', async () => {
		const sent: ConverseStreamCommandInput[] = [];
		await expect(collect(bedrockProvider({ model: '', bedrockRegion: 'af-south-1' }, { client: fake([], sent) }).complete(req()))).rejects.toThrow('ASSISTANT_MODEL must name the Bedrock model');
		expect(sent).toEqual([]);
	});

	it('stops when the caller aborts, with the caller’s reason', async () => {
		const ac = new AbortController();
		const client = fake(async function* () {
			yield ev({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'partial' } } });
			// The SDK ends the stream quietly once the request is aborted.
		});
		const seen: ProviderEvent[] = [];
		const run = (async () => {
			for await (const e of bedrockProvider(cfg, { client }).complete(req({ signal: ac.signal }))) {
				seen.push(e);
				ac.abort(new Error('the reader left'));
			}
		})();
		await expect(run).rejects.toThrow('the reader left');
		expect(seen).toEqual([{ type: 'text', delta: 'partial' }]);
	});

	it('times out a call that never answers', async () => {
		const hanging: BedrockSender = {
			send: (_c, opts) =>
				new Promise((_resolve, reject) => {
					opts?.abortSignal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
				})
		};
		await expect(collect(bedrockProvider(cfg, { client: hanging, timeoutMs: 50 }).complete(req()))).rejects.toThrow('Bedrock took too long to answer.');
	});

	it('sends the turn as Converse messages: parallel results in one user message, empty text left out', () => {
		expect(
			toConverseMessages([
				{ role: 'user', content: 'q' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', arguments: { x: 1 } }, { id: 't2', name: 'b', arguments: 'not json' }] },
				{ role: 'tool', toolCallId: 't1', name: 'a', content: 'r1' },
				{ role: 'tool', toolCallId: 't2', name: 'b', content: 'r2' },
				{ role: 'assistant', content: 'Done.' }
			])
		).toEqual([
			{ role: 'user', content: [{ text: 'q' }] },
			{ role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'a', input: { x: 1 } } }, { toolUse: { toolUseId: 't2', name: 'b', input: {} } }] },
			{ role: 'user', content: [{ toolResult: { toolUseId: 't1', content: [{ text: 'r1' }] } }, { toolResult: { toolUseId: 't2', content: [{ text: 'r2' }] } }] },
			{ role: 'assistant', content: [{ text: 'Done.' }] }
		]);
		expect(converseInput(MODEL, req({ tools: [] })).toolConfig).toBeUndefined();
	});
});
