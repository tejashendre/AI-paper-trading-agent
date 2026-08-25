FROM node:20-alpine AS builder

WORKDIR /app
ARG APP_COMMIT_SHA=unknown

# Dependencies first so a source-only change reuses this layer.
COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# Build the Next.js app and typecheck the daemons, which ship as TypeScript
# and are executed by tsx at runtime. A type error here must fail the image
# rather than surface as a crash loop on the box.
RUN npm run build
RUN npm exec tsc -- --noEmit

# ---------------------------------------------------------------------------

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ARG APP_COMMIT_SHA=unknown
ARG APP_DEPLOYED_AT=unknown
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_DEPLOYED_AT=$APP_DEPLOYED_AT
LABEL org.opencontainers.image.revision=$APP_COMMIT_SHA

# Install production dependencies directly rather than copying the builder's
# node_modules and pruning afterwards. A prune deletes files from a layer that
# has already been committed, so the dev dependencies stay in the image history
# and keep costing disk — which matters on a free-tier box.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
 && npm install -g tsx@4.19.1 \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Built artefacts and the sources the daemons execute.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/next.config.mjs ./
# `npm run audit:strategy` inspects the compose file and the deploy check from
# inside the container, so both have to travel with the image.
COPY --from=builder /app/docker-compose.yml ./

EXPOSE 3000
CMD ["npm", "run", "start"]
