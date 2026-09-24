// CHIRPS fallback bias correction picker (settings.chirpsBiasCorrection,
// engine ≥ 0.6.0; docs/model.md §2.4b).
import type { ChirpsBiasMode } from '@water-management/engine';

export const CHIRPS_BIAS_OPTIONS: { value: ChirpsBiasMode; label: string; help: string }[] = [
	{
		value: 'monthly',
		label: 'Bias-corrected per month (default)',
		help: 'Where catchment rain is blank, CHIRPS is scaled by catchment ÷ CHIRPS rain for the calendar month, fitted on the days both have a reading. Each run lists the factors in its warnings.'
	},
	{
		value: 'none',
		label: 'Raw CHIRPS',
		help: 'CHIRPS is used as stored. Only for a CHIRPS series that is already corrected to the catchment; raw CHIRPS can read well below catchment rain.'
	}
];
