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
can't find stops the build. `pnpm vitest run --config eval/vitest.config.ts site/` tests that.
