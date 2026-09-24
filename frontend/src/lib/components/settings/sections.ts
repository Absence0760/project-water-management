// The Settings & calibration page's in-page menu, one link per group in page
// order, and the list of what blocks Save, each pointing at its group. The ids
// are set on the panels in SettingsTab.svelte (and on Wr2012Section's panel).

export const SETTINGS_SECTIONS = [
	{ id: 'set-demand', label: 'Demand' },
	{ id: 'set-flow', label: 'Flow calibration' },
	{ id: 'set-rain', label: 'Rain gaps' },
	{ id: 'set-record', label: 'Calibration record' },
	{ id: 'set-fit', label: 'Fit automatically' },
	{ id: 'set-wr2012', label: 'WR2012 check' },
	{ id: 'set-share', label: 'Flow share' },
	{ id: 'set-ewr', label: 'EWR' },
	{ id: 'set-period', label: 'Simulation period' },
	{ id: 'set-quality', label: 'Data quality' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export interface SaveBlocker {
	id: SettingsSectionId;
	label: string;
	message: string;
}

/**
 * What stops Save, one entry per group with a problem (its first message), in
 * page order, so the save bar can link to where each one is fixed. Empty or
 * null messages are not problems.
 */
export function saveBlockers(problems: { id: SettingsSectionId; message: string | null | undefined }[]): SaveBlocker[] {
	return SETTINGS_SECTIONS.flatMap((sec) => {
		const hit = problems.find((p) => p.id === sec.id && p.message);
		return hit ? [{ id: sec.id, label: sec.label, message: hit.message! }] : [];
	});
}
