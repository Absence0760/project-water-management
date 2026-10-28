// The assistant's side sheet (issue #610), rendered to HTML with Svelte's
// server renderer from a conversation in each state: the disclaimer and the
// budget left; tool lines and the streamed text; a proposal's diff and
// reasons, with Apply only for an editor; the hourly limit's wait; the month's
// budget spent; Stop while a turn streams. The streaming itself is
// chat.svelte.test.ts's; the panel in the browser is e2e/tests/assistant.spec.ts's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus, SettingsProposal } from '#lib/api/types.js';
import AssistantPanel from './AssistantPanel.svelte';
import { AssistantChat, type AssistantTurn } from './chat.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const STATUS: Extract<AssistantStatus, { available: true }> = {
	available: true,
	provider: 'mock',
	canApply: true,
	budget: { tokensPerMonth: 1000, tokensUsed: 250, resetsAt: '2026-11-01T00:00:00Z', scope: 'project' },
	rate: { messagesPerHour: 30 },
	disclaimer: 'The assistant’s answers are advice, not model output.'
};

const PROPOSAL: SettingsProposal = {
	patch: { gr4j: { x1: 420 } },
	reasons: { gr4j: 'A larger production store damps the response to rain.' },
	summary: 'raise GR4J X1 to 420 mm',
	diff: [{ label: 'GR4J X1 (production store)', before: '350 mm', after: '420 mm' }]
};

function chat(over: Partial<{ status: AssistantStatus; turns: AssistantChat['turns']; busy: boolean; refusal: AssistantChat['refusal'] }> = {}) {
	const c = new AssistantChat({ status: async () => STATUS, send: async () => new ReadableStream() });
	c.status = over.status ?? STATUS;
	c.turns = over.turns ?? [];
	c.busy = over.busy ?? false;
	c.refusal = over.refusal ?? null;
	return c;
}

const answer = (over: Partial<AssistantTurn> = {}): AssistantTurn => ({ role: 'assistant', text: '', tools: [], proposals: [], error: null, stopped: false, done: true, ...over });
const html = (c: AssistantChat) => render(AssistantPanel, { props: { open: true, chat: c } }).body;
/** Svelte escapes text: compare against the same escaping. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

describe('AssistantPanel', () => {
	it('opens on examples, with the disclaimer and the budget left under the box', () => {
		const out = html(chat());
		expect(out).toContain('Your question');
		expect(out).toContain('For example');
		expect(out).toContain(esc(STATUS.disclaimer));
		expect(out).toMatch(/data-testid="assistant-budget"[^>]*>\s*75% of this month’s budget left/);
		expect(out).toContain('>Send</button>');
		expect(out).not.toContain('New conversation');
	});

	it('shows the disclaimer a paragraph each, with `{site}` filled in with this site’s address', () => {
		const out = html(chat({ status: { ...STATUS, disclaimer: 'Advice, not model output.\n\nSee {site}/terms.' } }));
		expect(out).toMatch(/data-testid="assistant-disclaimer"[^>]*>(<!--\[-->)?<p[^>]*>Advice, not model output\.<\/p><p[^>]*>See [^<]*\/terms\.<\/p>/);
		expect(out).not.toContain('{site}');
	});

	it('shows the question, a line for each tool and the answer', () => {
		const out = html(
			chat({
				turns: [
					{ role: 'user', text: 'Why does the simulated flow at Outflow gauge not respond to rainfall?' },
					answer({
						text: 'Outflow gauge sits below a dam that fills first.',
						tools: [
							{ name: 'get_network', label: 'Reading the network', status: 'done' },
							{ name: 'get_series', label: 'Reading a series', status: 'error' }
						]
					})
				]
			})
		);
		expect(out).toContain('Why does the simulated flow at Outflow gauge not respond to rainfall?');
		expect(out).toContain('Outflow gauge sits below a dam that fills first.');
		expect(out).toMatch(/data-tool="get_network" data-status="done"[^>]*>.*Reading the network/s);
		expect(out).toMatch(/Reading a series<span class="visually-hidden"> \(failed\)/);
		expect(out).toContain('New conversation');
		// No examples once the conversation has started.
		expect(out).not.toContain('For example');
	});

	it('shows a proposal’s diff and reasons, with Apply for an editor', () => {
		const out = html(chat({ turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: PROPOSAL, applied: false }] })] }));
		expect(out).toContain('Recommended change');
		expect(out).toContain(esc(PROPOSAL.summary));
		expect(out).toMatch(/<th scope="row">GR4J X1 \(production store\)<\/th><td>350 mm<\/td><td>420 mm<\/td>/);
		expect(out).toContain(esc(PROPOSAL.reasons.gr4j!));
		expect(out).toContain('Apply to the settings form');
	});

	it('gives a viewer the diff but no Apply', () => {
		const out = html(chat({ status: { ...STATUS, canApply: false }, turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: PROPOSAL, applied: false }] })] }));
		expect(out).toContain('420 mm');
		expect(out).not.toContain('Apply to the settings form');
		expect(out).toContain('An editor can apply this change.');
	});

	it('says an applied proposal is in the form and not saved', () => {
		const out = html(chat({ turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: PROPOSAL, applied: true }] })] }));
		expect(out).not.toContain('Apply to the settings form');
		expect(out).toContain('not saved');
	});

	it('offers Stop while a turn streams, and Thinking… before its first words', () => {
		const out = html(chat({ busy: true, turns: [{ role: 'user', text: 'Q' }, answer({ done: false })] }));
		expect(out).toContain('>Stop</button>');
		expect(out).not.toContain('>Send</button>');
		expect(out).toContain('Thinking…');
	});

	it('the hourly limit: says how long to wait, and the box takes nothing until then', () => {
		const out = html(chat({ refusal: { kind: 'rate', seconds: 600, message: 'Too many' } }));
		expect(out).toContain('limit of 30 messages an hour. Try again in about 10 min.');
		expect(out).toMatch(/<textarea[^>]*disabled/);
	});

	it('the month’s budget spent: says when it starts again, and the box takes nothing', () => {
		const out = html(chat({ status: { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000 } } }));
		expect(out).toContain('data-testid="assistant-budget-spent"');
		expect(out).toMatch(/used up\. It starts again on [^<]*2026/);
		expect(out).toMatch(/<textarea[^>]*disabled/);
		expect(out).toMatch(/0% of this month’s budget left/);
		expect(out).toContain('This project’s assistant budget for the month is used up.');
	});

	it('says whose month is spent when it is the person’s or the server’s', () => {
		expect(html(chat({ status: { ...STATUS, budget: { ...STATUS.budget, tokensUsed: 1000, scope: 'user' } } }))).toContain('Your assistant budget for the month is used up.');
		expect(html(chat({ refusal: { kind: 'budget', scope: 'total', message: 'Spent' } }))).toContain('This server’s assistant budget for the month is used up.');
	});

	it('shows a turn that ended early, and a question that wasn’t sent', () => {
		const out = html(chat({ refusal: { kind: 'error', message: 'Could not reach the server' }, turns: [{ role: 'user', text: 'Q' }, answer({ text: 'Half', error: 'The answer stopped before it finished. Ask again.', done: false })] }));
		expect(out).toContain('The answer stopped before it finished. Ask again.');
		expect(out).toContain('The question wasn’t sent: Could not reach the server');
	});
});
