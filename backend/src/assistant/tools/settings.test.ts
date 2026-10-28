// get_settings's view (issue #610): model inputs only.
import { describe, expect, it } from 'vitest';
import { settingsView } from './settings.js';

describe('settingsView', () => {
	const stored = { gr4j: { x1: 300 }, responsibleAuthority: { name: 'Some CMA', kind: 'cma', office: 'An office' }, autoRun: { enabled: true }, calibrationStart: '2010-10-01' };

	it("merges the project's settings over the defaults and leaves out what is no model input", () => {
		const { settings } = settingsView(stored, undefined, true);
		expect(settings.gr4j).toMatchObject({ x1: 300 });
		expect(settings.apanMm).toHaveLength(12);
		for (const k of ['responsibleAuthority', 'autoRun', 'outcomes', 'outlook', 'ewrHeadline']) expect(settings[k]).toBeUndefined();
		expect(JSON.stringify(settings)).not.toContain('Some CMA');
	});

	it("a run's snapshot as it is, and only the keys asked for, naming the unknown ones", () => {
		expect(settingsView(stored, ['calibrationStart', 'noSuchKey'], false)).toEqual({ settings: { calibrationStart: '2010-10-01' }, unknownKeys: ['noSuchKey'] });
		expect(settingsView({ runoffModel: 'legacy' }, undefined, false).settings).toEqual({ runoffModel: 'legacy' });
	});
});
