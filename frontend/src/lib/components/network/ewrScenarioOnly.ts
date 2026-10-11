// The rules that keep water for the EWR run only in a scenario (issue #523
// B4, docs/scenarios.md § The EWR-keeping rules): in the baseline the EWR is
// assessed and reported, never applied. The baseline forms (a unit's
// hands-off flow, a dam's pass-inflow release, a river off-take, the drought
// restriction) show the switch disabled with this note, as the Allocations
// page shows the allocation mode; the API refuses a save that switches one on
// (400 ewr_rule_scenario_only). A switch already on (a model from before
// engine 1.84.0 never reaches the form: migration 216 switched them off) can
// still be switched off, never on.

/** The note under each switch. */
export const EWR_SCENARIO_ONLY_NOTE =
	'Scenario only: in the baseline the EWR is assessed and reported, never applied. To keep it in the river here, make a scenario that switches this on.';

/** Whether a baseline form's switch for an EWR-keeping rule can be used: only to switch one off. */
export const ewrSwitchDisabled = (readonly: boolean, on: boolean): boolean => readonly || !on;
