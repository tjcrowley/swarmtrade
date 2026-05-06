FROM node:22-slim
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/registry/package.json ./apps/registry/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile --no-frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm --filter @a2a/registry build
EXPOSE 8080
ENV PORT=8080
CMD ["node", "apps/registry/dist/index.js"]
