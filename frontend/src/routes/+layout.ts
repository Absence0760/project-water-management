// SPA mode. The app is a signed-in tool whose routes (/projects/[id]) depend on
// runtime data, so nothing is prerendered or server-rendered: adapter-static
// emits a single index.html fallback (svelte.config.js) and the client router
// renders every page. Data is fetched from the backend API in the browser.
export const ssr = false;
export const prerender = false;
