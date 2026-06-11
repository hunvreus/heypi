# Host the Pi runner on Modal as a public HTTPS endpoint (a free alternative to Cloudflare
# Containers). The Cloudflare Worker's Durable Object calls this URL via RUNNER_URL, so the agent
# runs here (real Node + Pi) while ingress and per-chat state stay on Cloudflare's free plan.
#
# Deploy:
#   pip install modal && modal token new
#   modal secret create heypi ANTHROPIC_API_KEY=sk-... HEYPI_MODEL=anthropic/claude-sonnet-4-6
#   modal deploy modal_runner.py            # run from the repo root (build context = repo)
#   # -> prints a URL like https://<you>--heypi-runner-runner.modal.run
#   # then set it on the Worker:  wrangler secret put RUNNER_URL   (value = that URL)
#
# Run `modal deploy` from the repo root so the Dockerfile's `COPY . .` sees the whole monorepo.

import subprocess

import modal

# Build the same image used everywhere else (repo-root Dockerfile / .dockerignore apply).
image = modal.Image.from_dockerfile("Dockerfile")

app = modal.App("heypi-runner")


@app.function(image=image, secrets=[modal.Secret.from_name("heypi")], scaledown_window=300)
@modal.concurrent(max_inputs=20)
@modal.web_server(8788, startup_timeout=180)
def runner():
    # ANTHROPIC_API_KEY / HEYPI_MODEL come from the `heypi` Modal secret; the image ENV sets
    # RUNNER_PORT/AGENT_DIR/RUNNER_STATE. The runner binds 0.0.0.0:8788, which Modal exposes.
    subprocess.Popen(
        ["node", "--import", "tsx", "--conditions", "development", "src/container/runner-server.ts"],
        cwd="/app/packages/heypi-cloudflare",
    )
