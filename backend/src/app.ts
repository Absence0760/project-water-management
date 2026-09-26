import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { requireUser, type AuthEnv } from './auth/middleware.js';
import { emailAuthRoutes } from './auth/email-routes.js';
import { authRoutes } from './auth/routes.js';
import { compareRoutes } from './compare/routes.js';
import { exportRoutes } from './export/routes.js';
import { farmerRoutes } from './farms/routes.js';
import { handleError } from './http/errors.js';
import { projectInviteRoutes, teamInviteRoutes } from './invites/invites.js';
import { feedRoutes } from './feeds/routes.js';
import { jobRoutes } from './jobs/routes.js';
import { modelRoutes } from './model/routes.js';
import { projectRoutes } from './projects/routes.js';
import { evidenceRoutes } from './runs/evidence.js';
import { runRoutes } from './runs/routes.js';
import { scenarioRoutes } from './scenarios/routes.js';
import { uncertaintyRoutes } from './runs/uncertainty.js';
import { seriesRoutes } from './series/routes.js';
import { teamRoutes } from './teams/routes.js';

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
				return c.json({ error: 'forbidden' }, 403);
			}
			await next();
		});
	}

	const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:7777')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);

	app.use(
		'*',
		cors({
			origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
			allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type'],
			// Lets the SPA read the export file name when it downloads via fetch().
			exposeHeaders: ['Content-Disposition'],
			// The session is an httpOnly cookie, so the browser must send credentials.
			credentials: true,
			maxAge: 600
		})
	);
	// Session cookies are SameSite=Lax; this additionally rejects cross-origin
	// form posts (the only cross-site writes a browser can make without CORS).
	app.use('*', csrf({ origin: allowedOrigins }));
	// Largest legitimate body is a time-series upload (60k values ≈ 1 MB JSON).
	// POST /projects/import carries a whole project and sets its own cap (the
	// export cap, IMPORT_MAX_BYTES) on the route; only that exact path skips this one.
	const generalBodyLimit = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request too large' }, 413) });
	app.use('*', (c, next) => (c.req.method === 'POST' && c.req.path === '/projects/import' ? next() : generalBodyLimit(c, next)));

	app.get('/health', (c) => c.json({ ok: true }));

	app.route('/auth', authRoutes);
	app.route('/auth', emailAuthRoutes);

	const projects = new Hono<AuthEnv>();
	projects.use('*', requireUser);
	projects.route('/', projectRoutes);
	projects.route('/', modelRoutes);
	projects.route('/', seriesRoutes);
	projects.route('/', runRoutes);
	projects.route('/', uncertaintyRoutes);
	projects.route('/', evidenceRoutes);
	projects.route('/', scenarioRoutes);
	projects.route('/', exportRoutes);
	projects.route('/', projectInviteRoutes);
	projects.route('/', jobRoutes);
	projects.route('/', feedRoutes);
	projects.route('/', farmerRoutes);
	app.route('/projects', projects);

	const teams = new Hono<AuthEnv>();
	teams.use('*', requireUser);
	teams.route('/', teamRoutes);
	teams.route('/', teamInviteRoutes);
	app.route('/teams', teams);

	const compare = new Hono<AuthEnv>();
	compare.use('*', requireUser);
	compare.route('/', compareRoutes);
	app.route('/compare', compare);

	app.notFound((c) => c.json({ error: 'not found' }, 404));
	app.onError(handleError);

	return app;
}
