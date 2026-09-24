// Labels for the fit record display (FitProvenance.svelte). Pure, so it is unit-tested.
import { CALIBRATION_PARAMS, type RunoffModelId } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum } from '$lib/format/number';

/** "Production store capacity X1" for GR4J's x1; the key itself when unknown. */
export function paramLabel(model: RunoffModelId, key: string): string {
	return CALIBRATION_PARAMS[model]?.find((p) => p.key === key)?.label ?? key;
}

/** A fit record's recorded monthly forcing: "0.70 every month" when uniform, else "Oct 0.65, Nov 0.70, …". */
export function monthsText(values: readonly number[], decimals = 2): string {
	return values.every((v) => v === values[0]) ? `${fmtNum(values[0], decimals)} every month` : values.map((v, i) => `${WATER_YEAR_MONTHS[i]} ${fmtNum(v, decimals)}`).join(', ');
}

/** "GR4J" or "Legacy (workbook comparison)" (audit H1): the fit record's model, in the heading of FitProvenance. */
export function fitModelLabel(model: RunoffModelId): string {
	return model === 'gr4j' ? 'GR4J' : 'Legacy (workbook comparison)';
}
