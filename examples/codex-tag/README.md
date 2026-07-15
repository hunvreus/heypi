# Codex Tag

Pi-native coding agent for testing heypi's current feature set. This directory is both a runnable
workspace example and the source copied by `heypi create codex-tag`.

## Run

```sh
pnpm dev
```

The example always starts a local adapter. Slack starts only when both `SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` are set.

Copy `.env.example` to `.env` if you want to configure Slack, the Docker image, or the admin port.

Set `HEYPI_MODEL` to a Pi model id in `provider/model` form, for example `openai/gpt-5.4-mini`.
For OpenAI models, set `OPENAI_API_KEY`; Pi also supports `/login` and other provider env vars.
The admin audit endpoint starts when `admin` is configured and is printed in the startup logs.

## Web tools

The example includes two custom Pi tools:

- `web_search`: searches the public web. Set `TAVILY_API_KEY` for Tavily search; otherwise it falls
  back to DuckDuckGo HTML.
- `fetch_page`: fetches public HTTP(S) pages and returns cleaned text. It blocks localhost/private
  IP targets unless `HEYPI_ALLOW_PRIVATE_WEB=1` is set.

## GitHub PR demo

The example explicitly uses Docker with:

```sh
HEYPI_DOCKER_IMAGE=heypi-codex-tag:local
```

`pnpm dev` builds that image from `Dockerfile` if it is missing. The image is based on the
devcontainer TypeScript/Node image and adds GitHub CLI plus common repo tools. To let Codex inspect
issues, push branches, and open PRs:

- set `GITHUB_TOKEN` in `.env`, or replace the runtime image/volume with a safer GitHub credential
  path;

Heypi keeps state and conversation workspaces under `.heypi` because the example does not override
those framework defaults.

`GITHUB_TOKEN` is visible to runtime commands. This is acceptable for a trusted local demo, but it is
not secret isolation. Production GitHub access should move to trusted-side GitHub tools or a
runtime-specific credential broker.

The bundled image configures Git's HTTPS credential helper through `gh`, so both `git push` and
GitHub CLI commands use `GITHUB_TOKEN` without embedding it in repository remotes.

## Useful tests

Long task:

Ask Codex in Slack to inspect a repository issue and prepare a PR. This exercises Slack delivery,
approval rendering, todo updates, memory, and Pi compaction on a realistic coding task.

Risky commands should trigger the approval policy. The local adapter cannot approve, so use Slack to
manually test approval UI.
