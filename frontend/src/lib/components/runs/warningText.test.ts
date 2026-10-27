import { describe, expect, it } from 'vitest';
import { WARNING_PLACES, type WarningPlace } from '@water-management/engine';
import { CALIBRATION_SETTINGS_SECTIONS, SETTINGS_SECTIONS } from '#lib/components/settings/sections.js';
import { MODEL_QUALITY_ANCHORS } from '#lib/components/calibration/links.js';
import { warningParts, warningPlaceHref } from './warningText';

const href = (p: WarningPlace) => warningPlaceHref(p, 'r 1');

describe('warningParts (issue #586, D19)', () => {
	it('makes each place a warning names a link to its panel, the words around it plain', () => {
		expect(warningParts('Kept as recorded, as Model settings → Rain gaps → Flagged rain says.', href)).toEqual([
			{ text: 'Kept as recorded, as ' },
			{ text: 'Model settings → Rain gaps', href: '?tab=settings#set-rain' },
			{ text: ' → Flagged rain says.' }
		]);
		expect(warningParts('Calibration → Plausibility checks lists the signatures.', href)).toEqual([
			{ text: 'Calibration → Plausibility checks', href: '?tab=calibration&run=r%201#res-plausibility' },
			{ text: ' lists the signatures.' }
		]);
	});

	it('links an older run’s names to the panel’s place now', () => {
		expect(warningParts('pick a gauge in Settings → Calibration record', href)).toEqual([
			{ text: 'pick a gauge in ' },
			{ text: 'Settings → Calibration record', href: '?tab=calibration&run=r%201#set-record' }
		]);
		// Flow generation became Model selection for flow generation (engine 1.102.0, issue #614): its old name still links.
		expect(warningParts('Parameters not fitted for this method (Model settings → Flow generation: Fragmentation).', href)).toEqual([
			{ text: 'Parameters not fitted for this method (' },
			{ text: 'Model settings → Flow generation', href: '?tab=settings#set-share' },
			{ text: ': Fragmentation).' }
		]);
	});

	it('keeps a warning without a place as it is', () => {
		expect(warningParts('No place here.', href)).toEqual([{ text: 'No place here.' }]);
		expect(warningParts('', href)).toEqual([]);
	});
});

describe('warningPlaceHref', () => {
	it('sends every place to a panel its page has, by the heading the engine names', () => {
		const settings = new Map<string, string>(SETTINGS_SECTIONS.map((s) => [s.id, s.label]));
		const calibration = new Map<string, string>(CALIBRATION_SETTINGS_SECTIONS.map((s) => [s.id, s.label]));
		for (const [key, { page, panel }] of Object.entries(WARNING_PLACES) as [WarningPlace, (typeof WARNING_PLACES)[WarningPlace]][]) {
			const h = warningPlaceHref(key, null);
			const id = h.split('#')[1]!;
			if (page === 'Model settings') {
				expect(h, key).toBe(`?tab=settings#${id}`);
				expect(settings.get(id), key).toBe(panel);
			} else if (id.startsWith('set-')) {
				expect(h, key).toBe(`?tab=calibration#${id}`);
				expect(calibration.get(id), key).toBe(panel);
			} else {
				expect((MODEL_QUALITY_ANCHORS as readonly string[]).includes(id), key).toBe(true);
			}
		}
	});
});
