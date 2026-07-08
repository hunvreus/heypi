# codex-tag

Minimal Pi-native coding-agent example for testing heypi's current feature set.

## Run

```sh
pnpm dev
```

The example always starts a local adapter. Slack starts only when both `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` are set.

Copy `.env.example` to `.env` if you want to configure Slack, state, workspace, or the admin port.

Set `HEYPI_MODEL` to a Pi model id in `provider/model` form, for example `openai/gpt-5.4-mini`.
For OpenAI models, set `OPENAI_API_KEY`; Pi also supports `/login` and other provider env vars.
The admin audit endpoint starts when `admin` is configured and is printed in the startup logs.

## GitHub PR demo

The example uses Docker by default with:

```sh
HEYPI_DOCKER_IMAGE=heypi-codex-tag:local
```

`pnpm dev` builds that image from `Dockerfile` if it is missing. The image is based on the
devcontainer TypeScript/Node image and adds GitHub CLI plus common repo tools. To let Codex inspect
issues, push branches, and open PRs:

- keep `HEYPI_RUNTIME=docker`, or set `HEYPI_RUNTIME=host` to use local tools directly;
- set `GITHUB_TOKEN` in `.env`, or replace the runtime image/volume with a safer GitHub credential
  path;
- set `HEYPI_WORKSPACE` to the repository workspace if you do not want to use the example folder.

`GITHUB_TOKEN` is visible to runtime commands. This is acceptable for a trusted local demo, but it is
not secret isolation. Production GitHub access should move to trusted-side GitHub tools or a
runtime-specific credential broker.

## Useful tests

Long task:

Ask Codex in Slack to inspect a repository issue and prepare a PR. This exercises Slack delivery,
approval rendering, todo updates, memory, and Pi compaction on a realistic coding task.

Risky commands should trigger the approval policy. The local adapter cannot approve, so use Slack to
manually test approval UI.
