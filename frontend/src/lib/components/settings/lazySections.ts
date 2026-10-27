// The Settings tab's lazy sections that draw on every visit, one chunk (SettingsTab.svelte's loaders; issue
// #521): Rain gaps' two cards, the quality flags and gap filling, rain for each unit and Model selection for flow generation's station
// table (issue #553), evaporation from the map,
// and the evidence rule. Each was a chunk of its own to keep the tab under its ceiling,
// but they all load together whenever the tab opens, so one chunk costs one request and less gzip overhead.
// The panels a visit may never draw (the pan helper, the areal rain body, a unit's MAP proposal,
// the calibration rules) keep chunks of their own; so do the ones the Scenarios tab loads too (drought
// restrictions, the daily EWR source), which would otherwise drag this chunk into a scenario's form.
export { default as ChirpsFitPeriodSection } from './ChirpsFitPeriodSection.svelte';
export { default as RainSourceSection } from './RainSourceSection.svelte';
export { default as ZeroRainSection } from './ZeroRainSection.svelte';
export { default as QualityFlagsFields } from './QualityFlagsFields.svelte';
export { default as FlowGapFillFields } from './FlowGapFillFields.svelte';
export { default as UnitRainFields } from './UnitRainFields.svelte';
export { default as FlowGenerationUnits } from './FlowGenerationUnits.svelte';
export { default as EwrSplitFields } from './EwrSplitFields.svelte';
export { default as EvaporationProposal } from './EvaporationProposal.svelte';
export { default as EvidenceRuleFields } from './EvidenceRuleFields.svelte';
