import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/index.js', () => ({ api: {} }));

import type { ProjectSummary } from '#lib/api/index.js';
import { projectListLoader, projectsLoader, type ListAndTeams } from './listLoad';

const project = (id: string) => ({ id, name: id }) as unknown as ProjectSummary;
const settled = (ids: string[]): ListAndTeams => [
	{ status: 'fulfilled', value: ids.map(project) },
	{ status: 'fulfilled', value: [] }
];

describe('projectListLoader (the project list page: Try again, an import)', () => {
	it('drops the earlier read when it answers after the later one', async () => {
		const answers: ((v: ListAndTeams) => void)[] = [];
		const read = projectListLoader(() => new Promise<ListAndTeams>((res) => answers.push(res)));
		const first = read();
		const second = read();
		// The later read (after an import) has the new project; the earlier one doesn't.
		answers[1]!(settled(['a', 'imported']));
		expect(await second).toEqual({ current: true, value: settled(['a', 'imported']) });
		answers[0]!(settled(['a']));
		expect(await first).toEqual({ current: false });
	});
});

describe('projectsLoader (the Compare page’s picker: Try again)', () => {
	it('drops the earlier read, and its failure, when they answer after the later one', async () => {
		const pending: { res: (v: ProjectSummary[]) => void; rej: (e: unknown) => void }[] = [];
		const list = projectsLoader(() => new Promise<ProjectSummary[]>((res, rej) => pending.push({ res, rej })));
		const first = list();
		const second = list();
		pending[1]!.res([project('b')]);
		expect(await second).toEqual({ current: true, value: [project('b')] });
		pending[0]!.res([project('a')]);
		expect(await first).toEqual({ current: false });

		const third = list();
		const fourth = list();
		pending[3]!.res([project('d')]);
		expect(await fourth).toEqual({ current: true, value: [project('d')] });
		pending[2]!.rej(new Error('offline'));
		expect(await third).toEqual({ current: false });
	});
});
