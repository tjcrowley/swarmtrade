# Use a simple Node.js Dockerfile to bypass buildpacks entirely
FROM node:22-slim

WORKDIR /app

# Copy lockfile first for better caching
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/registry/package.json ./apps/registry/
COPY packages/types/package.json ./packages/types/

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build and start
RUN pnpm --filter @a2a/registry build

EXPOSE 8080
ENV PORT=8080

CMD ["node", "apps/registry/dist/index.js"]
