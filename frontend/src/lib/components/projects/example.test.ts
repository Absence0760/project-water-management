// "Start from an example" (example.ts, issue #286): where it goes after the
// import, how it fails, and that the example document stays a lazy chunk.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ImportResult, Project, ProjectFile } from '$lib/api';
import { ApiError } from '$lib/api/client';
import { loadExample, startFromExample } from './example';

const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const file = { name: 'Example', model: { nodes: [], crops: [], cropAreas: [], transfers: [] } } as ProjectFile;
const loaded = () => Promise.resolve({ default: file });
const result = (r: Partial<ImportResult>) => ({ project: { id: 'p 1' } as Project, ...r }) as ImportResult;

describe('startFromExample', () => {
	it('imports the example with a run and opens that run', async () => {
		const importProject = vi.fn(async () => result({ runId: 'r1' }));
		expect(await startFromExample(importProject, loaded)).toEqual({ ok: true, path: '/projects/p%201?tab=runs&run=r1' });
		expect(importProject).toHaveBeenCalledWith(file, { run: true });
	});

	it('a run that failed comes back with why, and the project (still created) to open', async () => {
		expect(await startFromExample(async () => result({ runError: 'model run failed: no rain' }), loaded)).toEqual({
			ok: true,
			path: '/projects/p%201',
			runError: 'model run failed: no rain'
		});
	});

	it('a chunk that didn’t download is a chunk failure, and nothing is imported', async () => {
		const importProject = vi.fn();
		expect(await startFromExample(importProject, () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))).toEqual({
			ok: false,
			kind: 'chunk'
		});
		expect(importProject).not.toHaveBeenCalled();
	});

	it('a refused import says so with the server’s error', async () => {
		const error = new ApiError(413, 'project file larger than 5 MB');
		expect(await startFromExample(() => Promise.reject(error), loaded)).toEqual({ ok: false, kind: 'import', error });
	});
});

describe('the example document', () => {
	it('loads as a project document of the invented example', async () => {
		const doc = (await loadExample()).default;
		expect(doc.name).toMatch(/^Example · /);
		expect(doc.description).toMatch(/^Invented demo catchment\./);
		expect(doc.model.nodes.length).toBeGreaterThan(0);
		expect(doc.series?.map((s) => s.kind)).toContain('rain_catchment_mm');
	});

	it('is only ever imported dynamically, so it stays out of the page chunks', () => {
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.(ts|js|svelte)$/.test(name) && !name.endsWith('.test.ts')) files.push(path);
			}
		};
		walk(SRC);
		const refs = files.filter((f) => readFileSync(f, 'utf8').includes('exampleCatchment.generated.json')).map((f) => relative(SRC, f));
		expect(refs).toEqual(['lib/components/projects/example.ts']);
		const code = readFileSync(join(SRC, refs[0]!), 'utf8');
		expect(code).toContain("import('./exampleCatchment.generated.json')");
		expect(code).not.toMatch(/^\s*import\s[^(]*exampleCatchment\.generated\.json/m);
	});
});
