# Pi runner container for the Cloudflare Containers deployment.
# Runs the heypi agent (Node) and exposes POST /run on 8788; the Worker's Durable Object reaches it
# through the PI_RUNNER binding. Build context is the repo root (a pnpm monorepo).
FROM node:22-slim

# Python is required by Modal (it bootstraps its function runtime in the image); harmless and unused
# on the Cloudflare Containers path.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 python3-pip python-is-python3 \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

ENV RUNNER_PORT=8788 \
	AGENT_DIR=/app/packages/heypi-cloudflare/agent \
	RUNNER_STATE=/app/.runner-state
WORKDIR /app/packages/heypi-cloudflare
EXPOSE 8788
# The runner reads its model + provider key from env (injected by the PiRunner container class).
CMD ["node", "--import", "tsx", "--conditions", "development", "src/container/runner-server.ts"]
