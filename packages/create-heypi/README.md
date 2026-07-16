# create-heypi

Create a Heypi project from a bundled template:

```sh
pnpm create heypi codex-tag
```

Choose a destination or skip dependency installation:

```sh
pnpm create heypi codex-tag my-agent --no-install
```

Run `pnpm dlx @hunvreus/heypi templates` to list templates. This package delegates to the
scaffolder shipped by `@hunvreus/heypi`.
