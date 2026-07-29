# syntax=docker/dockerfile:1

# Begin a dependencies stage from base image
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable

# Set working directory
WORKDIR /app

# Copy manifests to resolve workspace dependency graph
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/api/package.json apps/api/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Begin a builder stage from base image
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat && corepack enable

# Set working directory
WORKDIR /app

# Copy fully installed workspace
COPY --from=deps /app ./
COPY . .

# Build filtered workspace package
RUN pnpm --filter api build

# Prune to a self-contained production bundle
RUN pnpm --filter api deploy --prod /out

# Begin a runner stage from base image
FROM node:22-alpine AS runner

# Set working directory
WORKDIR /app

# Define environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Copy the pruned production bundle
COPY --from=builder /out ./

# Drop root privileges
USER node

# Document listening port
EXPOSE 3001

# Probe the health endpoint with busybox wget
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:3001/health || exit 1

# Launch the compiled server with Node
CMD ["node", "dist/main.js"]
