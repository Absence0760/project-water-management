import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { alertProjectRoutes, alertPublicRoutes, meAlertRoutes } from './alerts/routes.js';
import { licenceRecordRoutes } from './licence/routes.js';
import { allocationRoutes } from './allocations/routes.js';
import { requireUser, type AuthEnv } from './auth/middleware.js';
import { emailAuthRoutes } from './auth/email-routes.js';
import { authRoutes } from './auth/routes.js';
import { mfaRoutes } from './auth/mfa-routes.js';
import { compareRoutes } from './compare/routes.js';
import { exportRoutes } from './export/routes.js';
import { farmerRoutes } from './farms/routes.js';
import { farmViewRoutes } from './farms/view.js';
import { historyRoutes } from './history/routes.js';
import { apiKeyRoutes, ingestRoutes } from './ingest/routes.js';
import { handleError } from './http/errors.js';
import { logEvent } from './logging/logEvent.js';
import { refuseAmbiguousPaths } from './http/rawPath.js';
import { myInviteRoutes, projectInviteRoutes, teamInviteRoutes } from './invites/invites.js';
import { feedFromBoundaryRoutes } from './feeds/fromBoundary.js';
import { feedRoutes } from './feeds/routes.js';
import { MAP_IMPORT_PATH, mapRoutes } from './geo/routes.js';
import { quaternaryLayerRoutes } from './geo/quaternaryLayer.js';
import { stationRoutes } from './geo/stationRoutes.js';
import { riverRoutes } from './geo/rivers.js';
import { croplandRoutes } from './geo/croplandRoutes.js';
import { evaporationRoutes } from './geo/evaporationRoutes.js';
import { damRoutes } from './geo/damRoutes.js';
import { delineationRoutes } from './delineation/routes.js';
import { startRoutes } from './delineation/start.js';
import { divideRoutes } from './delineation/divide.js';
import { jobRoutes } from './jobs/routes.js';
import { modelRoutes } from './model/routes.js';
import { noteRoutes } from './notes/routes.js';
import { portfolioRoutes } from './portfolio/routes.js';
import { publicationRoutes } from './publish/routes.js';
import { projectRoutes } from './projects/routes.js';
import { renderSessionRoutes, reportRoutes } from './reports/routes.js';
import { evidenceRoutes } from './runs/evidence.js';
import { evidenceReportRoutes } from './evidence/report.js';
import { applicantPackRoutes } from './evidence/applicantPacks.js';
import { packSendRoutes } from './evidence/packSend.js';
import { authorisedImpactRoutes } from './evidence/authorisedImpact.js';
import { packRoutes, verifyRoutes } from './evidence/packs.js';
import { reproduceRoutes } from './runs/reproduce.js';
import { runRoutes } from './runs/routes.js';
import { scenarioRoutes } from './scenarios/routes.js';
import { participationRoutes } from './scenarios/participation.js';
import { registrationCheckRoutes } from './signoffs/registrationCheck.js';
import { questionRoutes } from './scenarios/questions.js';
import { uncertaintyRoutes } from './runs/uncertainty.js';
import { seriesRoutes } from './series/routes.js';
import { shareLinkRoutes, sharePublicRoutes } from './share/routes.js';
import { signoffRoutes } from './signoffs/routes.js';
import { sweepRoutes } from './sweeps/routes.js';
import { assessmentRoutes } from './assessments/routes.js';
import { autoCalibrationRoutes } from './calibration/routes.js';
import { outlookRoutes } from './outlooks/routes.js';
import { teamRoutes } from './teams/routes.js';
import { yieldRoutes } from './yield/routes.js';

/**
 * The production entry point (lambda.ts) refuses to start without the
 * CloudFront shared secret: createApp skips the check when it is unset, which
 * is right for local dev and would silently let direct Function URL calls
 * past the WAF in Lambda. Terraform generates 48 characters (s3_cloudfront.tf).
 */
export function assertEdgeSecret(env: NodeJS.ProcessEnv = process.env) {
	if ((env.CLOUDFRONT_SHARED_SECRET ?? '').length < 32) {
		throw new Error('CLOUDFRONT_SHARED_SECRET must be set (≥ 32 characters) in Lambda');
	}
}

export function createApp() {
	const app = new Hono<AuthEnv>();

	// CloudFront-stamped shared secret. In prod, CloudFront stamps every
	// /api/* request with X-CloudFront-Shared-Secret via the origin's
	// custom_header block (see infra/s3_cloudfront.tf). Direct hits to the
	// Function URL — which is publicly reachable by AWS design — are
	// rejected here. Without this check, the bare Function URL bypasses
	// the WAF + per-IP rate limit attached to the CloudFront distribution.
	//
	// Local dev leaves CLOUDFRONT_SHARED_SECRET unset → the check no-ops,
	// because the Hono dev server (port 3001) is reached directly by the
	// dev frontend (port 7777) without CloudFront in the path.
	const sharedSecret = process.env.CLOUDFRONT_SHARED_SECRET ?? '';
	if (sharedSecret) {
		app.use('*', async (c, next) => {
			const provided = Buffer.from(c.req.header('x-cloudfront-shared-secret') ?? '');
			const expected = Buffer.from(sharedSecret);
			if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
				// Counted by the origin-secret-rejected alarm (infra/alarms.tf):
				// direct traffic to the Function URL, past the WAF. The reason only,
				// never the path, the caller's address or what was sent.
				logEvent('warn', { event: 'origin_secret_rejected', reason: provided.length === 0 ? 'missing' : 'mismatch' });
				return c.json({ error: 'forbidden' }, 403);
			}
			// Only now may a route trust what CloudFront stamps (the viewer address, http/clientAddress.ts).
			c.set('edgeVerified', true);
			await next();
		});
	}

	// Before anything reads c.req.path (the CSRF and body-limit exemptions
	// below, the router, a render session's scope): refuse a path whose
	// percent-encoding could route it where the WAF didn't see it going, such
	// as `/%61uth/login` (http/rawPath.ts, docs/security.md § Infrastructure).
	app.use('*', refuseAmbiguousPaths);

	const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:7777')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);

	app.use(
		'*',
		cors({
			origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
			allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			// x-aws-waf-token: the sign-in retry after the WAF's CAPTCHA
			// (frontend lib/auth/wafCaptcha.ts). Only the WAF reads it; the API
			// ignores it. In production the SPA calls same-origin /api, so no
			// preflight; this lets a cross-origin dev or e2e site send it too.
			allowHeaders: ['Content-Type', 'x-aws-waf-token'],
			// Lets the SPA read the export file name when it downloads via fetch().
			exposeHeaders: ['Content-Disposition'],
			// The session is an httpOnly cookie, so the browser must send credentials.
			credentials: true,
			maxAge: 600
		})
	);
	// Session cookies are SameSite=Lax; this additionally rejects cross-origin
	// form posts (the only cross-site writes a browser can make without CORS).
	// One exact route is exempt: POST /alerts/unsubscribe, which a mail
	// client calls as a form post from its own servers (RFC 8058 one-click,
	// no Origin). It reads no session and turns off only the subscription its
	// token names, so a cross-site post gains nothing the token didn't give.
	const csrfCheck = csrf({ origin: allowedOrigins });
	app.use('*', (c, next) => (c.req.method === 'POST' && c.req.path === '/alerts/unsubscribe' ? next() : csrfCheck(c, next)));
	// Largest legitimate body is a time-series upload (60k values ≈ 1 MB JSON).
	// POST /projects/import carries a whole project and sets its own cap (the
	// export cap, IMPORT_MAX_BYTES) on the route; only that exact path skips this one.
	const generalBodyLimit = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) });
	// POST /projects/:id/map/import likewise carries a GeoJSON file of up to 5 MB, with its own cap (geo/routes.ts MAP_IMPORT_BODY_MAX).
	const ownLimit = (c: { req: { method: string; path: string } }) => c.req.method === 'POST' && (c.req.path === '/projects/import' || MAP_IMPORT_PATH.test(c.req.path));
	app.use('*', (c, next) => (ownLimit(c) ? next() : generalBodyLimit(c, next)));

	app.get('/health', (c) => c.json({ ok: true }));

	app.route('/auth', authRoutes);
	app.route('/auth', mfaRoutes);
	app.route('/auth', emailAuthRoutes);
	// The headless report renderer's sign-in: the render token is the credential.
	app.route('/auth', renderSessionRoutes);

	const projects = new Hono<AuthEnv>();
	projects.use('*', requireUser);
	projects.route('/', projectRoutes);
	projects.route('/', modelRoutes);
	projects.route('/', seriesRoutes);
	projects.route('/', runRoutes);
	projects.route('/', uncertaintyRoutes);
	projects.route('/', evidenceRoutes);
	projects.route('/', evidenceReportRoutes);
	projects.route('/', packRoutes);
	projects.route('/', applicantPackRoutes);
	projects.route('/', packSendRoutes);
	projects.route('/', authorisedImpactRoutes);
	projects.route('/', reproduceRoutes);
	projects.route('/', scenarioRoutes);
	projects.route('/', participationRoutes);
	projects.route('/', questionRoutes);
	projects.route('/', signoffRoutes);
	projects.route('/', registrationCheckRoutes);
	projects.route('/', exportRoutes);
	projects.route('/', projectInviteRoutes);
	projects.route('/', jobRoutes);
	projects.route('/', yieldRoutes);
	projects.route('/', sweepRoutes);
	projects.route('/', assessmentRoutes);
	projects.route('/', autoCalibrationRoutes);
	projects.route('/', outlookRoutes);
	projects.route('/', feedRoutes);
	projects.route('/', feedFromBoundaryRoutes);
	projects.route('/', mapRoutes);
	projects.route('/', quaternaryLayerRoutes);
	projects.route('/', stationRoutes);
	projects.route('/', riverRoutes);
	projects.route('/', damRoutes);
	projects.route('/', delineationRoutes);
	projects.route('/', startRoutes);
	projects.route('/', divideRoutes);
	projects.route('/', croplandRoutes);
	projects.route('/', evaporationRoutes);
	projects.route('/', reportRoutes);
	projects.route('/', farmerRoutes);
	projects.route('/', farmViewRoutes);
	projects.route('/', publicationRoutes);
	projects.route('/', historyRoutes);
	projects.route('/', shareLinkRoutes);
	projects.route('/', allocationRoutes);
	projects.route('/', licenceRecordRoutes);
	projects.route('/', noteRoutes);
	projects.route('/', apiKeyRoutes);
	projects.route('/', alertProjectRoutes);
	app.route('/projects', projects);

	// Your own alert choices across projects (WP-2.13).
	const me = new Hono<AuthEnv>();
	me.use('*', requireUser);
	me.route('/', meAlertRoutes);
	// Your own pending invitations: list, accept, decline (issue #136).
	me.route('/', myInviteRoutes);
	app.route('/me', me);

	// One-click unsubscribe from alert emails (WP-2.13): no session, the token is the credential.
	app.route('/alerts', alertPublicRoutes);

	// Read-only share links (WP-2.3 phase 2): no session, the token is the credential.
	app.route('/share', sharePublicRoutes);

	// Verify an evidence pack (WP-3.14): no session; the printed code finds only a pack's public fields (app_verify_pack).
	app.route('/verify', verifyRoutes);

	// The ingest endpoint (WP-2.9): no session, a per-project API key is the credential (ingest/auth.ts).
	app.route('/ingest', ingestRoutes);

	const teams = new Hono<AuthEnv>();
	teams.use('*', requireUser);
	teams.route('/', teamRoutes);
	teams.route('/', teamInviteRoutes);
	teams.route('/', portfolioRoutes);
	app.route('/teams', teams);

	const compare = new Hono<AuthEnv>();
	compare.use('*', requireUser);
	compare.route('/', compareRoutes);
	app.route('/compare', compare);

	app.notFound((c) => c.json({ error: 'not found' }, 404));
	app.onError(handleError);

	return app;
}
