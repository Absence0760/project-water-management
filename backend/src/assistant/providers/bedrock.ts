// The Bedrock provider (issue #610): a Claude model on Amazon Bedrock
// through ConverseStream (@aws-sdk/client-bedrock-runtime), streamed, with
// the assistant's tools. No key: the Lambda role's IAM permission for one
// model, reached through the VPC's bedrock-runtime interface endpoint in
// production (infra). The region is ASSISTANT_BEDROCK_REGION (else the
// Lambda's own), and ASSISTANT_MODEL is required: a Claude model id or an
// inference profile id (a cross-region profile can run the model outside
// that region, which the privacy notes record). The SDK is imported when a
// call is made, never at load. An upstream error is reported by its name
// alone, never its message.
import type { ContentBlock, ConverseStreamCommandInput, ConverseStreamOutput, Message } from '@aws-sdk/client-bedrock-runtime';
import type { AssistantConfig } from '../config.js';
import type { AssistantProvider, ProviderEvent, ProviderRequest, ToolCall, TurnMessage } from '../types.js';
import { parseArguments } from './ollama.js';

/** One model call, start to last event. */
export const BEDROCK_TIMEOUT_MS = 120_000;

/** The client's one call, so the tests can stand in for it. */
export interface BedrockSender {
	send(command: { input: ConverseStreamCommandInput }, options?: { abortSignal?: AbortSignal }): Promise<{ stream?: AsyncIterable<ConverseStreamOutput> }>;
}

/**
 * The orchestrator's turn as Converse messages: a tool result is a
 * `toolResult` block in a user message, and results that follow one another
 * share one message.
 */
export function toConverseMessages(messages: TurnMessage[]): Message[] {
	const out: Message[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			if (m.content) out.push({ role: 'user', content: [{ text: m.content }] });
		} else if (m.role === 'tool') {
			const block: ContentBlock = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } };
			const last = out[out.length - 1];
			if (last?.role === 'user' && last.content?.every((b) => b.toolResult)) last.content.push(block);
			else out.push({ role: 'user', content: [block] });
		} else {
			const content: ContentBlock[] = [];
			if (m.content) content.push({ text: m.content });
			for (const c of m.toolCalls ?? []) {
				const input = typeof c.arguments === 'object' && c.arguments !== null && !Array.isArray(c.arguments) ? c.arguments : {};
				content.push({ toolUse: { toolUseId: c.id, name: c.name, input: input as never } });
			}
			if (content.length) out.push({ role: 'assistant', content });
		}
	}
	return out;
}

/** The ConverseStream input for one hop (exported for the tests). */
export function converseInput(model: string, req: ProviderRequest): ConverseStreamCommandInput {
	return {
		modelId: model,
		system: [{ text: req.system }],
		messages: toConverseMessages(req.messages),
		inferenceConfig: { maxTokens: req.maxOutputTokens },
		...(req.tools.length
			? { toolConfig: { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters as never } } })) } }
			: {})
	};
}

/** An error this provider worded itself (so the catch passes it on as it is). */
class BedrockError extends Error {}

/** What an upstream error means to the person reading the chat, from its name. */
function upstreamError(name: string | undefined): Error {
	return new BedrockError(upstreamText(name));
}

function upstreamText(name: string | undefined): string {
	switch (name) {
		case 'AccessDeniedException':
			return 'Bedrock refused the call: the role may not invoke this model (check ASSISTANT_MODEL and its IAM permission).';
		case 'ResourceNotFoundException':
			return 'Bedrock has no such model in this region (check ASSISTANT_MODEL and ASSISTANT_BEDROCK_REGION).';
		case 'ThrottlingException':
		case 'ServiceQuotaExceededException':
			return 'Bedrock is throttling this account; try again shortly.';
		case 'ServiceUnavailableException':
		case 'ModelNotReadyException':
			return 'Bedrock is unavailable just now; try again shortly.';
		case 'ValidationException':
			return 'Bedrock refused the request as invalid.';
		case 'TimeoutError':
			return 'Bedrock took too long to answer.';
		default:
			return name ? `Bedrock failed (${name}).` : 'Bedrock could not be reached.';
	}
}

/** A stream event that is an error, as an Error, or null. */
function streamError(ev: ConverseStreamOutput): Error | null {
	if (ev.internalServerException) return upstreamError('InternalServerException');
	if (ev.modelStreamErrorException) return upstreamError('ModelStreamErrorException');
	if (ev.serviceUnavailableException) return upstreamError('ServiceUnavailableException');
	if (ev.throttlingException) return upstreamError('ThrottlingException');
	if (ev.validationException) return upstreamError('ValidationException');
	return null;
}

export interface BedrockOptions {
	/** Stands in for the BedrockRuntimeClient (tests). */
	client?: BedrockSender;
	timeoutMs?: number;
}

export function bedrockProvider(cfg?: Pick<AssistantConfig, 'model' | 'bedrockRegion'>, opts: BedrockOptions = {}): AssistantProvider {
	const model = cfg?.model ?? '';
	const region = cfg?.bedrockRegion || 'af-south-1';
	const timeoutMs = opts.timeoutMs ?? BEDROCK_TIMEOUT_MS;
	let client: BedrockSender | undefined = opts.client;
	return {
		name: 'bedrock',
		async *complete(req: ProviderRequest): AsyncIterable<ProviderEvent> {
			if (!model) throw new BedrockError('ASSISTANT_MODEL must name the Bedrock model or inference profile to call.');
			const sdk = await import('@aws-sdk/client-bedrock-runtime');
			client ??= new sdk.BedrockRuntimeClient({ region, maxAttempts: 2 }) as unknown as BedrockSender;
			const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

			const open = new Map<number, { id: string; name: string; json: string }>();
			const done: { id: string; name: string; json: string }[] = [];
			let input = 0;
			let output = 0;
			let stopReason: string | undefined;
			try {
				const res = await client.send(new sdk.ConverseStreamCommand(converseInput(model, req)), { abortSignal: signal });
				for await (const ev of res.stream ?? []) {
					const failed = streamError(ev);
					if (failed) throw failed;
					if (ev.contentBlockStart?.start?.toolUse) {
						const t = ev.contentBlockStart.start.toolUse;
						open.set(ev.contentBlockStart.contentBlockIndex ?? 0, { id: t.toolUseId ?? '', name: t.name ?? '', json: '' });
					} else if (ev.contentBlockDelta?.delta) {
						const d = ev.contentBlockDelta.delta;
						if (typeof d.text === 'string' && d.text) yield { type: 'text', delta: d.text };
						else if (d.toolUse) {
							const c = open.get(ev.contentBlockDelta.contentBlockIndex ?? 0);
							if (c) c.json += d.toolUse.input ?? '';
						}
					} else if (ev.contentBlockStop) {
						const i = ev.contentBlockStop.contentBlockIndex ?? 0;
						const c = open.get(i);
						if (c) {
							done.push(c);
							open.delete(i);
						}
					} else if (ev.messageStop) stopReason = ev.messageStop.stopReason;
					else if (ev.metadata?.usage) {
						const u = ev.metadata.usage;
						input = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0);
						output = u.outputTokens ?? 0;
					}
				}
				if (signal.aborted) throw signal.reason;
			} catch (err) {
				if (req.signal?.aborted) throw req.signal.reason;
				if (signal.aborted) throw upstreamError('TimeoutError');
				if (err instanceof BedrockError) throw err;
				throw upstreamError(err instanceof Error ? err.name : undefined);
			}

			if (stopReason === 'guardrail_intervened' || stopReason === 'content_filtered') {
				yield { type: 'text', delta: '\n\n(The model declined to continue this answer.)' };
			} else {
				for (const [n, c] of done.entries()) {
					if (!c.name) continue;
					const call: ToolCall = { id: c.id || `call_${n}`, name: c.name, arguments: parseArguments(c.json) };
					yield { type: 'tool_call', call };
				}
			}
			yield { type: 'usage', inputTokens: input, outputTokens: output };
		}
	};
}
