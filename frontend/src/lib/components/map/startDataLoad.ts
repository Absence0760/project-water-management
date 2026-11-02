// The Map's data step reads (startData.ts), latest wins (docs/architecture.md
// § Stale responses): they are read again after each change on the tab, and
// a slower earlier read must not set the to-do list back to how it was before
// that change.
import { api } from '#lib/api/index.js';
import { latestCall, type Latest } from '#lib/api/latest.js';
import type { DataFeed, DataInput, DataSeries } from './startData';

/** What the data step reads; one that can't be read is null, so its items stay Checking. */
export interface StartDataRead {
	settings: DataInput['settings'];
	feeds: DataFeed[] | null;
	series: DataSeries[] | null;
}

async function read(projectId: string): Promise<StartDataRead> {
	const [st, fd, sr] = await Promise.allSettled([
		api.projects.get(projectId).then((p) => p.settings),
		api.request<{ feeds: DataFeed[] }>('GET', `/projects/${encodeURIComponent(projectId)}/feeds`).then((r) => r.feeds),
		api.series.list(projectId)
	]);
	return {
		settings: st.status === 'fulfilled' ? st.value : null,
		feeds: fd.status === 'fulfilled' ? fd.value : null,
		series: sr.status === 'fulfilled' ? sr.value : null
	};
}

/** The data step's reads, latest call only (`{ current: false }` once a later read began). */
export function startDataLoader(load: (projectId: string) => Promise<StartDataRead> = read): (projectId: string) => Promise<Latest<StartDataRead>> {
	return latestCall(load);
}
