# One application image (plan section 04): compiled API and worker entrypoints plus the
# built website. Build from the repository root:
#   docker build -f server/Dockerfile -t sanctum:local .
# API: default command. Worker: `node server/dist/worker.js`. Migrations run only when an
# operator invokes `node server/dist/migrate.js`; the API and worker never apply DDL.
# The shared contracts and SDK packages stay TypeScript and run through Node's type stripping.

FROM mirror.gcr.io/library/node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY server/package.json server/
COPY web-app/package.json web-app/
COPY sdk/typescript/package.json sdk/typescript/
RUN npm ci --no-audit --no-fund
COPY packages/contracts packages/contracts
COPY server server
COPY web-app web-app
COPY sdk/typescript/src sdk/typescript/src
RUN npm run build --workspace web-app && npm run build --workspace server

FROM mirror.gcr.io/library/node:24.19.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY server/package.json server/
COPY web-app/package.json web-app/
COPY sdk/typescript/package.json sdk/typescript/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force
COPY packages/contracts/src packages/contracts/src
COPY sdk/typescript/src sdk/typescript/src
COPY server/migrations-d1 server/migrations-d1
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web-app/dist web-app/dist
# `file:` databases (compose, local runs) live here; on Cloudflare the container reaches D1 through the gateway instead.
RUN mkdir /data && chown node /data
USER node
EXPOSE 7102
CMD ["node", "server/dist/main.js"]
