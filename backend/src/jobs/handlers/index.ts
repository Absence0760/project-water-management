// Every job kind the worker can run. A kind without an entry here is dead on
// its first attempt ("no handler"), so enqueue a kind only once it's listed.
// WP-2.13 added alert_eval; WP-3.6 added yield; issue #53 R2 added sweep, R5 outlook; issue #153 auto_calibration and uncertainty; issue #71 pack_render and pack_reproduce; WP-3.11 assessment; the licensing positions applicant_pack_render (165); delineate (191), a catchment too large for the request; future_yield (280), the evidence pack's § 8; climate_factors (282), the Scenarios tab's future climate; scenario_run (293), an issued licence's terms run for the evidence report; assessment_yield (297), one dam's firm yield on one run of a cumulative assessment; pack_reproduce_part (302), one part of an issued pack's server re-run. Every kind now has one.
import type { HandlerRegistry } from '../registry.js';
import { alertEvalHandler } from './alert-eval.js';
import { applicantPackRenderHandler } from './applicant-pack-render.js';
import { assessmentHandler } from './assessment.js';
import { assessmentYieldHandler } from './assessment-yield.js';
import { autoCalibrationHandler } from './auto-calibration.js';
import { climateFactorsHandler } from './climate-factors.js';
import { delineateHandler } from './delineate.js';
import { feedFetchHandler } from './feed-fetch.js';
import { feedIngestHandler } from './feed-ingest.js';
import { futureYieldHandler } from './future-yield.js';
import { outlookHandler } from './outlook.js';
import { packRenderHandler } from './pack-render.js';
import { packReproduceHandler } from './pack-reproduce.js';
import { packReproducePartHandler } from './pack-reproduce-part.js';
import { reportRenderHandler } from './report-render.js';
import { rerunHandler } from './rerun.js';
import { scenarioRunHandler } from './scenario-run.js';
import { sweepHandler } from './sweep.js';
import { uncertaintyHandler } from './uncertainty.js';
import { yieldHandler } from './yield.js';

export const handlers: HandlerRegistry = {
	rerun: rerunHandler,
	feed_fetch: feedFetchHandler,
	feed_ingest: feedIngestHandler,
	report_render: reportRenderHandler,
	yield: yieldHandler,
	sweep: sweepHandler,
	outlook: outlookHandler,
	alert_eval: alertEvalHandler,
	auto_calibration: autoCalibrationHandler,
	uncertainty: uncertaintyHandler,
	pack_render: packRenderHandler,
	pack_reproduce: packReproduceHandler,
	assessment: assessmentHandler,
	applicant_pack_render: applicantPackRenderHandler,
	delineate: delineateHandler,
	future_yield: futureYieldHandler,
	climate_factors: climateFactorsHandler,
	scenario_run: scenarioRunHandler,
	assessment_yield: assessmentYieldHandler,
	pack_reproduce_part: packReproducePartHandler
};
