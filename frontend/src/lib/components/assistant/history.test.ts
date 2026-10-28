// The assistant's past chats in this browser (history.ts): kept per person
// and project (another person never sees them, with the positive control that
// their owner does), the newest 20 a project and about 2 MB a person, the
// oldest dropped first; a reopened chat's changes come back read-only with no
// apply payload; sign-out's delete never throws. The IndexedDB adapter itself
// runs in the browser (e2e/tests/assistant-history.spec.ts); here a map
// stands in for it.
import { describe, expect, it, vi } from 'vitest';
import type { AssistantProposal } from '#lib/api/types.js';
import type { Turn } from './chat.svelte';
import { ChatHistory, MAX_CHATS_PER_PROJECT, TITLE_CHARS, idbBackend, restoreTurns, storeTurns, titleOf, type ChatRecord, type HistoryBackend } from './history';
import { CHAT_HISTORY_DB, clearAllChatHistory } from './historyClear';

function memory(): HistoryBackend & { rows: Map<string, ChatRecord> } {
	const rows = new Map<string, ChatRecord>();
	return {
		rows,
		all: async () => [...rows.values()].map((r) => structuredClone(r)),
		put: async (r) => void rows.set(r.key, structuredClone(r)),
		remove: async (keys) => keys.forEach((k) => rows.delete(k))
	};
}

/** A clock that moves a minute a call, so each save is newer than the last. */
function clock(start = Date.UTC(2026, 9, 28, 8)) {
	let t = start;
	return () => new Date((t += 60_000));
}

const PROPOSAL: AssistantProposal = {
	goal: 'recalibration',
	title: 'Recalibration: GR4J X1',
	changes: [{ label: 'GR4J X1', lines: ['GR4J X1: 350 → 420'], reason: 'A larger store damps the response.' }],
	apply: { kind: 'settings', patch: { gr4j: { x1: 420 } } }
};

const convo = (q: string, a = `About ${q}`, extra: Partial<Extract<Turn, { role: 'assistant' }>> = {}): Turn[] => [
	{ role: 'user', text: q },
	{ role: 'assistant', text: a, tools: [{ name: 'get_network', label: 'Reading the network', status: 'done' }], proposals: [], error: null, stopped: false, done: true, ...extra }
];

describe('ChatHistory', () => {
	it('keeps a chat under its person and project: the owner lists and reopens it, another person and another project see nothing', async () => {
		const be = memory();
		const now = clock();
		const a = new ChatHistory(be, 'user-a', 'p1', { now });
		expect(await a.save('c1', convo('Why is the outlet flat?'))).toBe(true);

		// Positive control: the owner sees their own chat, titled by its first question.
		expect(await a.list()).toEqual([{ id: 'c1', title: 'Why is the outlet flat?', updatedAt: expect.any(String) }]);
		expect((await a.get('c1'))?.map((t) => t.text)).toEqual(['Why is the outlet flat?', 'About Why is the outlet flat?']);

		// The same person on another project: nothing.
		expect(await new ChatHistory(be, 'user-a', 'p2', { now }).list()).toEqual([]);
		// Another person on the same project: nothing, and A's chat is deleted on the way (a session that ended without a sign-out).
		const b = new ChatHistory(be, 'user-b', 'p1', { now });
		expect(await b.list()).toEqual([]);
		expect(await b.get('c1')).toBeNull();
		expect(be.rows.size).toBe(0);
	});

	it('updates a chat in place, keeping its title and first time, and lists the newest first', async () => {
		const be = memory();
		const h = new ChatHistory(be, 'u', 'p', { now: clock() });
		await h.save('c1', convo('First question'));
		await h.save('c2', convo('Second question'));
		const created = be.rows.get('u/p/c1')!.createdAt;
		await h.save('c1', [...convo('First question'), ...convo('A follow-up')]);
		const list = await h.list();
		expect(list.map((c) => c.id)).toEqual(['c1', 'c2']);
		expect(list[0]!.title).toBe('First question');
		expect(be.rows.get('u/p/c1')!.createdAt).toBe(created);
		expect(be.rows.get('u/p/c1')!.turns).toHaveLength(4);
	});

	it('keeps nothing until the assistant has answered', async () => {
		const be = memory();
		const h = new ChatHistory(be, 'u', 'p', { now: clock() });
		expect(await h.save('c1', [{ role: 'user', text: 'Hello?' }])).toBe(false);
		expect(await h.save('c2', convo('Hello?', '  '))).toBe(false);
		expect(be.rows.size).toBe(0);
	});

	it(`keeps the newest ${MAX_CHATS_PER_PROJECT} chats a project, dropping the oldest, and leaves other projects alone`, async () => {
		const be = memory();
		const now = clock();
		const other = new ChatHistory(be, 'u', 'other', { now });
		await other.save('o1', convo('On another project'));
		const h = new ChatHistory(be, 'u', 'p', { now });
		for (let i = 0; i < MAX_CHATS_PER_PROJECT + 3; i++) await h.save(`c${i}`, convo(`Question ${i}`));
		const ids = (await h.list()).map((c) => c.id);
		expect(ids).toHaveLength(MAX_CHATS_PER_PROJECT);
		expect(ids[0]).toBe(`c${MAX_CHATS_PER_PROJECT + 2}`);
		expect(ids).not.toContain('c0');
		expect(ids).not.toContain('c2');
		expect(ids).toContain('c3');
		expect((await other.list()).map((c) => c.id)).toEqual(['o1']);
	});

	it('caps the bytes a person keeps across projects, dropping the oldest chat first', async () => {
		const be = memory();
		const now = clock();
		const long = 'x'.repeat(3000);
		const p1 = new ChatHistory(be, 'u', 'p1', { now, maxBytes: 11_000 });
		const p2 = new ChatHistory(be, 'u', 'p2', { now, maxBytes: 11_000 });
		await p1.save('old', convo('Oldest', long));
		await p2.save('mid', convo('Middle', long));
		await p1.save('new', convo('Newest', long));
		// Three of ~3.3 KB fit; a fourth pushes out the oldest, whichever project it is on.
		await p2.save('newer', convo('Newer still', long));
		expect([...be.rows.keys()].sort()).toEqual(['u/p1/new', 'u/p2/mid', 'u/p2/newer']);
		const total = [...be.rows.values()].reduce((s, r) => s + r.bytes, 0);
		expect(total).toBeLessThanOrEqual(11_000);
	});

	it('keeps the newest turns of a chat too big for the cap alone, starting at a question', async () => {
		const be = memory();
		const h = new ChatHistory(be, 'u', 'p', { now: clock(), maxBytes: 5_000 });
		const turns = [...convo('One', 'a'.repeat(2000)), ...convo('Two', 'b'.repeat(2000)), ...convo('Three', 'c'.repeat(2000))];
		expect(await h.save('c1', turns)).toBe(true);
		const kept = be.rows.get('u/p/c1')!;
		expect(kept.bytes).toBeLessThanOrEqual(5_000);
		expect(kept.turns[0]!.role).toBe('user');
		expect(kept.turns.at(-1)!.text).toBe('c'.repeat(2000));
		expect(kept.title).toBe('One');
	});

	it('deletes one chat, and Clear history deletes only this project’s', async () => {
		const be = memory();
		const now = clock();
		const h = new ChatHistory(be, 'u', 'p', { now });
		const other = new ChatHistory(be, 'u', 'q', { now });
		await h.save('c1', convo('One'));
		await h.save('c2', convo('Two'));
		await other.save('k1', convo('Kept'));
		await h.remove('c1');
		expect((await h.list()).map((c) => c.id)).toEqual(['c2']);
		await h.clear();
		expect(await h.list()).toEqual([]);
		expect((await other.list()).map((c) => c.id)).toEqual(['k1']);
	});

	it('drops a record of another format rather than show it half-read', async () => {
		const be = memory();
		be.rows.set('u/p/x', { key: 'u/p/x', v: 99, userId: 'u', projectId: 'p', id: 'x' } as ChatRecord);
		const h = new ChatHistory(be, 'u', 'p', { now: clock() });
		expect(await h.list()).toEqual([]);
		expect(be.rows.size).toBe(0);
	});

	it('throws when storage fails, for the chat to turn history off', async () => {
		const broken: HistoryBackend = { all: () => Promise.reject(new Error('blocked')), put: () => Promise.reject(new Error('full')), remove: () => Promise.reject(new Error('blocked')) };
		const h = new ChatHistory(broken, 'u', 'p');
		await expect(h.list()).rejects.toThrow('blocked');
		await expect(h.save('c', convo('Q'))).rejects.toThrow();
	});
});

describe('storing a conversation', () => {
	it('keeps a recommended change as it was shown, without what Apply would do, and brings it back read-only', () => {
		const turns = convo('Recommend something', 'One change.', { proposals: [{ proposal: PROPOSAL, applied: true, applying: false, failed: null }] });
		const stored = storeTurns(turns);
		const json = JSON.stringify(stored);
		expect(json).not.toContain('patch');
		expect(json).not.toContain('"apply"');
		const back = restoreTurns(stored);
		const a = back[1] as Extract<Turn, { role: 'assistant' }>;
		expect(a.done).toBe(true);
		expect(a.proposals).toEqual([{ proposal: { goal: 'recalibration', title: PROPOSAL.title, changes: PROPOSAL.changes }, applied: true, stale: true }]);
	});

	it('titles a chat by its first question on one line, cut to its length', () => {
		expect(titleOf(storeTurns(convo('  Why\n is   it dry? ')))).toBe('Why is it dry?');
		const long = titleOf(storeTurns(convo('word '.repeat(60))));
		expect(long.length).toBe(TITLE_CHARS);
		expect(long.endsWith('…')).toBe(true);
		expect(titleOf([])).toBe('Untitled chat');
	});
});

describe('storage that isn’t there', () => {
	it('idbBackend is null without IndexedDB', () => {
		expect(idbBackend(null)).toBeNull();
	});

	it('clearAllChatHistory deletes the database, and never throws when storage is blocked or missing', () => {
		const deleteDatabase = vi.fn();
		clearAllChatHistory({ deleteDatabase } as unknown as IDBFactory);
		expect(deleteDatabase).toHaveBeenCalledWith(CHAT_HISTORY_DB);
		expect(() =>
			clearAllChatHistory({
				deleteDatabase: () => {
					throw new DOMException('blocked', 'SecurityError');
				}
			} as unknown as IDBFactory)
		).not.toThrow();
		expect(() => clearAllChatHistory(null)).not.toThrow();
	});
});
