// The catchment page's loads, latest wins (docs/architecture.md § Stale
// responses). Moving from one project to another while the first is still
// loading must never draw the first project's answer under the second's
// name, and a refresh of the series list that comes back after a newer list
// (the next project's load, another refresh, a list the Time series tab
// reported) must not bring the older one back.
import type { SeriesMeta } from '@water-management/engine';
import { api } from '#lib/api/index.js';
import { latestOnly, type Latest } from '#lib/api/latest.js';
import { fetchProjectPage, takeProjectPage, type ProjectPageData } from './firstLoad';

export interface PageLoadDeps {
	/** The page's first requests for a project (firstLoad.ts: the layout's started ones, else new ones). */
	page: (id: string) => Promise<ProjectPageData>;
	seriesList: (id: string) => Promise<SeriesMeta[]>;
}

const DEPS: PageLoadDeps = {
	page: (id) => takeProjectPage(id) ?? fetchProjectPage(id),
	seriesList: (id) => api.series.list(id)
};

export interface PageLoads {
	/**
	 * Load a project's page. `{ current: false }` once a later load began (its failure too); the latest
	 * load's failure is thrown. `seriesCurrent` is false when a series list asked for after this load
	 * began has already been shown, so the page keeps that newer one.
	 */
	page(id: string): Promise<Latest<{ data: ProjectPageData; seriesCurrent: boolean }>>;
	/**
	 * Read the series list for a reader that shows it itself (the Time series tab's Try again, or its
	 * read after a day is edited), in the same order as the page's own reads: `{ current: false }` when a
	 * list asked for after it (the next load's, a header upload's refresh, a later read) is already
	 * showing, its failure too; its failure is thrown otherwise.
	 */
	list(id: string): Promise<Latest<SeriesMeta[]>>;
	/** Refresh the series list: the list, or null when it failed or a newer list is already showing (as `list`). */
	series(id: string): Promise<SeriesMeta[] | null>;
	/**
	 * The page shows a series list it has itself (one the Time series tab changed): any list still being
	 * read is older. Not for a list `list` answered, which is in order already.
	 */
	wrote(): void;
}

export function pageLoads(deps: PageLoadDeps = DEPS): PageLoads {
	const pages = latestOnly();
	// The series list has several writers, so it is ordered by when each list was asked for: one is shown
	// unless a list asked for after it is already showing. A newer refresh that fails doesn't hide an older
	// answer still to come (the page's load, say), as a plain latest-only check would.
	let asked = 0;
	let shown = 0;
	const show = (ticket: number) => (ticket > shown ? ((shown = ticket), true) : false);
	async function list(id: string): Promise<Latest<SeriesMeta[]>> {
		const ticket = ++asked;
		let l: SeriesMeta[];
		try {
			l = await deps.seriesList(id);
		} catch (e) {
			if (ticket < shown) return { current: false };
			throw e;
		}
		return show(ticket) ? { current: true, value: l } : { current: false };
	}
	return {
		list,
		async page(id) {
			const current = pages.begin();
			const ticket = ++asked;
			let data: ProjectPageData;
			try {
				data = await deps.page(id);
			} catch (e) {
				if (!current()) return { current: false };
				throw e;
			}
			return current() ? { current: true, value: { data, seriesCurrent: show(ticket) } } : { current: false };
		},
		async series(id) {
			const r = await list(id).catch(() => null);
			return r?.current ? r.value : null;
		},
		wrote() {
			show(++asked);
		}
	};
}
