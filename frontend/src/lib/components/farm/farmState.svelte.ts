// Loads one farm for the farm pages (main, "Why?", dam) and holds what they
// render (docs/design/farmer-view.md §6.5, §9):
//
// - the saved copy on this phone at once, marked "Updating…", then the live
//   FarmView (which becomes the new saved copy);
// - no signal: the saved copy with the offline strip, or the error state
//   without one; a server failure the same, with Try again;
// - 403/404 (the farm or the project is no longer this user's): the removed
//   state, and the saved copy goes;
// - an index without a publication: the no-publication state.
//
// The index (the farms and whether anything is published) and the view go
// out together when the farm is known, so a phone waits one round trip. A
// short in-memory memo lets main → "Why?" → back skip the network. Refetched
// when the page becomes visible again; never polled.
import type { FarmIndex, FarmView } from '@water-management/engine';
import type { Api } from '$lib/api/client';
import { hasRole, type Role } from '$lib/api/types';
import { classify, pickNode } from './load';
import { clearSaved, latestSavedNode, readSaved, writeSaved } from './savedCopy';

export type FarmPhase =
	| { kind: 'loading' }
	| { kind: 'ready' }
	| { kind: 'no-publication' }
	| { kind: 'removed' }
	| { kind: 'error'; offline: boolean; attempts: number };

/** How long a fetched view is reused between the farm pages without asking again. */
const MEMO_MS = 60_000;
/** Keyed by user, project and farm, so a different user on the same tab never gets another's figures. */
const memo = new Map<string, { index: FarmIndex; view: FarmView; at: number }>();

/** Forget the in-memory copies (sign-out). */
export function clearFarmMemo() {
	memo.clear();
}

type FarmApi = { farm: Pick<Api['farm'], 'index' | 'view'> } & { projects: Pick<Api['projects'], 'list'> };

export class FarmState {
	phase = $state<FarmPhase>({ kind: 'loading' });
	index = $state.raw<FarmIndex | null>(null);
	view = $state.raw<FarmView | null>(null);
	nodeId = $state<string | null>(null);
	/** The view on screen is the saved copy, not a live answer. */
	fromSaved = $state(false);
	/** When the view on screen was fetched from the server (ms): the offline strip's "saved at". */
	savedAt = $state<number | null>(null);
	/** A request is out while a (saved) view is on screen. */
	updating = $state(false);
	/** The last request found no signal while a saved view is on screen. */
	offline = $state(false);
	/** The last request failed (not for lack of signal) while a saved view is on screen. */
	updateFailed = $state(false);

	#seq = 0;
	/** Failed loads in a row, for the error state's second-failure line. */
	#failures = 0;

	/** The viewer's role in the project (GET /projects), once known. */
	role = $state<Role | null>(null);
	#roleFor: string | null = null;
	#roleP: Promise<Role | null> = Promise.resolve(null);

	constructor(
		private readonly api: FarmApi,
		/** The signed-in user, whose copies to read and write; null = keep none. */
		private readonly userId: () => string | null
	) {}

	/**
	 * Viewer+ opening a farm page: WUA staff previewing it. A farmer, or an
	 * applicant (contributor, WP-3.3) linked to the farm, never sees it as a
	 * preview: it is their own farm.
	 */
	get preview(): boolean {
		return hasRole(this.role, 'viewer');
	}

	/** The role, asked once per project alongside the farm (it decides the banner and whether a copy is kept). */
	#checkRole(projectId: string): Promise<Role | null> {
		if (this.#roleFor !== projectId) {
			this.#roleFor = projectId;
			this.role = null;
			this.#roleP = this.api.projects.list().then(
				(list) => {
					const r = list.find((p) => p.id === projectId)?.role ?? null;
					if (this.#roleFor === projectId) this.role = r;
					return r;
				},
				() => null
			);
		}
		return this.#roleP;
	}

	/** The farm's name before the view arrives (the index lists it). */
	get farmName(): string | null {
		return this.view?.farm.name ?? this.index?.farms.find((f) => f.nodeId === this.nodeId)?.name ?? null;
	}

	get projectName(): string | null {
		return this.view?.project.name ?? this.index?.project.name ?? null;
	}

	/** The WUA the contact lines name (095_wua_name), or null for "your WUA". A saved copy from before it has none. */
	get wuaName(): string | null {
		return this.view?.project.wuaName ?? this.index?.project.wuaName ?? null;
	}

	/**
	 * Load `projectId`'s farm `asked` (?node=), or the one shown last, or its
	 * only one. `quiet` keeps what's on screen while it asks (a return to the page).
	 */
	async load(projectId: string, asked: string | null, { quiet = false, fresh = false } = {}) {
		const seq = ++this.#seq;
		const roleP = this.#checkRole(projectId);
		const user = this.userId();
		const guess = asked ?? (user ? latestSavedNode(user, projectId) : null);
		const key = guess ? `${user ?? ''}|${projectId}/${guess}` : null;

		const hit = key && !fresh ? memo.get(key) : undefined;
		if (hit && Date.now() - hit.at < MEMO_MS) {
			this.#show(hit.index, hit.view, guess!, hit.at, false);
			return;
		}

		if (!quiet || !this.view) {
			const saved = user && guess ? readSaved(user, projectId, guess) : null;
			if (saved) this.#show(null, saved.view, guess!, saved.savedAt, true);
			else if (!this.view || this.view.project.id !== projectId) {
				this.view = null;
				this.phase = { kind: 'loading' };
			}
		}
		this.updating = true;

		const viewP = guess ? this.api.farm.view(projectId, guess) : null;
		viewP?.catch(() => {}); // settled below; don't let an early rejection go unhandled
		let index: FarmIndex;
		try {
			index = await this.api.farm.index(projectId);
		} catch (e) {
			if (seq === this.#seq) this.#fail(e, projectId, null);
			return;
		}
		if (seq !== this.#seq) return;
		this.index = index;

		const nodeId = pickNode(index, asked, guess);
		if (!nodeId) return this.#removed(projectId, asked);
		this.nodeId = nodeId;
		if (!index.publication) {
			if (user) clearSaved(projectId, undefined);
			this.view = null;
			this.updating = false;
			this.phase = { kind: 'no-publication' };
			return;
		}

		let view: FarmView;
		try {
			view = await (nodeId === guess && viewP ? viewP : this.api.farm.view(projectId, nodeId));
		} catch (e) {
			if (seq === this.#seq) this.#fail(e, projectId, nodeId);
			return;
		}
		if (seq !== this.#seq) return;
		const at = Date.now();
		memo.set(`${user ?? ''}|${projectId}/${nodeId}`, { index, view, at });
		const role = await roleP;
		if (seq !== this.#seq) return;
		// A preview keeps no copy on the WUA's machine.
		if (user && !hasRole(role, 'viewer')) writeSaved(user, projectId, nodeId, view, at);
		this.#show(index, view, nodeId, at, false);
	}

	#show(index: FarmIndex | null, view: FarmView, nodeId: string, fetchedAt: number, fromSaved: boolean) {
		if (index) this.index = index;
		this.view = view;
		this.nodeId = nodeId;
		this.fromSaved = fromSaved;
		this.savedAt = fetchedAt;
		this.offline = false;
		this.updateFailed = false;
		this.updating = false;
		if (!fromSaved) this.#failures = 0;
		this.phase = { kind: 'ready' };
	}

	#removed(projectId: string, nodeId: string | null) {
		clearSaved(projectId, nodeId ?? undefined);
		for (const k of memo.keys()) if (k.includes(`|${projectId}/`)) memo.delete(k);
		this.view = null;
		this.updating = false;
		this.phase = { kind: 'removed' };
	}

	#fail(e: unknown, projectId: string, nodeId: string | null) {
		const why = classify(e);
		if (why === 'removed') return this.#removed(projectId, nodeId);
		this.updating = false;
		if (this.view && this.view.project.id === projectId) {
			// Keep the saved copy on screen, under the strip.
			this.fromSaved = true;
			this.offline = why === 'offline';
			this.updateFailed = why === 'failed';
			this.phase = { kind: 'ready' };
			return;
		}
		this.phase = { kind: 'error', offline: why === 'offline', attempts: ++this.#failures };
	}
}
