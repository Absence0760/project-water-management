import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import type { SeriesMeta } from '@water-management/engine';
import type { ProjectPageData } from './firstLoad';
import { pageLoads } from './pageLoads';

const seriesOf = (tag: string) => [{ id: tag }] as unknown as SeriesMeta[];
const dataOf = (id: string) => [{ id }, { nodes: [] }, seriesOf(`${id} on load`), []] as unknown as ProjectPageData;

/** Fakes whose answers the test gives by hand, in any order. */
function fakes() {
	const pages: Record<string, { res: (d: ProjectPageData) => void; rej: (e: unknown) => void }> = {};
	const lists: { res: (l: SeriesMeta[]) => void; rej: (e: unknown) => void }[] = [];
	const loads = pageLoads({
		page: (id) => new Promise((res, rej) => (pages[id] = { res, rej })),
		seriesList: () => new Promise((res, rej) => lists.push({ res, rej }))
	});
	return { loads, pages, lists };
}

describe('pageLoads: moving between projects', () => {
	it('drops the first project’s page when it answers after the second’s', async () => {
		const { loads, pages } = fakes();
		const a = loads.page('A');
		const b = loads.page('B');
		pages.B!.res(dataOf('B'));
		expect(await b).toEqual({ current: true, value: { data: dataOf('B'), seriesCurrent: true } });
		pages.A!.res(dataOf('A'));
		expect(await a).toEqual({ current: false });
	});

	it('drops the first project’s failure too (no error under the second’s name), and throws the latest one’s', async () => {
		const { loads, pages } = fakes();
		const a = loads.page('A');
		const b = loads.page('B');
		pages.A!.rej(new Error('404'));
		expect(await a).toEqual({ current: false });
		pages.B!.rej(new Error('down'));
		await expect(b).rejects.toThrow('down');
	});
});

describe('pageLoads: the series list', () => {
	it('drops a refresh asked for before the next project’s load, when it answers after it', async () => {
		const { loads, pages, lists } = fakes();
		const refresh = loads.series('A');
		const b = loads.page('B');
		pages.B!.res(dataOf('B'));
		expect(await b).toMatchObject({ current: true, value: { seriesCurrent: true } });
		lists[0]!.res(seriesOf('A refreshed'));
		expect(await refresh).toBeNull();
	});

	it('drops an earlier refresh that answers after a later one', async () => {
		const { loads, lists } = fakes();
		const first = loads.series('A');
		const second = loads.series('A');
		lists[1]!.res(seriesOf('second'));
		expect(await second).toEqual(seriesOf('second'));
		lists[0]!.res(seriesOf('first'));
		expect(await first).toBeNull();
	});

	it('keeps a later refresh’s list over the load’s, when the load answers last', async () => {
		const { loads, pages, lists } = fakes();
		const page = loads.page('A');
		const refresh = loads.series('A');
		lists[0]!.res(seriesOf('refreshed'));
		expect(await refresh).toEqual(seriesOf('refreshed'));
		pages.A!.res(dataOf('A'));
		expect(await page).toEqual({ current: true, value: { data: dataOf('A'), seriesCurrent: false } });
	});

	it('a later refresh that fails doesn’t hide an earlier answer still to come', async () => {
		const { loads, lists } = fakes();
		const first = loads.series('A');
		const second = loads.series('A');
		lists[1]!.rej(new Error('offline'));
		expect(await second).toBeNull();
		lists[0]!.res(seriesOf('first'));
		expect(await first).toEqual(seriesOf('first'));
	});

	it('drops a refresh still out when the page writes a list of its own (the Time series tab’s)', async () => {
		const { loads, lists } = fakes();
		const refresh = loads.series('A');
		loads.wrote();
		lists[0]!.res(seriesOf('older'));
		expect(await refresh).toBeNull();
	});

	it('drops the Time series tab’s own read when a header upload’s refresh, asked for after it, answered first', async () => {
		const { loads, lists } = fakes();
		const tab = loads.list('A');
		const upload = loads.series('A');
		lists[1]!.res(seriesOf('after the upload'));
		expect(await upload).toEqual(seriesOf('after the upload'));
		lists[0]!.res(seriesOf('before the upload'));
		expect(await tab).toEqual({ current: false });
	});

	it('drops the header upload’s refresh when the tab’s read, asked for after it, answered first', async () => {
		const { loads, lists } = fakes();
		const upload = loads.series('A');
		const tab = loads.list('A');
		lists[1]!.res(seriesOf('tab'));
		expect(await tab).toEqual({ current: true, value: seriesOf('tab') });
		lists[0]!.res(seriesOf('upload'));
		expect(await upload).toBeNull();
	});

	it('drops the tab’s older read’s failure once a newer list is showing, and throws it while none is', async () => {
		const { loads, lists } = fakes();
		const tab = loads.list('A');
		const upload = loads.series('A');
		lists[1]!.res(seriesOf('after the upload'));
		await upload;
		lists[0]!.rej(new Error('offline'));
		expect(await tab).toEqual({ current: false });

		const alone = loads.list('A');
		lists[2]!.rej(new Error('down'));
		await expect(alone).rejects.toThrow('down');
	});
});
