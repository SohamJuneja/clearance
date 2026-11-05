# Acme Mini. Build from the repo root so pnpm can read the workspace:
#   docker build -f packages/acme/Dockerfile -t clearance-acme .
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.14.0

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/acme/package.json packages/acme/
RUN pnpm install --filter @clearance/acme --frozen-lockfile

COPY packages/acme packages/acme

ENV ACME_HOST=0.0.0.0 ACME_PORT=7800 ACME_DB_PATH=/data/acme.sqlite NODE_ENV=production
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 7800

WORKDIR /repo/packages/acme
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:7800/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
