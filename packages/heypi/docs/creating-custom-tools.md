# Creating custom tools

Custom tools are trusted code. heypi cannot infer what a custom tool does internally, so tool authors
must make side effects explicit.

## Register tools through Pi extensions

Put authored tool extensions in `agent/tools/` or `agent/extensions/`.

```text
agent/tools/example.ts
```

The file should register Pi tools using Pi's extension API. Keep schemas narrow and return compact,
structured results.

## Command and file effects

If a custom tool needs shell or file side effects, route them through the configured heypi/Pi runtime
operations or explicitly require approval.

Do not hide private command execution inside a custom tool if you expect heypi approvals or runtime
policy to see it.

Bad:

```ts
import { execFile } from "node:child_process";

// This bypasses heypi's approval/runtime boundary.
execFile("git", ["push"]);
```

Better:

- expose the operation as a Pi tool call guarded by the approval policy;
- or call a heypi-provided runtime operation once runtime providers are implemented;
- or configure approval for the custom tool name.

```ts
import { approval } from "@hunvreus/heypi";

const agent = loadAgent("./agent", {
  tools: {
    deploy_prod: {
      approve: approval.always("Deploy production."),
    },
  },
});
```

## Approval expectations

Approvals are opt-in per tool. heypi does not inspect arbitrary custom tool internals. Add explicit
approval for risky custom tools.

## Result size

Return concise results. Pi owns tool result handling and compaction, but large unnecessary output
still slows the session and makes poor chat UX.
