<img src=".claude-plugin/icon.png" alt="Pulse Bar icon" width="96" align="right">

# Pulse Bar

A Claude Code mod that adds a single live row just above the prompt, so you can see what Claude is doing at a glance:

```
◐ Bash 0:07 · turn 0:42 │ 12 prompts · 48 tools · 2 ✗ · 37m │ ▁▁▂▁▃▅█▆▃▁▁▂▄▇█▅▂▁▁▁▁▃▅▇  more
```

- **Live activity** – a spinner while a turn runs, the tool in flight (with `+N` for parallel calls), how long that tool has been running, and the turn's elapsed time. Between turns it shows `idle · last turn m:ss`.
- **Session stats** – prompts sent, tool calls, failed or denied calls (`✗`), and session length.
- **Tool sparkline** – tool calls per 10-second bucket over the last 4 minutes, newest on the right. It's drawn as a colored raster in the terminal and as block characters in the desktop and mobile apps.
- **more / less** – toggles two extra lines: your most-used tools this session, and your **lifetime totals** across every session:

  ```
  Top tools: Bash 30 · Read 18 · Edit 9
  Lifetime since Nov 19, 2026: 214 prompts · 1,830 tools · 41 ✗ · top Bash 702, Read 410, Edit 200
  ```

- **`/pulse-reset`** – sets the lifetime totals back to zero and starts counting again from now. This session's stats stay as they are.

Session stats start fresh each session. Lifetime totals are kept in the mod's own plugin store on your machine. That store holds only the counts and tool names, never prompts, commands or file contents, and nothing leaves your machine. The mod only observes. If one of its hooks fails, your prompts and tool calls carry on untouched.

If you run several sessions at once, they all add to the same lifetime totals. Each update re-reads the stored totals before adding to them, so concurrent sessions rarely lose a count. It can still happen if two sessions write at the same instant, so treat the totals as close, not exact.

On a narrow window the row drops the sparkline (under 72 columns), then the stats (under 44 columns), and keeps the live state.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pulse-bar --marketplace aaronsells/-aaronsells-pulse-bar
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install pulse-bar --marketplace aaronsells/-aaronsells-pulse-bar
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `aaronsells/-aaronsells-pulse-bar`, then **Add plugin**.

## Develop

```
claude --plugin-dir .          # run it from this folder; edits hot-reload
claude plugin validate .       # check the manifest and hooks module
claude plugin test .           # run tests/*.test.tsx
```

| File | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | manifest |
| `.claude-plugin/marketplace.json` | makes this repo installable with `/plugin install` |
| `hooks/register.tsx` | the hooks module: event tracking, lifetime persistence, `/pulse-reset`, and the band's drawing |
| `types/index.d.ts` | the `$.state` contract for the values the band reads |
| `tests/pulse-bar.test.tsx` | tests across the terminal, desktop and mobile surfaces |

Mods use Claude Code's function-hooks API, which is in early access and may change between releases.

## License

MIT, see [LICENSE](LICENSE).
