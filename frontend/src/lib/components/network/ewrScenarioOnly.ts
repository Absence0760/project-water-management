// The rules that keep water for the EWR run only in a scenario (issue #523
// B4, docs/scenarios.md § The EWR-keeping rules): in the baseline the EWR is
// assessed and reported, never applied. The baseline forms (a unit's
// hands-off flow, a dam's pass-inflow release, a river off-take, the drought
// restriction) show the switch disabled with this note, as the Allocations
// page shows the allocation mode; the API refuses a save that switches one on
// (400 ewr_rule_scenario_only). A switch already on (a model from before
// engine 1.84.0 never reaches the form: migration 216 switched them off) can
// still be switched off, never on. A scenario's Override mode reuses these forms
// without `baseline` (ModelEditor.baseline false), where the switches work.

/** The note under each switch. */
export const EWR_SCENARIO_ONLY_NOTE =
	'Scenario only: in the baseline the EWR is assessed and reported, never applied. To keep it in the river here, make a scenario that switches this on.';

/**
 * Whether a form's switch for an EWR-keeping rule is disabled: in the baseline (the project's own model) it can
 * only switch one off; in a scenario's Override mode (`baseline` false) it works like any other switch.
 */
export const ewrSwitchDisabled = (readonly: boolean, on: boolean, baseline: boolean): boolean => readonly || (baseline && !on);
