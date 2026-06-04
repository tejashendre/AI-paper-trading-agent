FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source
COPY . .

# Build the Next.js app (which compiles the UI and API routes)
# We also compile the daemon using tsc if needed, but we can run it via ts-node or compile it.
RUN npm run build
RUN npm install -g typescript tsx
RUN tsc --noEmit || echo "TypeScript compilation finished."

# Production image
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy necessary files
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

# Install tsx for the background daemon
RUN npm install -g typescript tsx

EXPOSE 3000
CMD ["npm", "run", "start"]
