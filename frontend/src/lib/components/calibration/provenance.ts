// Labels for the fit record display (FitProvenance.svelte). Pure, so it is unit-tested.
import { CALIBRATION_PARAMS, type RunoffModelId } from '@water-management/engine';

/** "Production store capacity X1" for GR4J's x1; the key itself when unknown. */
export function paramLabel(model: RunoffModelId, key: string): string {
	return CALIBRATION_PARAMS[model]?.find((p) => p.key === key)?.label ?? key;
}

/** "GR4J" or "Legacy (workbook comparison)" (audit H1): the fit record's model, in the heading of FitProvenance. */
export function fitModelLabel(model: RunoffModelId): string {
	return model === 'gr4j' ? 'GR4J' : 'Legacy (workbook comparison)';
}
