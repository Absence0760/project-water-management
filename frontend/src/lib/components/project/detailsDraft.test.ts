import { describe, expect, it } from 'vitest';
import type { Project } from '$lib/api';
import { ProjectDetailsDraft } from './detailsDraft.svelte';

const project = (over: Partial<Project> = {}) =>
	({ id: 'p1', name: 'Vaal', description: null, timeZone: 'Africa/Johannesburg', wuaName: null, ...over }) as Project;

describe('ProjectDetailsDraft', () => {
	it('is clean before anything is loaded (a project that failed to load leaves nothing unsaved)', () => {
		expect(new ProjectDetailsDraft().dirty).toBe(false);
	});
	it('is clean when loaded, dirty on an edit, clean again on revert', () => {
		const d = new ProjectDetailsDraft();
		d.load(project());
		expect(d.dirty).toBe(false);
		d.name = 'Vaal upper';
		expect(d.dirty).toBe(true);
		d.revert();
		expect(d.name).toBe('Vaal');
		expect(d.dirty).toBe(false);
	});
	it('ignores surrounding spaces', () => {
		const d = new ProjectDetailsDraft();
		d.load(project());
		d.name = ' Vaal ';
		expect(d.dirty).toBe(false);
	});
	it('sends the zone and WUA name only when they changed; an empty WUA name clears it', () => {
		const d = new ProjectDetailsDraft();
		d.load(project({ wuaName: 'Vaalbank WUA' }));
		d.description = 'Upper catchment';
		expect(d.patch()).toEqual({ name: 'Vaal', description: 'Upper catchment' });
		d.wuaName = '';
		d.timeZone = 'UTC';
		expect(d.patch()).toEqual({ name: 'Vaal', description: 'Upper catchment', timeZone: 'UTC', wuaName: null });
	});
	it('a name and a time zone are required', () => {
		const d = new ProjectDetailsDraft();
		d.load(project());
		expect(d.problems).toEqual([]);
		d.name = ' ';
		d.timeZone = '';
		expect(d.problems).toHaveLength(2);
	});
	it('a change made elsewhere keeps the edits, or follows the project when there are none', () => {
		const d = new ProjectDetailsDraft();
		d.load(project());
		d.rebase(project({ name: 'Moved' }));
		expect(d.name).toBe('Moved');
		d.description = 'Mine';
		d.rebase(project({ name: 'Moved', timeZone: 'UTC' }));
		expect(d.description).toBe('Mine');
		expect(d.timeZone).toBe('Africa/Johannesburg');
		expect(d.dirty).toBe(true);
	});
});
