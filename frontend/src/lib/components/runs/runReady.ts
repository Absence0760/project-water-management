// What a run still needs before it can start, shared by Runs & results' run form
// (RunsTab.svelte), the section header's Run model on every other section
// (workspace/RunButton.svelte) and the assistant's get_run_readiness tool, so all
// refuse for the same reasons and say them the same way: the engine's
// (packages/engine/src/runReady.ts), re-exported here for the components.
export { hasForecastRain, runBlockers, type RunBlockers } from '@water-management/engine';
