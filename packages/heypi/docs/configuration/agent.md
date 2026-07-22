# Agent configuration

`loadAgent(root, options)` loads one agent folder and returns the configuration consumed by
`runHeypi()` or `createHeypi()`.

```ts
const agent = loadAgent("./agent", {
	id: "support",
	model: modelFromEnv(),
	runtime: host({ workspace: "./workspace" }),
	state: { dir: ".heypi" },
	admin: false,
	tools: {},
	todo: true,
	memory: true,
});
```

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `id` | Agent folder name | Stable identity used in logs and staging |
| `model` | Pi/provider configuration | Model used for new Pi sessions |
| `runtime` | Host execution with warning | Runtime-backed core file and shell tools |
| `state.dir` | `.heypi` | Persistent coordination and session root |
| `admin` | `false` | Local admin HTTP surface |
| `tools` | `{}` | Disable, approve, or register tools by name |
| `todo` | `true` | Built-in todo extension and adapter rendering |
| `memory` | `true` | Curated memory and explicit search |
| `noTools` | Pi default | Disable Pi's core tool registration |

`modelFromEnv()` reads `HEYPI_MODEL` in `provider/model` form. Provider credentials use Pi's normal
environment-variable support.

## Files and staging

`system.md` becomes Pi's `SYSTEM.md`; `instructions.md` becomes `APPEND_SYSTEM.md`. Skills, authored
tools, and extensions remain Pi-native resources. Schedules are trusted heypi modules and are not
exposed as agent resources.

heypi stages a clean copy under the state directory, excluding `.git`, `.heypi`, and `node_modules`.
The model and runtime see managed `/agent` paths, not source-tree host paths.
