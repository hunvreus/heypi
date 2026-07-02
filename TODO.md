# TODO

## Rewrite

- Keep gutting old heypi-owned harness behavior.
- Keep Pi responsible for sessions, transcript, compaction, retries, tools, and
  extension state.
- Keep heypi focused on adapters, config, resource staging, approval UI, and
  later admin/event mirrors.

## Next

- Add built-in approval controls for Discord and Telegram or explicitly document
  that those adapters require `onApproval`.
- Add todo/planning as a Pi extension with heypi rendering, not prompt machinery.
- Add memory as a Pi extension.
- Add an admin/event mirror sourced from Pi and adapter events.
- Add runtime provider boundaries after the Pi-native core is stable.
- Rebuild examples at the end; do not let stale examples drive core design.
