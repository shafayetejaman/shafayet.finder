# File Finder (shafayet.finder)

Fuzzy file finder overlay for the Omarchy shell with live previews: text
heads, directory listings, images, and PDF first-page renders.

## Usage

Open the finder from your configured launcher binding. Keys:

| Key | Action |
| --- | --- |
| printable chars | Type to filter |
| `Esc` | Clear filter, then close |
| `Up` / `Down`, `Ctrl+J` / `Ctrl+K` | Move selection |
| `PageUp` / `PageDown` | Move by 6 rows |
| `Home` / `End` | First / last row |
| `Enter` | Open selection with `xdg-open` |
| `Shift+Enter` | Copy path |
| `Alt+Enter` | Reveal in file manager |

With an empty query the finder browses a start directory (`~/Downloads`
by default) instead of searching.

## Configuration

Every setting has a static default — the plugin works with no entry in
`shell.json` at all. To override any subset, add an entry with this
plugin's `id` to the `plugins` array in `~/.config/omarchy/shell.json`:

```jsonc
{
  // ...
  "plugins": [
    {
      "id": "shafayet.finder",
      "search_dirs": ["$HOME", "/mnt/data"],
      "ignored_dirs": ["$HOME/.cache", "$HOME/go/pkg"],
      "ignored_names": ["target", ".venv", "dist"],
      "browse_dir": "$HOME/Documents",
      "max_scan_results": 100000,
      "max_display_rows": 50,
      "max_browse_rows": 200,
      "preview_byte_limit": 65536,
      "preview_cache_limit": 500,
      "preview_workers": 3,
      "debounce_ms": 25,
      "rescan_interval_ms": 300000,
      "pdf_render_scale": 1200,
      "show_hidden": false,
      "fd_flags": [
        "--ignore-vcs",
        "--hidden",
        "--follow"
      ]
    }
  ]
}
```

Any key you omit keeps its default; unknown keys are ignored. Changes
hot-reload when you save `shell.json`.

### Snappy preset

For the most responsive feel (search results ~30 ms after a keystroke,
instant cached previews, less background rescanning):

```jsonc
{
  "id": "shafayet.finder",
  "debounce_ms": 25,
  "rescan_interval_ms": 300000
}
```

### Keys

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `search_dirs` | string[] | `["$HOME"]` | Roots scanned into the search index. `$HOME` and leading `~` expand. |
| `ignored_dirs` | string[] | `[]` | Paths whose subtree never enters the index. Passed to fd as anchored native excludes, so ignored subtrees are never traversed; a same-named directory elsewhere in the tree is unaffected. |
| `ignored_names` | string[] | `[]` | Directory/file names to skip anywhere in the tree, merged with the built-ins (`node_modules`, `__pycache__`). Native fd excludes. |
| `browse_dir` | string | `$HOME/Downloads` | Directory listed while the query is empty. |
| `max_scan_results` | int | `100000` | Cap on indexed paths per scan. |
| `max_display_rows` | int | `50` | Max rows shown for a query. |
| `max_browse_rows` | int | `200` | Max rows shown in empty-query browse mode. |
| `preview_byte_limit` | int | `65536` | Bytes of file content or directory listing loaded per preview. |
| `preview_cache_limit` | int | `500` | LRU entries kept in memory across opens (per shell session). |
| `preview_workers` | int | `3` | Concurrent preview processes; a slow PDF render never blocks text previews. |
| `debounce_ms` | int | `40` | Delay between keystroke/selection and its search/preview launch. Stale runs are killed by the next keystroke, so low values stay cheap — `25` feels near-instant. |
| `fd_debounce_ms` | int | `1000` | Debounce for flag-mode queries (`--size +5mb …`). These walk real directory trees, so they wait for typing to settle before launching; every keystroke still kills the previous run eagerly. |
| `rescan_interval_ms` | int | `60000` | Minimum time between full index rescans. Reopening the finder inside this window reuses the fresh index instead of re-walking every root. `0` rescans on every open. |
| `pdf_render_scale` | int | `1200` | `-scale-to` value passed to `pdftoppm` for page thumbnails. |
| `show_hidden` | bool | `false` | Skip dot files by default: hidden entries stay out of the index (fd's default) and out of directory previews; `true` adds `--hidden` to classic scans and shows everything. Note fd still surfaces dotfiles explicitly whitelisted in `.gitignore` (like `!.gitkeep`) regardless of this setting. |
| `fd_flags` | string[] | *(unset)* | **Full override** of the flags given to every `fd` invocation — see below. |

### fd_flags: override semantics

When `fd_flags` is set to a non-empty list, it **replaces the entire flag
set** the finder would otherwise use — your flags are passed to a single
`fd` pass verbatim (type selectors included), per search root:

```jsonc
"fd_flags": ["--ignore-vcs", "--type", "file", "--type", "directory", "--hidden", "--follow"]
```

- The finder auto-appends `--absolute-path` if you omit it (the index
  stores absolute paths; results would be unusable without it).
- Configured ignores (`ignored_dirs`, `ignored_names`) are always enforced:
  their native `-E` excludes are appended after your flags, so shell.json
  policy cannot be defeated by override flags.
- Flags must make `fd` print paths — avoid `--exec`, `-x`, or quiet modes.
- Search roots/patterns stay builder-owned; don't pass positional paths.

When `fd_flags` is unset **or empty**, the classic pipeline runs with this
baseline, which you can reproduce explicitly:

```jsonc
"fd_flags": ["--type", "file", "--type", "directory", "--absolute-path"]
```

plus fd's own defaults on top: hidden entries skipped (unless
`show_hidden`), VCS ignores respected (`--ignore-vcs` to relax), symlinks
not followed (`--follow` to relax).

### Inline fd flags in the search box

Any whitespace-separated token starting with `-` is treated as an **fd
flag** and routed to a live `fd` walk over the configured `search_dirs`
(instead of the fuzzy index). The remaining text is staged:

| Query | fd receives | fzf receives |
| --- | --- | --- |
| `invoice` *(no flags)* | — (classic index+fzf path) | `invoice` |
| `--size +5mb invoice` | flags + pattern `invoice` | — |
| `--size=+5mb report paid` | attached value + pattern `report` | `paid` |
| `-e jpg png -- sunset beach` | `-e jpg png` + pattern `sunset` | `beach` |
| `--size +5mb .` | flags + match-all, scoped to the roots | — |
| `--size +5mb` *(flags only)* | nothing runs; list clears instantly | — |
| `-- -weird` | everything after `--` is literal text | `-weird` |

Notes:

- Value flags (`--size/-S`, `--type/-t`, `--max-depth/-d`, `--min-depth`,
  `--changed-within`, `--changed-before`, `--max-results`) consume the next
  token. Variadic flags (`--extension/-e`, `--exclude/-E`) swallow every
  following non-flag token — like fd itself — so end the run with a
  repeated flag or a bare `--` before typing your text.
- Unknown flags pass through verbatim; a typo'd flag fails silently and
  just shows an empty result list.
- The first text token matches fd-style (smart case); further tokens are
  fuzzy-ranked by fzf on top of fd's output.
- Policy ignores (`ignored_dirs`, `ignored_names`) are always enforced, and
  `--absolute-path` is forced regardless of what you type.
- Flag mode reads the live disk, so it works even while the index is still
  scanning. Previews come from the same cache as everywhere else.

## Behavior notes

- The path index lives at `~/.local/state/omarchy/file-finder-list.txt`,
  loads into memory at shell start so first searches are instant, and
  refreshes in the background.
- Each rescan is ONE relay-wrapped `fd` walk over every live search root;
  dead roots are skipped automatically. Directories carry fd's trailing
  `/` marker through to the UI.
- With multiple scanned roots, `ignored_dirs` translates to cross-root
  `**/<suffix>` excludes (fd prunes matching subtrees under any root), and
  nested/overlapping `search_dirs` can list a subtree more than once —
  same as listing it in several roots by hand.
- Preview and PDF caches persist across open/close toggles for the whole
  shell session; revisiting a file re-shows its preview instantly. The
  PDF render cache is the exception: it resets when the finder closes
  (its thumbnail file is removed on close), so a PDF is re-rendered once
  per open rather than kept for the session.
- A search root listed in `ignored_dirs` is skipped entirely — the whole
  subtree stays out of the index.
- Stale work stops eagerly: every keystroke kills superseded search,
  browse, and preview processes instead of letting them run invisibly.

## Files

- `Finder.qml` — overlay UI, process lifecycle, preview worker pool
- `FinderModel.js` — pure helpers: settings resolution, path display,
  command builders (exercisable with `node`)
