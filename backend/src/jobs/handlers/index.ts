// Every job kind the worker can run. A kind without an entry here is dead on
// its first attempt ("no handler"), so enqueue a kind only once it's listed.
// WP-2.13 added alert_eval; WP-3.6 added yield; issue #53 R2 added sweep, R5 outlook; issue #153 auto_calibration and uncertainty; issue #71 pack_render and pack_reproduce; WP-3.11 assessment; the licensing positions applicant_pack_render (165). Every kind now has one.
import type { HandlerRegistry } from '../registry.js';
import { alertEvalHandler } from './alert-eval.js';
import { applicantPackRenderHandler } from './applicant-pack-render.js';
import { assessmentHandler } from './assessment.js';
import { autoCalibrationHandler } from './auto-calibration.js';
import { feedFetchHandler } from './feed-fetch.js';
import { feedIngestHandler } from './feed-ingest.js';
import { outlookHandler } from './outlook.js';
import { packRenderHandler } from './pack-render.js';
import { packReproduceHandler } from './pack-reproduce.js';
import { reportRenderHandler } from './report-render.js';
import { rerunHandler } from './rerun.js';
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
	applicant_pack_render: applicantPackRenderHandler
};
