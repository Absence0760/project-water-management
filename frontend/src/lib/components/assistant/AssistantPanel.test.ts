// The assistant's side sheet (issue #610), rendered to HTML with Svelte's
// server renderer from a conversation in each state: the disclaimer and the
// budget left; tool lines and the streamed text; a proposal's title, changes and
// reasons, with Apply only for an editor; the hourly limit's wait; the month's
// budget spent; Stop while a turn streams. The streaming itself is
// chat.svelte.test.ts's; the panel in the browser is e2e/tests/assistant.spec.ts's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantProposal, AssistantStatus } from '#lib/api/types.js';
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

const PROPOSAL: AssistantProposal = {
	goal: 'recalibration',
	title: 'Recalibration: GR4J X1 (production store)',
	changes: [{ label: 'GR4J X1 (production store)', lines: ['GR4J X1 (production store): 350 mm → 420 mm'], reason: 'A larger production store damps the response to rain.' }],
	apply: { kind: 'settings', patch: { gr4j: { x1: 420 } } }
};

/** A management change (issue #640): two levers, tried as a scenario on the run. Invented names. */
const MANAGEMENT: AssistantProposal = {
	goal: 'outcome',
	title: 'Management change: Hill Dam: own runoff to dam; transfer Hill Dam → Valley: months',
	changes: [
		{ label: 'Hill Dam: own runoff to dam', lines: ['Hill Dam: own runoff to dam 40% → 20%'], reason: 'The dam holds back dry-year runoff.' },
		{ label: 'transfer Hill Dam → Valley: months', lines: ['Transfer Hill Dam → Valley: months Oct–Sep → Jan–Jun'], reason: 'Not in the dry season.' }
	],
	apply: { kind: 'scenario', baseRunId: 'r1', ops: [] }
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

	it('keeps the disclaimer’s first line in view and folds the rest a paragraph each, `{site}` filled in', () => {
		const out = html(chat({ status: { ...STATUS, disclaimer: 'Advice, not model output.\n\nThese are estimates.\n\nSee {site}/terms.' } }));
		// One fold: its line is the first paragraph, its action names the rest; the rest in a box that scrolls.
		expect(out).toMatch(/<details class="fold disclaimer[^"]*"[^>]*data-testid="assistant-disclaimer"/);
		expect(out).toMatch(/<summary[^>]*>.*<span[^>]*class="fold-line[^"]*"[^>]*>Advice, not model output\.<\/span>.*Read the full disclaimer/s);
		expect(out).toMatch(/aria-label="The full disclaimer"[^>]*>(<!--\[-->)?<p[^>]*>These are estimates\.<\/p><p[^>]*>See [^<]*\/terms\.<\/p>/);
		expect(out).not.toContain('{site}');
		expect(out).not.toMatch(/<details[^>]*\sopen/);
	});

	it('has one way out, the ✕: no Close button in the foot', () => {
		const out = html(chat({ turns: [{ role: 'user', text: 'Q' }, answer({ text: 'A' })] }));
		expect(out).toContain('aria-label="Close dialog"');
		expect(out).not.toContain('>Close</button>');
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

	it('shows an answer’s paragraphs, lists and bold as elements, the markup’s characters gone (the 2026-10-30 production test)', () => {
		const text = '### What a run needs\n\nThe model needs **two** things:\n- a network\n- a rainfall series\n\n---\n\n1. Draw it\n2. Upload rain';
		// Svelte's hydration comments sit between the elements: left out to read the markup.
		const out = html(chat({ turns: [{ role: 'user', text: 'Q' }, answer({ text })] })).replace(/<!--.*?-->/g, '');
		expect(out).toContain('<p class="heading');
		expect(out).toMatch(/<strong[^>]*>What a run needs<\/strong>/);
		expect(out).toMatch(/The model needs <strong[^>]*>two<\/strong> things:/);
		expect(out).toMatch(/<ul[^>]*><li[^>]*>a network<\/li><li[^>]*>a rainfall series<\/li><\/ul>/);
		expect(out).toMatch(/<ol start="1"[^>]*><li[^>]*>Draw it<\/li><li[^>]*>Upload rain<\/li><\/ol>/);
		const shown = out.slice(out.indexOf('data-testid="assistant-text"'));
		for (const mark of ['###', '**', '---', '- a network']) expect(shown).not.toContain(mark);
	});

	it('shows hostile text in an answer as text: no element, attribute or entity from it reaches the page', () => {
		const text = '<script>alert(1)</script> **<img src=x onerror=alert(1)>** &amp; [x](javascript:alert(1))\n- <a href="javascript:alert(2)">y</a>';
		const out = html(chat({ turns: [{ role: 'user', text: 'Q' }, answer({ text })] })).replace(/<!--.*?-->/g, '');
		// No element from the text: the tags show escaped, as text (an href only inside that text).
		expect(out).not.toMatch(/<script|<img|<a[\s>]/);
		expect(out).toContain(esc('<script>alert(1)</script>'));
		expect(out).toContain(`<strong>${esc('<img src=x onerror=alert(1)>')}</strong>`);
		expect(out).toContain('&amp;amp;');
		expect(out).toContain(esc('<a href="javascript:alert(2)">y</a>'));
	});

	it('shows a proposal’s server-built title, each change’s lines with its own reason, and Apply for an editor', () => {
		const out = html(chat({ turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: PROPOSAL, applied: false }] })] }));
		expect(out).toContain('Recommended change');
		expect(out).toMatch(/data-testid="assistant-proposal-title"[^>]*>Recalibration: GR4J X1 \(production store\)</);
		expect(out).toMatch(/data-testid="assistant-change"[^>]*>.*data-testid="assistant-diff-line"[^>]*>GR4J X1 \(production store\): 350 mm → 420 mm<.*Why:<\/span> A larger production store damps the response to rain\./s);
		expect(out).toContain('A recalibration');
		expect(out).toContain('Apply to the settings form');
	});

	it('shows a management change as a scenario to try, its title listing exactly its changes, each beside its reason (issue #640)', () => {
		const out = html(chat({ turns: [{ role: 'user', text: 'EWR?' }, answer({ proposals: [{ proposal: MANAGEMENT, applied: false }] })] }));
		expect(out).toContain('data-goal="outcome"');
		expect(out).toContain(esc(MANAGEMENT.title));
		// Every change the card names is a change it shows, in order, its reason under it.
		const changes = [...out.matchAll(/data-testid="assistant-change"[^>]*>(.*?)<\/li>/gs)].map((m) => m[1]!);
		expect(changes).toHaveLength(2);
		MANAGEMENT.changes.forEach((c, i) => {
			expect(changes[i]).toContain(esc(c.lines[0]!));
			expect(changes[i]).toContain(esc(c.reason));
		});
		expect(out).toContain('Try it as a scenario');
		expect(out).not.toContain('Apply to the settings form');
		expect(out).toContain('A management change, to try as a scenario on this run');
	});

	it('says a management change was made a scenario, and why when it wasn’t', () => {
		expect(html(chat({ turns: [{ role: 'user', text: 'Q' }, answer({ proposals: [{ proposal: MANAGEMENT, applied: true }] })] }))).toContain('Made a scenario on this run, not run yet.');
		const failed = html(chat({ turns: [{ role: 'user', text: 'Q' }, answer({ proposals: [{ proposal: MANAGEMENT, applied: false, failed: 'base run not found' }] })] }));
		expect(failed).toContain('The scenario wasn’t made: base run not found');
		expect(failed).toContain('Try it as a scenario');
	});

	it('gives a viewer the diff but no Apply', () => {
		const out = html(chat({ status: { ...STATUS, canApply: false }, turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: PROPOSAL, applied: false }] })] }));
		expect(out).toContain('350 mm → 420 mm');
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

	it('says chats are kept only in this browser, and offers Past chats with their count once read', () => {
		const empty = html(chat());
		expect(empty).toContain('Chats are kept only in this browser, and deleted when you sign out.');
		// Not read yet: no Past chats control.
		expect(empty).not.toContain('data-testid="assistant-past-toggle"');
		const c = chat();
		c.past = [
			{ id: 'a', title: 'First', updatedAt: '2026-10-28T08:00:00Z' },
			{ id: 'b', title: 'Second', updatedAt: '2026-10-27T08:00:00Z' }
		];
		const out = html(c);
		// Svelte's server output marks the {#if} block with comments (<!--[-->): strip them until none is left.
		let bare = out;
		for (let prev = ''; prev !== bare; ) {
			prev = bare;
			bare = bare.replace(/<!--[^>]*-->/g, '');
		}
		expect(bare).toMatch(/data-testid="assistant-past-toggle"[^>]*>\s*Past chats<span class="count[^"]*" aria-hidden="true">2<\/span><span class="visually-hidden"> \(2\)<\/span>/);
		expect(out).toMatch(/aria-expanded="false"[^>]*aria-controls="assistant-past"|aria-controls="assistant-past"[^>]*aria-expanded="false"/);
	});

	it('says history is off once, not in both the bar and the empty state', () => {
		const c = chat();
		c.historyOff = true;
		expect(html(c).match(/Past chats are off/g)).toHaveLength(1);
	});

	it('with history off, says so quietly instead of offering Past chats', () => {
		const c = chat();
		c.historyOff = true;
		const out = html(c);
		expect(out).toContain('data-testid="assistant-history-off"');
		expect(out).toContain('Past chats are off: this browser isn’t keeping site data');
		expect(out).not.toContain('data-testid="assistant-past-toggle"');
		expect(out).not.toContain('Chats are kept only in this browser');
	});

	it('shows a past chat’s recommended change read-only: no Apply, ask again for a fresh one', () => {
		const { apply: _apply, ...shown } = PROPOSAL;
		void _apply;
		for (const applied of [false, true]) {
			const out = html(chat({ turns: [{ role: 'user', text: 'Recommend' }, answer({ proposals: [{ proposal: shown, applied, stale: true }] })] }));
			expect(out).toContain(esc(PROPOSAL.title));
			expect(out).toContain('350 mm → 420 mm');
			expect(out).not.toContain('Apply to the settings form');
			expect(out).not.toContain('Try it as a scenario');
			expect(out).not.toContain('not saved');
			expect(out).toContain('From a past chat, so it can’t be applied');
			expect(out.includes('Applied at the time.')).toBe(applied);
		}
	});

	it('shows a turn that ended early, and a question that wasn’t sent', () => {
		const out = html(chat({ refusal: { kind: 'error', message: 'Could not reach the server' }, turns: [{ role: 'user', text: 'Q' }, answer({ text: 'Half', error: 'The answer stopped before it finished. Ask again.', done: false })] }));
		expect(out).toContain('The answer stopped before it finished. Ask again.');
		expect(out).toContain('The question wasn’t sent: Could not reach the server');
	});
});
