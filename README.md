# File Finder

Quick Fuzzy file finder overlay for the Omarchy shell with live previews: text
heads, directory listings, images, PDF first pages, and video frame grabs.

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

| Tool                                                       | Preinstall | Needed for                         | Install if missing                  |
| ---------------------------------------------------------- | ---------- | ---------------------------------- | ----------------------------------- |
| `fd`                                                       | Yes        | Search index and flag-mode queries | `sudo pacman -S --needed fd`        |
| `fzf`                                                      | Yes        | Fuzzy ranking of results           | `sudo pacman -S --needed fzf`       |
| [`poppler`](https://poppler.freedesktop.org/) (`pdftoppm`) | No         | PDF page thumbnails                | `sudo pacman -S --needed poppler`   |
| `ffmpeg`                                                   | No         | Video frame previews               | `sudo pacman -S --needed ffmpeg`    |
| [`trash-cli`](https://github.com/andreafrancia/trash-cli)  | No         | Delete-to-trash keybind            | `sudo pacman -S --needed trash-cli` |

Optional tools degrade gracefully: the finder works without them, minus that
one feature.

## Usage

Open the finder from your configured launcher binding and start typing. With
an empty query it browses a start directory instead of searching.

| Key                     | Action                   |
| ----------------------- | ------------------------ |
| any printable character | Type to filter           |
| `Esc`                   | Clear filter, then close |
| `Ctrl+Backspace`        | Delete last query word   |
| `Up` / `Down`           | Move selection           |
| `Ctrl+J` / `Ctrl+K`     | Move selection           |
| `PageUp` / `PageDown`   | Move by 6 rows           |
| `Home` / `End`          | First / last row         |
| `Enter`                 | Open with `xdg-open`     |
| `Shift+Enter`           | Copy path                |
| `Alt+Enter`             | Reveal in file manager   |
| `Delete` / `Ctrl+D`     | Move selection to trash  |

Trash requires [`trash-cli`](https://github.com/andreafrancia/trash-cli).

## Configuration

The plugin works with no configuration. To override anything, add an entry
with this plugin's `id` to the `plugins` array in
`~/.config/omarchy/shell.json`:

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

```jsonc
{
  "id": "shafayet.finder",
  "debounce_ms": 25,
  "fd_debounce_ms": 200,
  "rescan_interval_ms": 300000,
}
```

Search results land ~30 ms after a keystroke, previews come from cache, and
background rescanning is rare. Stale runs are killed on every keystroke, so
aggressive values stay safe.

### Settings

| Key                     | Type       | Default           | Description                                                                        |
| ----------------------- | ---------- | ----------------- | ---------------------------------------------------------------------------------- |
| `search_dirs`           | `string[]` | `["$HOME"]`       | Roots scanned into the index. `$HOME` and leading `~` expand.                      |
| `ignored_dirs`          | `string[]` | `[]`              | Subtrees never indexed (native fd excludes, pruned before traversal).              |
| `ignored_names`         | `string[]` | `[]`              | Names skipped anywhere, merged with built-ins `node_modules` and `__pycache__`.    |
| `browse_dir`            | `string`   | `$HOME/Downloads` | Directory listed while the query is empty.                                         |
| `max_scan_results`      | `int`      | `100000`          | Cap on indexed paths per scan.                                                     |
| `max_display_rows`      | `int`      | `50`              | Max rows shown for a query.                                                        |
| `max_browse_rows`       | `int`      | `200`             | Max rows shown in browse mode.                                                     |
| `preview_byte_limit`    | `int`      | `65536`           | Bytes of content loaded per preview.                                               |
| `preview_cache_limit`   | `int`      | `500`             | In-memory preview LRU entries (per shell session).                                 |
| `pdf_cache_limit`       | `int`      | `12`              | In-memory thumbnail LRU entries (PDF pages and video frames).                      |
| `thumbnail_cache_limit` | `int`      | `500`             | On-disk thumbnails per kind; `0` disables persistence. See behavior notes.         |
| `preview_workers`       | `int`      | `3`               | Concurrent preview processes, clamped to `1`–`3`.                                  |
| `debounce_ms`           | `int`      | `40`              | Delay from keystroke/selection to its search/preview launch.                       |
| `fd_debounce_ms`        | `int`      | `1000`            | Debounce for flag-mode queries, which walk real directory trees.                   |
| `rescan_interval_ms`    | `int`      | `60000`           | Minimum time between full rescans; `0` rescans on every open.                      |
| `pdf_render_scale`      | `int`      | `1200`            | `-scale-to` for page thumbnails; also caps video frame width. Clamped `64`–`4000`. |
| `show_hidden`           | `bool`     | `false`           | Include dot files in scans and directory previews.                                 |
| `fd_flags`              | `string[]` | _(unset)_         | **Full override** of the flags given to every `fd` call — see below.               |

### fd_flags override semantics

Setting `fd_flags` replaces the **entire** flag set used for scanning:

```jsonc
"fd_flags": ["--ignore-vcs", "--type", "file", "--type", "directory", "--hidden", "--follow"]
```

- `--absolute-path` is auto-appended if missing (the index stores absolute paths).
- `--color=never` is auto-appended if missing: fd honors `CLICOLOR_FORCE` even
  when piped, and ANSI bytes would corrupt the index. Pass your own `--color`
  spelling to opt out.
- Configured ignores stay enforced no matter what you set here.
- Flags must make `fd` print paths; positionals are builder-owned.

Unset or empty falls back to the classic baseline:

```jsonc
"fd_flags": ["--type", "file", "--type", "directory", "--color=never", "--absolute-path"]
```

plus fd's own defaults: hidden entries skipped (unless `show_hidden`), VCS
ignores respected (`--ignore-vcs` relaxes), symlinks not followed
(`--follow` relaxes).

## Inline fd flags in the search box

Any whitespace-separated token starting with `-` routes the query to a live
`fd` walk over `search_dirs` instead of the fuzzy index. The first remaining
text token is the fd pattern; the rest is staged text ranked fzf-style.

| Query                     | Behavior                                         |
| ------------------------- | ------------------------------------------------ |
| `invoice`                 | Classic fuzzy search over the index              |
| `--size +5mb invoice`     | Size-filtered walk, pattern `invoice`            |
| `--size=+5mb report paid` | Attached values work; `paid` goes to fzf staging |
| `-e pdf .`                | Extension filter with match-all pattern          |
| `--ext pdf .`             | Same — `--ext` aliases `--extension`             |
| `-e jpg -e png report`    | Repeated extensions                              |
| `-E node_modules report`  | Exclude glob plus pattern                        |
| `--size +5mb .`           | Match-all scoped to the scanned roots            |
| `--size +5mb`             | Flags only: nothing runs, list clears instantly  |
| `-- -weird`               | Everything after `--` is literal text            |

Notes:

- Size constraints put the sign first: `--size +5mb`, `--size -1gb`,
  `--size +2mb -10mb`. fd rejects trailing forms like `--size 2mb+`, which
  then shows an empty list.
- Every value flag consumes exactly one following token (`--size/-S`,
  `--type/-t`, `--max-depth/-d`, `--min-depth`, `--changed-within`,
  `--changed-before`, `--max-results`, `--extension/--ext/-e`,
  `--exclude/-E`). Repeat `-e`/`-E` for multiple extensions.
- Unknown flags pass through verbatim; a typo'd flag shows an empty list.
- Editing the staged text refilters instantly in memory — no second walk, no
  debounce. Changing flags or pattern re-walks after `fd_debounce_ms`.
- Execution flags (`-x`, `--exec`, `-X`, `--exec-batch`) never reach `fd`;
  typing them demotes them — and everything after — to literal search text.
- Policy ignores always apply, and flag mode reads the live disk, so it works
  even while the index is still scanning.

## Behavior notes

- The index lives at `~/.local/state/omarchy/file-finder-list.txt`, loads at
  shell start so first searches are instant, refreshes in the background, and
  is rewritten only when its content actually changed. Deleting it is always
  safe: the next shell start rebuilds it, and if it vanishes mid-session the
  finder restores its in-memory copy on the next open so searches keep working.
- Each rescan is one relay-wrapped `fd` walk over every live root; dead roots
  are skipped automatically, and the walk reports its live/total root ratio so
  a *partially* dead scan (e.g. an unmounted HDD shrinking the index to
  `$HOME`-only) is discarded instead of clobbering a good index — then retried
  automatically every 10 s for up to ~4 minutes, so a boot-time mount race
  heals itself. Nested or overlapping roots collapse to the outermost one, so
  every path indexes exactly once.
- `ignored_dirs` translates to cross-root `**/<suffix>` excludes; a root
  listed there drops out entirely.
- Previews cache in memory for the whole session, keyed by path, so revisiting
  a file re-shows its preview instantly. Renders larger than 3 MB of PNG are
  refused ("Thumbnail too large") rather than loaded. Files with nothing to
  render — unreadable files, binary or empty files, broken images — show an
  "Unable to preview" placeholder instead of a blank pane.
- Successful thumbnails persist on disk under
  `~/.cache/thumbnails/shafayet.finder/{pdf,video}/`, named by
  `md5("<path>|<size>|<mtime>|<inode>")` so an edited file never gets a stale
  hit — the first look of a session skips rendering entirely. Oldest entries
  are pruned past `thumbnail_cache_limit`.
- Warm staged-text refiltering is incremental: extending the query rescores
  only the previous match set, keeping keystrokes in the low ms even on
  six-figure baselines.
- Video previews grab a frame at 1 s (falling back to the first frame for
  short clips) using the same scale cap and thumbnail store as PDFs.
- Stale work stops eagerly: every keystroke kills superseded search, browse,
  and preview processes instead of letting them run invisibly.

## Files

- `Finder.qml` — overlay UI, process lifecycle, preview worker pool
- `script/` — purpose-split JS libraries (QML `.import` layering, node-testable):
  - `Core.js` — quoting, setting primitives, path/type utilities
  - `Fuzzy.js` — client-side scoring/filtering
  - `FdQuery.js` — fd flag sanitizing and search-box query parsing
  - `Walks.js` — root guarding, excludes, relays, scan/browse commands
  - `Search.js` — fzf filter command, live flag-mode walks, run identity
  - `Settings.js` — defaults and shell.json cfg resolution
  - `Preview.js` — preview/thumbnail producers, failure memo constants
- `ShortcutHelp.qml` — Ctrl+Shift+/ keyboard-shortcuts modal
- `ResultRow.qml` — result-list row delegate
- `PreviewPane.qml` — right-hand preview pane (text/image/thumbnail)
- `FinderHeader.qml` — filter echo + entry-count/status bar
- `EmptyState.qml` — no-results / scanning overlay

## License

[MIT](LICENSE)
