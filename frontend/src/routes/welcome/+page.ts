// The landing page's own address (issue #57), the one route that is
// prerendered: its HTML is written at build time (welcome.html), so crawlers
// and link previews read the page and its meta tags without running the app,
// and a visitor sees it before any script runs. Every other route stays a
// client-rendered SPA page (routes/+layout.ts). CloudFront serves /welcome
// from welcome.html (infra/s3_cloudfront.tf, spa_rewrite).
export const ssr = true;
export const prerender = true;
