# File Finder (shafayet.finder)

Fuzzy file finder overlay for the Omarchy shell with live previews: text
heads, directory listings, images, PDF first-page renders, and video frame grabs.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8c5db8a4-c0ad-4921-a1db-7de8608835be" />


https://github.com/user-attachments/assets/c07ae865-26f7-41d2-b890-42eb8456685f

## Install

```bash
omarchy plugin install https://github.com/shafayetejaman/shafayet.finder.git --enable
```

## Remove

```bash
omarchy plugin remove shafayet.finder
```

## Dependencies

| Tool                                                        | Preinstalled with Omarchy | Needed for                        | Install if missing                  |
| ----------------------------------------------------------- | ------------------------- | --------------------------------- | ----------------------------------- |
| `fd`                                                        | Yes                       | Search index and flag-mode queries | `sudo pacman -S --needed fd`       |
| `fzf`                                                       | Yes                       | Fuzzy ranking of results          | `sudo pacman -S --needed fzf`       |
| [`poppler`](https://poppler.freedesktop.org/) (`pdftoppm`)  | No                        | PDF page thumbnails               | `sudo pacman -S --needed poppler`   |
| `ffmpeg`                                                    | No                        | Video frame previews              | `sudo pacman -S --needed ffmpeg`    |
| [`trash-cli`](https://github.com/andreafrancia/trash-cli)   | No                        | Delete-to-trash keybind           | `sudo pacman -S --needed trash-cli` |

Optional tools degrade gracefully: without them the finder still works, minus
that one feature (PDF/video previews report unavailable, trash key reports an
error).

## Usage

Open the finder from your configured launcher binding. Keys:

| Key                                | Action                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| printable chars                    | Type to filter                                                                            |
| `Esc`                              | Clear filter, then close                                                                  |
| `Ctrl+Backspace`                   | Delete last query word                                                                    |
| `Up` / `Down`, `Ctrl+J` / `Ctrl+K` | Move selection                                                                            |
| `PageUp` / `PageDown`              | Move by 6 rows                                                                            |
| `Home` / `End`                     | First / last row                                                                          |
| `Enter`                            | Open selection with `xdg-open`                                                            |
| `Shift+Enter`                      | Copy path                                                                                 |
| `Alt+Enter`                        | Reveal in file manager                                                                    |
| `Delete` / `Ctrl+D`                | Move selection to trash (needs [`trash-cli`](https://github.com/andreafrancia/trash-cli)) |

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
      "pdf_cache_limit": 12,
      "preview_workers": 3,
      "debounce_ms": 25,
      "fd_debounce_ms": 1000,
      "rescan_interval_ms": 300000,
      "pdf_render_scale": 1200,
      "show_hidden": false,
      "fd_flags": ["--ignore-vcs", "--follow"],
    },
  ],
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
  "fd_debounce_ms": 200,
  "rescan_interval_ms": 300000,
}
```

Lowering `fd_debounce_ms` also speeds up flag-mode queries (`--size +5mb …`);
stale runs are killed on every keystroke, so even aggressive values stay safe.

### Keys

| Key                   | Type     | Default           | Description                                                                                                                                                                                                                                                                                       |
| --------------------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_dirs`         | string[] | `["$HOME"]`       | Roots scanned into the search index. `$HOME` and leading `~` expand.                                                                                                                                                                                                                              |
| `ignored_dirs`        | string[] | `[]`              | Paths whose subtree never enters the index. Passed to fd as anchored native excludes, so ignored subtrees are never traversed; a same-named directory elsewhere in the tree is unaffected.                                                                                                        |
| `ignored_names`       | string[] | `[]`              | Directory/file names to skip anywhere in the tree, merged with the built-ins (`node_modules`, `__pycache__`). Native fd excludes.                                                                                                                                                                 |
| `browse_dir`          | string   | `$HOME/Downloads` | Directory listed while the query is empty.                                                                                                                                                                                                                                                        |
| `max_scan_results`    | int      | `100000`          | Cap on indexed paths per scan.                                                                                                                                                                                                                                                                    |
| `max_display_rows`    | int      | `50`              | Max rows shown for a query.                                                                                                                                                                                                                                                                       |
| `max_browse_rows`     | int      | `200`             | Max rows shown in empty-query browse mode.                                                                                                                                                                                                                                                        |
| `preview_byte_limit`  | int      | `65536`           | Bytes of file content or directory listing loaded per preview.                                                                                                                                                                                                                                    |
| `preview_cache_limit` | int      | `500`             | LRU entries kept in memory across opens (per shell session).                                                                                                                                                                                                                                      |
| `pdf_cache_limit`     | int      | `12`              | Rendered thumbnails (PDF pages and video frames) kept in memory across opens (LRU). Thumbnails are held as self-contained images, so entries never go stale; raise only if you browse many large documents.                                                                                       |
| `thumbnail_cache_limit` | int    | `500`             | Rendered thumbnails kept **on disk** per kind in `~/.cache/thumbnails/shafayet.finder/{pdf,video}/`, so a fresh shell session reuses pixels instead of re-running `pdftoppm`/`ffmpeg`. Entries are keyed by `<path|size|mtime|inode>`, so an edited or replaced file never gets a stale hit; the oldest files are pruned after each save. Set to `0` to disable persistence entirely. |
| `preview_workers` | int | `3` | Concurrent preview processes; a slow PDF render never blocks text previews. Clamped to **1–3**: `1` means strictly serial previews, and more than 3 can never be used (selected row + two prefetched neighbors). |
| `debounce_ms`         | int      | `40`              | Delay between keystroke/selection and its search/preview launch. Stale runs are killed by the next keystroke, so low values stay cheap — `25` feels near-instant.                                                                                                                                 |
| `fd_debounce_ms`      | int      | `1000`            | Debounce for flag-mode queries (`--size +5mb …`). These walk real directory trees, so they wait for typing to settle before launching; every keystroke still kills the previous run eagerly.                                                                                                      |
| `rescan_interval_ms`  | int      | `60000`           | Minimum time between full index rescans. Reopening the finder inside this window reuses the fresh index instead of re-walking every root. `0` rescans on every open.                                                                                                                              |
| `pdf_render_scale`    | int      | `1200`            | `-scale-to` value passed to `pdftoppm` for page thumbnails; also caps extracted video frame width. Clamped to **64–4000**. |
| `show_hidden`         | bool     | `false`           | Skip dot files by default: hidden entries stay out of the index (fd's default) and out of directory previews; `true` adds `--hidden` to classic scans and shows everything. Note fd still surfaces dotfiles explicitly whitelisted in `.gitignore` (like `!.gitkeep`) regardless of this setting. |
| `fd_flags`            | string[] | _(unset)_         | **Full override** of the flags given to every `fd` invocation — see below.                                                                                                                                                                                                                        |

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

| Query                        | fd receives                            | fzf receives |
| ---------------------------- | -------------------------------------- | ------------ |
| `invoice` _(no flags)_       | — (classic index+fzf path)             | `invoice`    |
| `--size +5mb invoice`        | flags + pattern `invoice`              | —            |
| `--size=+5mb report paid`    | attached value + pattern `report`      | `paid`       |
| `-e pdf .`                   | extension filter + match-all           | —            |
| `--ext pdf .`                | same — `--ext` is accepted as an alias of `-e` | —    |
| `-e jpg -e png report`       | repeated extensions + pattern `report` | —            |
| `-E node_modules report`     | exclude glob + pattern `report`        | —            |
| `--size +5mb .`              | flags + match-all, scoped to the roots | —            |
| `--size +5mb` _(flags only)_ | nothing runs; list clears instantly    | —            |
| `-- -weird`                  | everything after `--` is literal text  | `-weird`     |

Notes:

- Size values must use fd's constraint form with the sign **first**:
  `--size +5mb` (at least 5 MB), `--size -1gb` (at most 1 GB), `--size +2mb -10mb`… fd
  rejects the trailing form (`--size 2mb+`) outright, which then shows an
  empty list.
- Every value flag consumes exactly **one** following token — fd's CLI has no
  variadic flags. This includes `--size/-S`, `--type/-t`, `--max-depth/-d`,
  `--min-depth`, `--changed-within`, `--changed-before`, `--max-results`,
  `--extension`/`--ext`/`-e`, and `--exclude/-E`. Repeat `-e`/`-E` for multiple
  extensions or globs (`-e pdf -e txt .`), exactly as you would when running
  fd directly. A bare `--` ends flag parsing; everything after it is literal
  text. `--ext` (and `--ext=pdf`) is accepted as a finder-side alias for
  fd's `--extension`, which fd itself does not provide.
- Unknown flags pass through verbatim; a typo'd flag fails silently and
  just shows an empty result list.
- The first text token matches fd-style (smart case); the remaining tokens are
  the staged query, ranked fzf-style. The flags+pattern walk runs once and its
  full output is kept in memory: while it stays fixed, **editing the staged
  text in either direction — adding or deleting words — refilters instantly
  with no second walk, no debounce, and no clearing**, using an in-process
  fzf approximation (whitespace terms AND independently, contiguity/boundary
  scoring). Changing the flags, the pattern, or relevant settings re-walks
  after `fd_debounce_ms`, which also re-syncs ranking with real fzf.
- Policy ignores (`ignored_dirs`, `ignored_names`) are always enforced, and
  `--absolute-path` is forced regardless of what you type.
- Flag mode reads the live disk, so it works even while the index is still
  scanning. Previews come from the same cache as everywhere else.
- Execution flags (`-x`/`--exec`, `-X`/`--exec-batch`) are never passed to
  `fd`: typing them in the search box demotes them — and everything after
  them — to literal search text, so the finder can never run commands.

## Behavior notes

- The path index lives at `~/.local/state/omarchy/file-finder-list.txt`,
  loads into memory at shell start so first searches are instant, and
  refreshes in the background.
- Each rescan is ONE relay-wrapped `fd` walk over every live search root;
  dead roots are skipped automatically. Directories carry fd's trailing
  `/` marker through to the UI.
- With multiple scanned roots, `ignored_dirs` translates to cross-root
  `**/<suffix>` excludes (fd prunes matching subtrees under any root).
  Nested or overlapping `search_dirs` are pruned automatically to the
  outermost containing root, so every path is indexed exactly once no
  matter how the roots are listed.
- Preview and PDF caches persist across open/close toggles for the whole
  shell session; revisiting a file re-shows its preview instantly. Rendered
  thumbnails (PDF pages and video frames) are kept as in-memory images
  (bounded by `pdf_cache_limit`), so switching between items always shows
  each one's own thumbnail. A render larger than 3 MB of PNG is refused and
  reported as "Thumbnail too large" instead of being loaded, so a crafted
  document or an extreme `pdf_render_scale` cannot balloon memory; renders
  happen inside private mode-0700 scratch directories that are removed
  afterwards.
- Successful thumbnails also land on disk under
  `~/.cache/thumbnails/shafayet.finder/{pdf,video}/` (`XDG_CACHE_HOME`
  honored), named by `md5("<path>|<size>|<mtime>|<inode>")` so an edited
  source can never produce a stale hit. The first preview of a session is
  then served straight off disk — no `pdftoppm`/`ffmpeg` run at all. The
  store is capped per kind by `thumbnail_cache_limit` (oldest pruned after
  each save); `0` disables it and restores purely in-memory behavior.
  Oversized or failed renders are never persisted, so retrying still works.
  The plugin keeps its own subdirectory rather than writing freedesktop-spec
  entries other apps garbage-collect.
- Warm flag-mode refiltering scores up to `max_scan_results` rows client-side
  per keystroke — instant on typical trees; very large walks may add a few ms.
- Video previews show a representative frame grabbed by `ffmpeg` (1s in,
  falling back to the first frame for shorter clips) using the same
  `pdf_render_scale` cap and thumbnail cache as PDFs. Without ffmpeg the
  preview pane reports the file unreadable; everything else keeps working.
- A search root listed in `ignored_dirs` is skipped entirely — the whole
  subtree stays out of the index.
- Stale work stops eagerly: every keystroke kills superseded search,
  browse, and preview processes instead of letting them run invisibly.

## Files

- `Finder.qml` — overlay UI, process lifecycle, preview worker pool
- `FinderModel.js` — pure helpers: settings resolution, path display,
  command builders (exercisable with `node`)

## License

[MIT](LICENSE)
