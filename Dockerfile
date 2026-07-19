FROM node:20-alpine AS builder

WORKDIR /app
ARG APP_COMMIT_SHA=unknown

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Build the Next.js app (which compiles the UI and API routes)
# We also compile the daemon using tsc if needed, but we can run it via ts-node or compile it.
RUN npm run build
RUN npm exec tsc -- --noEmit

# Production image
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ARG APP_COMMIT_SHA=unknown
ARG APP_DEPLOYED_AT=unknown
ENV APP_COMMIT_SHA=$APP_COMMIT_SHA
ENV APP_DEPLOYED_AT=$APP_DEPLOYED_AT
LABEL org.opencontainers.image.revision=$APP_COMMIT_SHA

# Copy necessary files
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/docker-compose.yml ./docker-compose.yml

# Keep the runtime image within free-tier disk limits. The dashboard only
# needs production packages; the daemon's TypeScript loader is installed
# globally below.
RUN npm prune --omit=dev

# Install tsx for the background daemon
RUN npm install -g tsx@4.19.1

EXPOSE 3000
CMD ["npm", "run", "start"]
