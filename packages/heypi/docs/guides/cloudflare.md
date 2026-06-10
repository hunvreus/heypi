# Deploy on Cloudflare

Deploy heypi on Cloudflare by running the Node.js app in a Container, routing public HTTP traffic through a Worker, and mounting an R2 bucket into the container for durable runtime workspace files.

This guide uses:

- Cloudflare Workers as the HTTPS entrypoint.
- Cloudflare Containers for the long-running heypi process.
- R2 plus FUSE for `runtime.root`.
- A custom durable heypi `Store` for operational state.

Do not put the default SQLite database on the R2 FUSE mount. R2 FUSE is for workspace files, generated files, attachments, memory, skills, and runtime-scoped secrets. heypi's state store needs database semantics and durable locks.

This is best for HTTP adapters and admin routes. Slack Socket Mode, Discord gateway, and Telegram polling can run in a container, but you must test sleep and restart behavior carefully.

Cloudflare references:

- [Containers getting started](https://developers.cloudflare.com/containers/get-started/)
- [Container interface](https://developers.cloudflare.com/containers/container-class/)
- [Mount R2 buckets with FUSE](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/)
- [Lifecycle of a Container](https://developers.cloudflare.com/containers/platform-details/architecture/)

## 1. Prepare the app

Configure heypi to listen on the container port and write runtime files to the R2 mount:

```ts
import { agentFrom, createHeypi, runHeypi, slack, workspace } from "@hunvreus/heypi";
import { durableStore } from "./store";

const app = createHeypi({
	state: { root: "/tmp/heypi-state" },
	store: durableStore,
	http: { host: "0.0.0.0", port: process.env.PORT ?? 3000 },
	adapters: [
		slack({
			// Use HTTP mode when the Worker is the public entrypoint.
		}),
	],
	agent: agentFrom("./agent", { model: "openai/gpt-5.4-mini" }),
	runtime: { root: workspace("/mnt/r2/workspace") },
});

await runHeypi(app);
```

Keep one heypi process per app store. Do not route the same app state to multiple container instances unless your custom store and adapter delivery paths are designed for multi-process ownership.

`state.root` is still required for local admin metadata and fallback paths. It is not the production state backend in this deployment.

## 2. Add a container image

Install FUSE and a FUSE adapter in the image. This example uses `tigrisfs`, which supports S3-compatible storage including R2:

```dockerfile
FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && \
	apt-get install -y --no-install-recommends ca-certificates curl fuse3 util-linux && \
	rm -rf /var/lib/apt/lists/*

RUN ARCH="$(uname -m)" && \
	if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi && \
	if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi && \
	VERSION="$(curl -fsSL https://api.github.com/repos/tigrisdata/tigrisfs/releases/latest | grep -o '\"tag_name\": \"[^\"]*' | cut -d'\"' -f4)" && \
	curl -fsSL "https://github.com/tigrisdata/tigrisfs/releases/download/${VERSION}/tigrisfs_${VERSION#v}_linux_${ARCH}.tar.gz" -o /tmp/tigrisfs.tar.gz && \
	tar -xzf /tmp/tigrisfs.tar.gz -C /usr/local/bin/ && \
	rm /tmp/tigrisfs.tar.gz && \
	chmod +x /usr/local/bin/tigrisfs

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY cloudflare/start.sh /usr/local/bin/start-heypi
RUN chmod +x /usr/local/bin/start-heypi

ENV PORT=3000
EXPOSE 3000

CMD ["start-heypi"]
```

Create `cloudflare/start.sh`:

```sh
#!/bin/sh
set -eu

mkdir -p /mnt/r2 /tmp/heypi-state

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
tigrisfs --endpoint "${R2_ENDPOINT}" -f "${R2_BUCKET_NAME}" /mnt/r2 &

for i in 1 2 3 4 5; do
	if mountpoint -q /mnt/r2; then
		break
	fi
	sleep "$i"
done

if ! mountpoint -q /mnt/r2; then
	echo "R2 FUSE mount failed" >&2
	exit 1
fi

mkdir -p /mnt/r2/workspace

exec npm run start
```

For read-only agent assets, mount with `-o ro`. For heypi runtime workspaces, the mount must allow writes.

## 3. Add the Worker

```ts
import { Container, getContainer } from "@cloudflare/containers";

interface Env {
	HEYPI_CONTAINER: DurableObjectNamespace<HeypiContainer>;
	AWS_ACCESS_KEY_ID: string;
	AWS_SECRET_ACCESS_KEY: string;
	R2_ACCOUNT_ID: string;
	R2_BUCKET_NAME: string;
	OPENAI_API_KEY: string;
	SLACK_BOT_TOKEN: string;
	SLACK_SIGNING_SECRET: string;
	HEYPI_ADMIN_SECRET: string;
}

export class HeypiContainer extends Container<Env> {
	defaultPort = 3000;
	sleepAfter = "30m";

	envVars = {
		AWS_ACCESS_KEY_ID: this.env.AWS_ACCESS_KEY_ID,
		AWS_SECRET_ACCESS_KEY: this.env.AWS_SECRET_ACCESS_KEY,
		R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
		R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
		OPENAI_API_KEY: this.env.OPENAI_API_KEY,
		SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
		SLACK_SIGNING_SECRET: this.env.SLACK_SIGNING_SECRET,
		HEYPI_ADMIN_SECRET: this.env.HEYPI_ADMIN_SECRET,
		PORT: "3000",
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const container = getContainer(env.HEYPI_CONTAINER, "app");
		return container.fetch(request);
	},
};
```

Use one stable container name, such as `app`, for one heypi app store. Do not use random container routing for a stateful heypi app.

## 4. Configure Wrangler

Configure one container-backed Durable Object:

```jsonc
{
	"$schema": "./node_modules/wrangler/config-schema.json",
	"name": "heypi-agent",
	"main": "src/worker.ts",
	"compatibility_date": "2026-06-10",
	"containers": [
		{
			"class_name": "HeypiContainer",
			"image": "./Dockerfile",
			"max_instances": 1
		}
	],
	"durable_objects": {
		"bindings": [
			{
				"name": "HEYPI_CONTAINER",
				"class_name": "HeypiContainer"
			}
		]
	},
	"migrations": [
		{
			"tag": "v1",
			"new_sqlite_classes": ["HeypiContainer"]
		}
	],
	"vars": {
		"R2_BUCKET_NAME": "heypi-agent",
		"R2_ACCOUNT_ID": "your-account-id"
	}
}
```

Set secrets:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put HEYPI_ADMIN_SECRET
```

The R2 access key must have read/write access to the workspace bucket.

## 5. Create storage

Create the R2 bucket used for the runtime workspace:

```bash
npx wrangler r2 bucket create heypi-agent
```

Provision the durable state backend used by your custom `Store`. That backend must persist:

- threads,
- messages,
- turns,
- calls,
- approvals,
- jobs and job runs,
- locks.

If your app uses scheduling, locks must be durable and shared with job state.

## 6. Deploy

Docker must be running locally when Wrangler builds and pushes the image.

```bash
docker info
npx wrangler deploy
```

The first deploy can take several minutes because Wrangler builds the image, pushes it to Cloudflare's container registry, and provisions the container runtime.

## 7. Point providers at the Worker

For HTTP adapters, configure provider callbacks to the Worker URL.

Slack HTTP mode uses the Slack events and interactivity URL:

```bash
heypi slack manifest --mode http --url https://agent.example.com/slack/slack/events
```

Webhook adapters use the webhook URL you configured in the app.

If you enable admin, generate login links from an environment that has the same `HEYPI_ADMIN_SECRET` as the deployed app:

```bash
heypi admin link --url https://agent.example.com
```

If the CLI cannot discover deployed admin state locally, create the login token through your deployment workflow instead of assuming `/tmp/heypi-state` exists on your machine.

## 8. Validate the deployment

Before sending real chat traffic:

```bash
curl -i https://agent.example.com/admin # if admin is enabled
npx wrangler tail
```

Check:

- The configured HTTP route reaches the container.
- `/mnt/r2/workspace` is created after startup.
- A generated attachment survives container restart.
- Memory and skills survive container restart.
- Startup recovery marks interrupted turns correctly after restart.
- Scheduler jobs do not run twice after deploys or restarts.
- The custom store preserves locks across container restarts.

For gateway or polling adapters, also verify that the adapter reconnects cleanly after the container sleeps and wakes. If it misses events or opens duplicate sessions, use HTTP delivery or a non-sleeping host instead.

## Operational limits

This deployment does not make the default SQLite store production-safe on Cloudflare. The production boundary is:

- R2 FUSE: durable runtime workspace files.
- Custom `Store`: durable app state and locks.
- Worker: public routing and optional HTTP auth.
- Container: one running heypi process for one app store.

Local FUSE behavior can differ from the deployed runtime. Test the image locally, but treat the deployed container as the source of truth for mount behavior.

## Validation

Run these checks before sending real chat traffic:

```bash
curl -i https://agent.example.com/admin # if admin is enabled
npx wrangler tail
```

Verify:

- The configured HTTP route responds through the Worker and container.
- `/mnt/r2/workspace` is created after startup.
- A generated attachment written by heypi survives container restart.
- Memory and skills survive container restart.
- Startup recovery handles interrupted turns without duplicate adapter delivery.
- Scheduler jobs do not run twice after deploys or restarts.

If the app uses Slack Socket Mode, Discord gateway, or Telegram polling, also verify behavior after the container sleeps and restarts. If it misses events or starts duplicate sessions, use HTTP delivery or a non-sleeping host instead.

## Known gaps

This guide does not make the default SQLite store production-safe on Cloudflare Containers. A full production deployment needs a durable store implementation with shared locks, migrations, and backup/restore procedures.

Local FUSE behavior may differ from Cloudflare's runtime. Test the image locally, but treat the deployed container as the source of truth for mount behavior.
