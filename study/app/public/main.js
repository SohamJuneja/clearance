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
  // Under any real read of a card, and over the gap in a double tap.
  tapGuardMs: 600,
});

// Back and forward can restore this page from memory, as it was. The server knows where the session really is.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
