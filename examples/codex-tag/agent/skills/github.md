---
description: Work with GitHub repositories, issues, pull requests, checks, branches, worktrees, commits, and pushes.
---

# GitHub work

Use `git` for repository operations and `gh` for GitHub issues, pull requests, checks, and HTTPS
credentials. Before pushing, verify `gh auth status`; if Git authentication is not configured, run
`gh auth setup-git`. Never put a token in a remote URL or output.

Repo handling:

- Use `/workspace` as the working root.
- Reuse an existing checkout when it matches the requested repo.
- Clone missing repos under `/workspace/{repo}`.
- If code changes are needed, create a branch before editing.
- Use a worktree for independent/concurrent work on the same repo.
- Do not overwrite unrelated dirty changes.
- Remember durable repo location/default-branch facts when useful.

For PR work:

- Inspect the issue or PR first.
- Commit only relevant files.
- Push and open a PR only when requested.
- Include validation results in the final message.
