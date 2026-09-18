# FB Factory workspace app image. One image per app from the same recipe:
#   docker build --build-arg APP_NAME=dispatch .
# The build stage installs the workspace (postinstall compiles the framework
# packages in dependency order) and then builds the requested template app;
# the runtime stage carries only that app's Nitro output. python3, make, and
# g++ stay in the build stage for node-pty; sharp ships prebuilt binaries.
FROM node:24-slim AS build
WORKDIR /workspace
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
COPY .github ./.github
COPY packages ./packages
COPY templates ./templates
ARG APP_NAME
ARG APP_BASE_PATH
ENV APP_BASE_PATH=$APP_BASE_PATH
ENV VITE_APP_BASE_PATH=$APP_BASE_PATH
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "$APP_NAME..." run build

FROM node:24-slim
WORKDIR /app
ARG APP_NAME
ARG APP_BASE_PATH
ENV NODE_ENV=production
ENV PORT=3000
ENV APP_BASE_PATH=$APP_BASE_PATH
COPY --from=build /workspace/templates/$APP_NAME/.output .output
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
