// The assistant's past chats, kept only in this browser (docs/ui.md §
// Assistant, docs/security.md § Personal information). The server stores no
// chat text, by design; this keeps the conversations a person had on a
// project in IndexedDB, under their user id and the project's id, so they can
// reopen and continue one. Nothing here reaches the server: a reopened chat
// is sent back as the page sends any conversation, one turn at a time.
//
// IndexedDB rather than localStorage: a person's chats may reach a couple of
// megabytes, localStorage's whole quota for the site is about 5 MB (the farm
// view's saved copies share it, farm/savedCopy.ts), and its synchronous
// writes would block the page on each answer.
//
// What is kept: the questions, the answers' text, the tool lines and each
// recommended change as it was shown (its title, changes and reasons, and
// whether it was applied), never what Apply would do: a reopened change is
// read-only ("ask again"), so a settings patch or scenario built on an older
// project can never be applied to the current one.
//
// Limits: the newest MAX_CHATS_PER_PROJECT chats a project, and
// MAX_BYTES_PER_USER across the person's projects, the oldest dropped first.
// Every chat in the browser is deleted on sign-out (historyClear.ts), and
// another user's are deleted as soon as this one's are read.
import { CHAT_HISTORY_DB } from './historyClear';
import type { ProposalEntry, ToolLine, Turn } from './chat.svelte';

export const MAX_CHATS_PER_PROJECT = 20;
/** Bytes of stored JSON a person may keep, across their projects (about 2 MB). */
export const MAX_BYTES_PER_USER = 2_000_000;
/** A chat's title: its first question, cut to this many characters. */
export const TITLE_CHARS = 80;
/** The record format; a record of another version is dropped, never shown half-read. */
const VERSION = 1;
const STORE = 'chats';

/** A recommended change as it was shown, without its apply payload. */
export interface StoredProposal {
	goal: ProposalEntry['proposal']['goal'];
	title: string;
	changes: ProposalEntry['proposal']['changes'];
	applied: boolean;
}

export type StoredTurn =
	| { role: 'user'; text: string }
	| { role: 'assistant'; text: string; tools: ToolLine[]; proposals: StoredProposal[]; error: string | null; stopped: boolean };

export interface ChatRecord {
	/** `${userId}/${projectId}/${id}`: the store's key. */
	key: string;
	v: number;
	userId: string;
	projectId: string;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	/** The record's size in bytes of JSON, for the per-user cap. */
	bytes: number;
	turns: StoredTurn[];
}

/** One row of the Past chats list. */
export interface ChatSummary {
	id: string;
	title: string;
	updatedAt: string;
}

/** Where the records live: IndexedDB in the browser (idbBackend), a map in the tests. */
export interface HistoryBackend {
	all(): Promise<ChatRecord[]>;
	put(record: ChatRecord): Promise<void>;
	remove(keys: string[]): Promise<void>;
}

const encoder = new TextEncoder();
const sizeOf = (r: Omit<ChatRecord, 'bytes'>) => encoder.encode(JSON.stringify(r)).length;

/** The conversation as it is kept: questions and answers, tool lines, changes without their apply. */
export function storeTurns(turns: readonly Turn[]): StoredTurn[] {
	return turns.map((t) =>
		t.role === 'user'
			? { role: 'user', text: t.text }
			: {
					role: 'assistant',
					text: t.text,
					tools: t.tools.map((x) => ({ name: x.name, label: x.label, status: x.status })),
					proposals: t.proposals.map((p) => ({ goal: p.proposal.goal, title: p.proposal.title, changes: p.proposal.changes, applied: p.applied })),
					error: t.error,
					stopped: t.stopped
				}
	);
}

/** A kept conversation as the panel shows it: every turn finished, every change read-only (`stale`). */
export function restoreTurns(stored: readonly StoredTurn[]): Turn[] {
	return stored.map((t) =>
		t.role === 'user'
			? { role: 'user', text: t.text }
			: {
					role: 'assistant',
					text: t.text,
					tools: t.tools.map((x) => ({ ...x })),
					proposals: t.proposals.map((p) => ({ proposal: { goal: p.goal, title: p.title, changes: p.changes }, applied: p.applied, stale: true })),
					error: t.error,
					stopped: t.stopped,
					done: true
				}
	);
}

/** The first question, on one line and cut to TITLE_CHARS. */
export function titleOf(turns: readonly StoredTurn[]): string {
	const q = turns.find((t) => t.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? '';
	if (!q) return 'Untitled chat';
	return q.length > TITLE_CHARS ? `${q.slice(0, TITLE_CHARS - 1).trimEnd()}…` : q;
}

function valid(r: unknown): r is ChatRecord {
	if (!r || typeof r !== 'object') return false;
	const x = r as ChatRecord;
	return x.v === VERSION && typeof x.key === 'string' && typeof x.userId === 'string' && typeof x.projectId === 'string' && typeof x.id === 'string' && typeof x.updatedAt === 'string' && typeof x.bytes === 'number' && Array.isArray(x.turns);
}

const newest = (a: { updatedAt: string }, b: { updatedAt: string }) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

/**
 * One person's past chats on one project. The methods throw when storage
 * fails; the chat (chat.svelte.ts) catches every call and turns history off.
 */
export class ChatHistory {
	readonly userId: string;
	readonly projectId: string;
	#backend: HistoryBackend;
	#now: () => Date;
	#maxBytes: number;

	constructor(backend: HistoryBackend, userId: string, projectId: string, opts: { now?: () => Date; maxBytes?: number } = {}) {
		this.#backend = backend;
		this.userId = userId;
		this.projectId = projectId;
		this.#now = opts.now ?? (() => new Date());
		this.#maxBytes = opts.maxBytes ?? MAX_BYTES_PER_USER;
	}

	#key(id: string) {
		return `${this.userId}/${this.projectId}/${id}`;
	}

	/** This person's records; anyone else's (and anything unreadable) is deleted on the way. */
	async #mine(): Promise<ChatRecord[]> {
		const all = await this.#backend.all();
		const mine: ChatRecord[] = [];
		const drop: string[] = [];
		for (const r of all) {
			if (valid(r) && r.userId === this.userId) mine.push(r);
			else if (r && typeof (r as ChatRecord).key === 'string') drop.push((r as ChatRecord).key);
		}
		if (drop.length) await this.#backend.remove(drop);
		return mine;
	}

	/** This project's chats, newest first. */
	async list(): Promise<ChatSummary[]> {
		return (await this.#mine())
			.filter((r) => r.projectId === this.projectId)
			.sort(newest)
			.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt }));
	}

	/** One chat as the panel shows it (restoreTurns: its changes read-only), or null when it is gone. */
	async get(id: string): Promise<Turn[] | null> {
		const r = (await this.#mine()).find((x) => x.projectId === this.projectId && x.id === id);
		return r ? restoreTurns(r.turns) : null;
	}

	/**
	 * Keep `turns` as chat `id` (new or updated), then drop what passes the limits: this project's chats past
	 * MAX_CHATS_PER_PROJECT, then the person's oldest until they fit MAX_BYTES_PER_USER. A chat bigger than the
	 * cap alone keeps its newest turns that fit. False when nothing was worth keeping.
	 */
	async save(id: string, turns: readonly Turn[]): Promise<boolean> {
		let stored = storeTurns(turns);
		const mine = await this.#mine();
		const prev = mine.find((r) => r.projectId === this.projectId && r.id === id);
		// Newer than every other kept chat, even within one millisecond (or a clock set back), so the one just
		// saved lists first and is the last the caps drop.
		const latest = mine.reduce((m, r) => Math.max(m, Date.parse(r.updatedAt) || 0), 0);
		const now = new Date(Math.max(this.#now().getTime(), latest + 1)).toISOString();
		// Titled by its first question, even once a chat too big for the cap has dropped it.
		const title = prev?.title ?? titleOf(stored);
		const make = (t: StoredTurn[]): ChatRecord => {
			const base = { key: this.#key(id), v: VERSION, userId: this.userId, projectId: this.projectId, id, title, createdAt: prev?.createdAt ?? now, updatedAt: now, turns: t };
			return { ...base, bytes: sizeOf(base) };
		};
		let record = make(stored);
		// Too big alone: drop its oldest question and answer at a time, so it still starts with a question.
		while (record.bytes > this.#maxBytes && stored.length > 1) {
			stored = stored.slice(1);
			while (stored.length > 1 && stored[0]!.role !== 'user') stored = stored.slice(1);
			record = make(stored);
		}
		if (record.bytes > this.#maxBytes || !stored.some((t) => t.role === 'assistant' && t.text.trim())) return false;
		await this.#backend.put(record);

		const others = mine.filter((r) => r.key !== record.key);
		const drop = new Set<string>();
		others
			.filter((r) => r.projectId === this.projectId)
			.sort(newest)
			.slice(MAX_CHATS_PER_PROJECT - 1)
			.forEach((r) => drop.add(r.key));
		let total = record.bytes + others.filter((r) => !drop.has(r.key)).reduce((s, r) => s + r.bytes, 0);
		for (const r of [...others].sort(newest).reverse()) {
			if (total <= this.#maxBytes) break;
			if (drop.has(r.key)) continue;
			drop.add(r.key);
			total -= r.bytes;
		}
		if (drop.size) await this.#backend.remove([...drop]);
		return true;
	}

	async remove(id: string): Promise<void> {
		await this.#backend.remove([this.#key(id)]);
	}

	/** Forget this project's chats (Clear history). */
	async clear(): Promise<void> {
		const keys = (await this.#mine()).filter((r) => r.projectId === this.projectId).map((r) => r.key);
		if (keys.length) await this.#backend.remove(keys);
	}
}

const done = (req: IDBRequest | IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		if ('oncomplete' in req) {
			req.oncomplete = () => resolve();
			req.onabort = req.onerror = () => reject(req.error ?? new Error('storage failed'));
		} else {
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error ?? new Error('storage failed'));
		}
	});

/** The browser's IndexedDB as a HistoryBackend; null when there is none (or it can't be reached). */
export function idbBackend(factory?: IDBFactory | null): HistoryBackend | null {
	let idb: IDBFactory | null;
	try {
		idb = factory === undefined ? (globalThis.indexedDB ?? null) : factory;
	} catch {
		return null;
	}
	if (!idb) return null;
	const f = idb;
	let opening: Promise<IDBDatabase> | null = null;
	const db = () =>
		(opening ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = f.open(CHAT_HISTORY_DB, 1);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
			};
			req.onsuccess = () => {
				const d = req.result;
				// Sign-out deletes the database (historyClear.ts): let it, and open afresh next time.
				d.onversionchange = () => {
					d.close();
					opening = null;
				};
				d.onclose = () => {
					opening = null;
				};
				resolve(d);
			};
			req.onerror = () => {
				opening = null;
				reject(req.error ?? new Error('storage unavailable'));
			};
			req.onblocked = () => {
				opening = null;
				reject(new Error('storage blocked'));
			};
		}));
	return {
		async all() {
			const tx = (await db()).transaction(STORE, 'readonly');
			const req = tx.objectStore(STORE).getAll();
			await done(req);
			return req.result as ChatRecord[];
		},
		async put(record) {
			const tx = (await db()).transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(record);
			await done(tx);
		},
		async remove(keys) {
			const tx = (await db()).transaction(STORE, 'readwrite');
			const s = tx.objectStore(STORE);
			for (const k of keys) s.delete(k);
			await done(tx);
		}
	};
}

/** The signed-in person's past chats on a project, in this browser's IndexedDB; null when storage is unavailable. */
export function openChatHistory(userId: string, projectId: string): ChatHistory | null {
	const backend = idbBackend();
	return backend ? new ChatHistory(backend, userId, projectId) : null;
}
