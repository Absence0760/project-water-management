import { describe, expect, it } from 'vitest';
import { projectArgs } from './args.js';

const a = '0b6f3c1e-2d4a-4c8e-9f10-1a2b3c4d5e6f';
const b = 'A0B1C2D3-E4F5-4a6b-8c7d-9e0f1a2b3c4d';

describe('projectArgs', () => {
	it('is undefined with no --project: the tick claims every project’s jobs', () => {
		expect(projectArgs(['node', 'worker.ts', '--once', '--no-schedule'])).toBeUndefined();
	});

	it('collects every --project id, in order', () => {
		expect(projectArgs(['--once', '--project', a, '--no-schedule', '--project', b])).toEqual([a, b]);
	});

	it('refuses a --project with no id or with something that is not a UUID', () => {
		expect(() => projectArgs(['--once', '--project'])).toThrow('--project needs a project id (a UUID), got nothing');
		expect(() => projectArgs(['--project', '--no-schedule'])).toThrow('got "--no-schedule"');
		expect(() => projectArgs(['--project', `${a}'`])).toThrow('a UUID');
	});
});
