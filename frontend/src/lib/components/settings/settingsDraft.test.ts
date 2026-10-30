import { defaultProjectSettings, type ProjectSettings } from '@water-management/engine';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editableSettings, PATCH_REPLACED_WHOLE, rebaseSettings, SettingsDraft, withPatch } from './settingsDraft.svelte';

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

	it('adopts another shape of the same settings on the saved copy and the form alike, so it isn’t an edit (issue #659)', () => {
		const d = new SettingsDraft();
		d.load(saved());
		const shape = (s: Parameters<Parameters<SettingsDraft['adopt']>[0]>[0]) => (s.calibrateAtOutlet === undefined ? { ...s, calibrateAtOutlet: true } : s);
		d.adopt(shape);
		expect(d.s.calibrateAtOutlet).toBe(true);
		expect(d.saved.calibrateAtOutlet).toBe(true);
		expect(d.dirty).toBe(false);
		// An edit made before stays an edit.
		d.s.apanMm[0] = 123;
		d.adopt(shape);
		expect(d.dirty).toBe(true);
		d.revert();
		expect(d.s.calibrateAtOutlet).toBe(true);
	});

	it('works out what blocks Save itself, for the panels on both pages, whichever page is shown (issue #586 round 3)', () => {
		const d = new SettingsDraft();
		// Nothing is checked before the settings load.
		expect(d.blockers).toEqual([]);
		d.load(saved());
		expect(d.blockers).toEqual([]);
		// A Model settings panel's own check, a Calibration panel's own check and a section's reported problem.
		d.s.simulationStart = '2020-01-01';
		d.s.simulationEnd = '2019-01-01';
		d.s.pe = { kind: 'monthly', mm: new Array(12).fill(10), source: '' };
		d.errors.calWindow = 'The calibration window must start before it ends.';
		expect(d.blockers.map((b) => [b.id, b.label])).toEqual([
			['set-period', 'Simulation period'],
			['set-flow', 'Flow calibration'],
			['set-record', 'Calibration record']
		]);
		expect(d.blockers[0]!.message).toBe('Simulation start must be before the end.');
		d.revert();
		expect(d.blockers).toEqual([]);
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
		// No EWR headline choice (issue #444): automatic.
		expect(d.s.ewrHeadline).toEqual({ source: 'auto' });
		expect(d.dirty).toBe(false);
	});

	it('is dirty when the EWR the results are judged by changes (issue #444)', () => {
		const d = new SettingsDraft();
		d.load({ ...saved(), ewrHeadline: { source: 'ruleTable', siteNodeId: null } } as ProjectSettings);
		expect(d.s.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: null });
		d.s.ewrHeadline = { source: 'pragmatic' };
		expect(d.dirty).toBe(true);
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

	it('after a save, an edit typed while it was in flight stays unsaved; the rest takes the server’s values', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.apanMm[0] = 123;
		d.lastAreal = { factors: new Array(12).fill(1.1), method: 'map', source: 'x' } as never;
		const sent = d.snapshot();
		// Typed while the PATCH is out.
		d.s.februaryDays = 29;
		// The server saved what was sent (and normalised a value the form didn't touch since).
		d.afterSave(sent, { ...sent, lakeEvapFactor: 0.65 } as ProjectSettings);
		expect(d.s.februaryDays).toBe(29);
		expect(d.s.apanMm[0]).toBe(123);
		expect(d.s.lakeEvapFactor).toBe(0.65);
		expect(d.dirty).toBe(true);
		// What a switch kept stays with the unsaved edit.
		expect(d.lastAreal).not.toBeNull();
		// Discard goes back to what the server saved, not to before the save.
		d.revert();
		expect(d.s.februaryDays).toBe(defaultProjectSettings().februaryDays);
		expect(d.s.apanMm[0]).toBe(123);
	});

	it('after a save with no edit meanwhile, the form is clean and starts over as after a load', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.apanMm[0] = 123;
		d.lastAreal = { factors: new Array(12).fill(1.1), method: 'map', source: 'x' } as never;
		const sent = d.snapshot();
		d.afterSave(sent, sent);
		expect(d.dirty).toBe(false);
		expect(d.s.apanMm[0]).toBe(123);
		expect(d.lastAreal).toBeNull();
	});

	it('an applied fit (rebase preferring the saved) shows its values and keeps unrelated unsaved edits', () => {
		const d = new SettingsDraft();
		const base = saved();
		d.load(base);
		// Typed while the fit was being applied: one unrelated setting, and the fit's own.
		d.s.februaryDays = 29;
		d.s.gr4j = { ...d.s.gr4j, x1: 111 };
		const fitted = saved({ gr4j: { ...base.gr4j, x1: 420, x2: 0.4 } });
		d.rebase(fitted, 'saved');
		expect(d.s.gr4j.x1).toBe(420);
		expect(d.s.gr4j.x2).toBe(0.4);
		expect(d.x2Open).toBe(true);
		expect(d.s.februaryDays).toBe(29);
		expect(d.dirty).toBe(true);
		// The page's own rebase that follows changes nothing more.
		d.rebase(fitted);
		expect(d.s.gr4j.x1).toBe(420);
		expect(d.s.februaryDays).toBe(29);
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

	it('a setting both changed is the form’s, unless the saved is preferred', () => {
		const before = editableSettings(saved());
		const draft = { ...editableSettings(saved()), lakeEvapFactor: 0.5 } as typeof before;
		const after = editableSettings(saved({ lakeEvapFactor: 0.6 }));
		expect(rebaseSettings(draft, before, after).lakeEvapFactor).toBe(0.5);
		expect(rebaseSettings(draft, before, after, 'saved').lakeEvapFactor).toBe(0.6);
	});
});

describe('applyPatch: a recommended change put into the form (the assistant, issue #610)', () => {
	it('merges a nested setting one level deep, replaces a top-level one, and leaves the form unsaved', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.applyPatch({ gr4j: { x1: 420 }, effectiveRainFraction: 0.4 });
		expect(d.dirty).toBe(true);
		// The patched field changes; the group's other fields stay as stored.
		expect(d.s.gr4j).toEqual({ ...defaultProjectSettings().gr4j, x1: 420 });
		expect(d.s.effectiveRainFraction).toBe(0.4);
		// Nothing saved: the saved copy is what it was, and Discard puts it back.
		expect(d.saved.gr4j.x1).toBe(defaultProjectSettings().gr4j.x1);
		d.revert();
		expect(d.dirty).toBe(false);
		expect(d.s.gr4j.x1).toBe(defaultProjectSettings().gr4j.x1);
	});

	it('keeps other edits, takes the patch over an edit to the same setting, and opens X2 when it isn’t 0', () => {
		const d = new SettingsDraft();
		d.load(saved());
		d.s.apanMm[0] = 123;
		d.s.gr4j.x1 = 300;
		expect(d.x2Open).toBe(false);
		d.applyPatch({ gr4j: { x1: 500, x2: -0.5 } });
		expect(d.s.apanMm[0]).toBe(123);
		expect(d.s.gr4j.x1).toBe(500);
		expect(d.x2Open).toBe(true);
	});

	it('replaces whole the settings the server replaces whole, so no stale field is left behind', () => {
		const before = editableSettings(saved({ pe: { kind: 'monthly', mm: new Array(12).fill(10), source: 'x' } as unknown as ProjectSettings['pe'] }));
		const out = withPatch(before, { pe: { kind: 'pan' } });
		expect(out.pe).toEqual({ kind: 'pan' });
		// Neither argument changed.
		expect(before.pe).toEqual({ kind: 'monthly', mm: new Array(12).fill(10), source: 'x' });
	});

	it('replaces whole exactly the settings backend/src/projects/settings.ts REPLACED_WHOLE lists', () => {
		const src = readFileSync(new URL('../../../../../backend/src/projects/settings.ts', import.meta.url), 'utf8');
		const list = /const REPLACED_WHOLE(?::[^=]+)? = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
		const server = [...list.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]!);
		expect(server.length).toBeGreaterThan(5);
		expect([...PATCH_REPLACED_WHOLE].sort()).toEqual(server.sort());
	});
});
