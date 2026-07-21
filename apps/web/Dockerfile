# syntax=docker/dockerfile:1

# Begin a dependencies stage from base image
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable

# Set working directory
WORKDIR /app

# Copy manifests to resolve workspace dependency graph
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/web/package.json apps/web/package.json
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
RUN pnpm --filter web build

# Begin a runner stage from base image
FROM node:22-alpine AS runner

# Set working directory
WORKDIR /app

# Define environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy the standalone output from Next.js application
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Document listening port
EXPOSE 3000

# Launch the standalone server with Node
CMD ["node", "apps/web/server.js"]
