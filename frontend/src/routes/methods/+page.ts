// How the model is checked: the public summary of the engine audit (issue #57,
// linked from the landing page's trust strip). Prerendered static HTML like the
// legal pages, readable by anyone, signed in or not, with no client-side code
// (csr = false). CloudFront serves it from its .html file (infra/s3_cloudfront.tf,
// spa_rewrite).
export const ssr = true;
export const csr = false;
export const prerender = true;
