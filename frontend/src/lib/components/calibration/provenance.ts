// Labels for the fit record display (FitProvenance.svelte). Pure, so it is unit-tested.
import { CALIBRATION_PARAMS, type RunoffModelId } from '@water-management/engine';

/** "Production store capacity X1" for GR4J's x1; the key itself when unknown. */
export function paramLabel(model: RunoffModelId, key: string): string {
	return CALIBRATION_PARAMS[model]?.find((p) => p.key === key)?.label ?? key;
}
