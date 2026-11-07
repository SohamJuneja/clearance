# Clearance site

One static page. `site/dist/` is ready to deploy as it is: any static host, no build step.

- Vercel: import the repo, framework "Other", no build command, output directory `site/dist`.
- GitHub Pages or Netlify: publish the `site/dist` folder.

To rebuild after the results change, or once the demo video has a public link:

```bash
pnpm site:build                                              # numbers from the README's results table
CLEARANCE_VIDEO_URL=https://youtu.be/<id> pnpm site:build    # the video section links to the upload
```

Every number on the page is filled in by `site/build.ts` from the table `pnpm eval:report` writes into README.md. A number it
can't find stops the build. The commands under "Run it" and the Switch capabilities come from the README too.

"Try it" runs Clearance's own classifier and policy engine in the browser: `site/dist/playground.js` is core's
`evaluateAction` and policy loader, bundled with esbuild, with `policy/clearance.policy.yaml` inside. Two small stand-ins in
`site/playground/shims/` replace `node:path` and `node:crypto`. The examples on the page, and its first answer, are decided by
core while the page is built.

```bash
pnpm vitest run --config eval/vitest.config.ts site/
```

tests the build, holds both stand-ins to Node's own answers, and runs every case in `policy/tests/` through the bundle and
through core: they have to agree on every field, call_hash included.
