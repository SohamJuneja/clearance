/** `node:fs` for the browser build. The policy loader imports it for `loadPolicy(path)`; the page parses the text it carries. */
export function readFileSync(path: string): never {
  throw new Error(`there are no files in the browser, so ${path} can't be read`);
}

export default { readFileSync };
