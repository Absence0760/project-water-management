// A legal page: prerendered static HTML (like /welcome), readable by anyone,
// signed in or not. No client-side code at all (csr = false): it is text and
// links, so it ships no JavaScript and loads nothing but its HTML and CSS.
// CloudFront serves it from its .html file (infra/s3_cloudfront.tf, spa_rewrite).
export const ssr = true;
export const csr = false;
export const prerender = true;
