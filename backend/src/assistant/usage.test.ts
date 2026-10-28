// The cap the panel shows (usage.ts bindingBudget) and the weighting every cap counts in (config.ts).
import { describe, expect, it } from 'vitest';
import { assistantConfig, OUTPUT_TOKEN_WEIGHT, weightedTokens } from './config.js';
import { bindingBudget } from './usage.js';

const caps = { tokensPerMonth: 2_000, tokensPerUserMonth: 1_000, tokensTotalPerMonth: 10_000 };

describe('bindingBudget', () => {
	it('shows the cap with the fewest tokens left', () => {
		expect(bindingBudget(caps, { project: 0, user: 0, total: 0 })).toEqual({ scope: 'user', tokensPerMonth: 1_000, tokensUsed: 0 });
		expect(bindingBudget(caps, { project: 1_900, user: 100, total: 2_000 })).toEqual({ scope: 'project', tokensPerMonth: 2_000, tokensUsed: 1_900 });
		expect(bindingBudget(caps, { project: 10, user: 10, total: 9_990 })).toEqual({ scope: 'total', tokensPerMonth: 10_000, tokensUsed: 9_990 });
	});

	it('names the widest of caps spent alike, the one the server refuses first', () => {
		expect(bindingBudget(caps, { project: 2_000, user: 1_000, total: 10_000 }).scope).toBe('total');
		expect(bindingBudget(caps, { project: 2_000, user: 1_000, total: 0 }).scope).toBe('user');
	});
});

describe('weighted tokens', () => {
	it('counts an output token as five input tokens, as Bedrock prices them', () => {
		expect(OUTPUT_TOKEN_WEIGHT).toBe(5);
		expect(weightedTokens(1_000, 100)).toBe(1_500);
	});

	it('reads the per-person and deployment caps and the turn limits, with local defaults', () => {
		expect(assistantConfig({})).toMatchObject({ tokensPerUserMonth: 1_000_000, tokensTotalPerMonth: 20_000_000, maxTurnTokens: 150_000, maxToolCallsPerHop: 4 });
		expect(
			assistantConfig({ ASSISTANT_TOKENS_PER_USER_MONTH: '7', ASSISTANT_TOKENS_PER_MONTH_TOTAL: '8', ASSISTANT_MAX_TURN_TOKENS: '9', ASSISTANT_MAX_TOOL_CALLS_PER_HOP: '2' })
		).toMatchObject({ tokensPerUserMonth: 7, tokensTotalPerMonth: 8, maxTurnTokens: 9, maxToolCallsPerHop: 2 });
	});
});
