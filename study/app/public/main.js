// Browser entry point. A separate file because the page's CSP forbids inline scripts.
import { boot } from "./app.js";

boot({
  root: document.getElementById("app"),
  document,
  fetch: window.fetch.bind(window),
  pathname: window.location.pathname,
  now: () => performance.now(),
  afterPaint: (callback) => requestAnimationFrame(() => requestAnimationFrame(callback)),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  scrollToTop: () => window.scrollTo(0, 0),
});
