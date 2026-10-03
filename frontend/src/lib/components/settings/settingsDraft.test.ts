import { defaultProjectSettings, type ProjectSettings } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { editableSettings, rebaseSettings, SettingsDraft } from './settingsDraft.svelte';

const saved = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({ ...defaultProjectSettings(), ...over });

describe('SettingsDraft', () => {
	it('is clean before anything is loaded, and once loaded', () => {
		const d = new SettingsDraft();
		expect(d.dirty).toBe(false);
		d.load(saved());
		expect(d.dirty).toBe(false);
	});

	it('is dirty on an edit and clean again on revert, which forgets what a switch kept', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.apanMm[0] = 123;
		d.lastAreal = { factors: new Array(12).fill(1.1), method: 'map', source: 'x' } as never;
		d.errors.wr2012 = 'The WR2012 check has 1 problem to fix.';
		d.kept.wr2012 = { quaternary: 'A21B' };
		expect(d.dirty).toBe(true);
		d.revert();
		expect(d.dirty).toBe(false);
		expect(d.s.apanMm[0]).toBe(defaultProjectSettings().apanMm[0]);
		expect(d.lastAreal).toBeNull();
		expect(d.errors.wr2012).toBeNull();
		expect(d.kept).toEqual({});
	});

	it('opens X2 when the saved value isn’t 0', () => {
		const d = new SettingsDraft();
		d.load(saved({ gr4j: { ...defaultProjectSettings().gr4j, x2: 0.4 } }));
		expect(d.x2Open).toBe(true);
		d.load(saved());
		expect(d.x2Open).toBe(false);
	});

	it('fills in the defaults an older API leaves out, without counting them as edits', () => {
		const old = saved();
		delete (old as Partial<ProjectSettings> & { autoRun?: unknown }).autoRun;
		const d = new SettingsDraft();
		d.load(old);
		expect(d.s.autoRun.enabled).toBe(false);
		expect(d.dirty).toBe(false);
	});

	it('a rebase while clean takes the new settings', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.rebase(saved({ februaryDays: 28 }));
		expect(d.s.februaryDays).toBe(28);
		expect(d.dirty).toBe(false);
	});

	it('a rebase while dirty keeps the edits and takes what changed elsewhere', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.apanMm[0] = 123;
		d.rebase(saved({ februaryDays: 28 }));
		expect(d.s.apanMm[0]).toBe(123);
		expect(d.s.februaryDays).toBe(28);
		expect(d.dirty).toBe(true);
		// Discarding now goes back to the new save, not the old one.
		d.revert();
		expect(d.s.februaryDays).toBe(28);
		expect(d.s.apanMm[0]).toBe(defaultProjectSettings().apanMm[0]);
	});

	it('the snapshot is plain data the API can take', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.effectiveRainFraction = 0.5;
		const snap = d.snapshot();
		expect(snap.effectiveRainFraction).toBe(0.5);
		expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
	});
});

describe('rebaseSettings', () => {
	it('keeps the settings the form changed and takes the rest from the new save, removing one the form cleared', () => {
		const before = editableSettings(saved({ reportStart: '2020-10-01' }));
		const draft = { ...editableSettings(saved({ reportStart: '2020-10-01' })), februaryDays: 29 } as typeof before;
		delete (draft as Partial<typeof before>).reportStart;
		const after = editableSettings(saved({ reportStart: '2020-10-01', lakeEvapFactor: 0.6 }));
		const out = rebaseSettings(draft, before, after);
		expect(out.februaryDays).toBe(29);
		expect(out.lakeEvapFactor).toBe(0.6);
		expect('reportStart' in out).toBe(false);
	});
});
