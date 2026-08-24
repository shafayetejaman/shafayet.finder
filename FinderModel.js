// Pure helpers for the fuzzy file finder: settings parsing, path display,
// and command construction for the fd/fzf pipeline. Kept free of QML so it
// can be exercised with node like ClipboardHistory.js.

var maxScanResults = 100000
var maxDisplayRows = 50
var maxBrowseRows = 200
var previewByteLimit = 65536
var previewCacheLimit = 500
var pdfCacheLimit = 12
var previewWorkers = 3
var debounceMs = 40
var fdDebounceMs = 1000
var rescanIntervalMs = 60000
var pdfRenderScale = 1200
// Rendered-thumbnail hardening: producers refuse to ship any PNG larger than
// this many bytes — a crafted document/media file or an oversized render
// scale could otherwise balloon into the StdioCollector and stay resident in
// the in-memory cache (base64 inflates bytes ~4/3 on the wire).
var thumbPngByteCeiling = 3 * 1024 * 1024
var fontTitle = 13
var fontCaption = 12
var fontHeading = 16
var fontDisplayLarge = 18

// Non-hidden junk directories fd would otherwise happily index. Hidden dirs
// never reach the list because the scan omits --hidden; these are the ones
// users actually complain about.
var builtinIgnoreNames = ["node_modules", "__pycache__"]

// Every knob above can be overridden per-plugin from shell.json plugins[]
// entries (snake_case keys); anything absent falls back to these static
// defaults so the finder works with no configuration at all.
function positiveInt(settings, name, fallback) {
  var value = parseInt(setting(settings, name, fallback), 10)
  return isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeInt(settings, name, fallback) {
  var value = parseInt(setting(settings, name, fallback), 10)
  return isFinite(value) && value >= 0 ? value : fallback
}

function ignoredNames(settings) {
  return asStringArray(setting(settings, "ignored_names", []))
}

function boolSetting(settings, name, fallback) {
  var value = setting(settings, name, fallback)
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
}

// Extra fd flags straight from shell.json ("fd_flags"), minus any type
// selection: the builders pick --type per pass (files vs directories) and fd
// unions repeated --type flags, so keeping user-supplied ones would make
// both passes emit the same entries and corrupt the file/dir chunking.
// Everything else (--ignore-vcs, --hidden, --follow, -E globs, …) passes
// through verbatim. Paths/patterns stay builder-owned.
function sanitizedFdFlags(flags) {
  var out = []
  var source = Array.isArray(flags) ? flags : []
  for (var i = 0; i < source.length; i++) {
    var flag = String(source[i] || "")
    if (!flag) continue
    if (flag === "--type" || flag === "-t") { i++; continue }
    if (flag.indexOf("--type=") === 0 || flag.indexOf("-t=") === 0) continue
    out.push(flag)
  }
  return out
}

// Quoted-for-shell flag segment with a trailing space, or "" when unset.
function fdFlagSegment(flags) {
  var clean = sanitizedFdFlags(flags)
  var parts = []
  for (var i = 0; i < clean.length; i++) parts.push(shellQuote(clean[i]))
  return parts.length > 0 ? parts.join(" ") + " " : ""
}

function shellJoin(args) {
  var parts = []
  for (var i = 0; i < args.length; i++) parts.push(shellQuote(args[i]))
  return parts
}

// Override-mode flags: verbatim, with --absolute-path appended when missing —
// the index stores absolute paths, so relative output would be unusable.
function fdOverrideArgs(flags) {
  var args = Array.isArray(flags) ? flags.slice() : []
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--absolute-path") return args
  }
  args.push("--absolute-path")
  return args
}

// Reads fd's path-per-line output on stdin and splits it into the framed
// file/dir chunks markDirectories() expects, using only bash builtins so a
// 100k-entry tree costs stat() calls rather than forks. Directories gain the
// trailing "/" type marker here, in override mode where no dedicated
// directory pass exists to do it. dirsFirst preserves browse ordering.
function fdClassifySnippet(dirsFirst) {
  var loop = 'while IFS= read -r p; do if [ -d "$p" ]; then __d+=("${p%/}/"); else __f+=("$p"); fi; done'
  var files = 'printf \'%s\\n\' "${__f[@]}"'
  var dirs = 'printf \'%s\\n\' "${__d[@]}"'
  var marker = "printf '\\n" + scanSectionMarker + "\\n'"
  var first = dirsFirst ? dirs : files
  var second = dirsFirst ? files : dirs
  return "{ " + loop + " ; " + first + " ; " + marker + " ; " + second + " ; }"
}

function resolveBrowseDir(settings, home) {
  var expanded = expandPath(setting(settings, "browse_dir", ""), home)
  return expanded || home + "/Downloads"
}

// Merges a shell.json plugins[] entry over the static defaults. The single
// source of truth for every tunable the QML side and command builders need;
// safe to call with {} or null.
function resolveSettings(settings, home) {
  var rawFd = asStringArray(setting(settings, "fd_flags", []))
  var ignoredDirs = expandPaths(asStringArray(setting(settings, "ignored_dirs", [])), home)
  var dirs = searchDirs(settings, home)
  // A root listed in ignored_dirs opts its whole subtree out: drop the root
  // up front instead of emitting a meaningless "-E /" native exclude.
  var effectiveDirs = []
  for (var i = 0; i < dirs.length; i++) {
    if (ignoredDirs.indexOf(dirs[i]) === -1) effectiveDirs.push(dirs[i])
  }
  return {
    // Nested/overlapping roots are pruned so the combined walk never emits
    // a path twice; every downstream consumer (scans, flag-mode walks,
    // exclude computation) sees this disjoint set.
    searchDirs: pruneContainedRoots(effectiveDirs),
    // Names prune as unanchored excludes (any depth); dirs as anchored
    // per-root excludes (see fdExcludeArgs).
    ignoreNames: builtinIgnoreNames.concat(ignoredNames(settings)),
    ignoredDirs: ignoredDirs,
    maxScanResults: positiveInt(settings, "max_scan_results", maxScanResults),
    maxDisplayRows: positiveInt(settings, "max_display_rows", maxDisplayRows),
    maxBrowseRows: positiveInt(settings, "max_browse_rows", maxBrowseRows),
    previewByteLimit: positiveInt(settings, "preview_byte_limit", previewByteLimit),
    previewCacheLimit: positiveInt(settings, "preview_cache_limit", previewCacheLimit),
    pdfCacheLimit: positiveInt(settings, "pdf_cache_limit", pdfCacheLimit),
    // Clamped 1..3: one worker means strictly serial previews, and more than
    // three slots can never be fed (selected row + two prefetched neighbors).
    previewWorkers: Math.min(3, positiveInt(settings, "preview_workers", previewWorkers)),
    debounceMs: nonNegativeInt(settings, "debounce_ms", debounceMs),
    fdDebounceMs: nonNegativeInt(settings, "fd_debounce_ms", fdDebounceMs),
    rescanIntervalMs: nonNegativeInt(settings, "rescan_interval_ms", rescanIntervalMs),
    // Clamped 64..4000: bounds the thumbnail render on both axes (pdftoppm's
    // long edge, ffmpeg's width) so a huge shell.json value can never ask a
    // producer for an enormous PNG in the first place.
    pdfRenderScale: Math.min(4000, Math.max(64, positiveInt(settings, "pdf_render_scale", pdfRenderScale))),
    showHidden: boolSetting(settings, "show_hidden", false),
    contentFontSize: positiveInt(settings, "content_font_size", fontTitle),
    contentCaption: positiveInt(settings, "content_caption", fontCaption),
    contentHeading: positiveInt(settings, "content_heading", fontHeading),
    contentDisplayLarge: positiveInt(settings, "content_display_large", fontDisplayLarge),
    // Classic mode: user flags add to the builder-owned type selection.
    fdFlags: sanitizedFdFlags(rawFd),
    // Override mode: non-empty fd_flags replaces the whole flag set verbatim.
    fdOverrideArgs: rawFd.length > 0 ? fdOverrideArgs(rawFd) : null,
    browseDir: resolveBrowseDir(settings, home)
  }
}

// Native fd excludes for one search root — used by the single-directory
// browse command where per-root anchoring is still exact. Names match any
// component at any depth; configured dirs translate to gitignore-style
// anchored globs so "/home/x/.cache" only ever prunes that exact subtree.
// Pairs outside the root are skipped (fd would never descend there anyway).
function fdExcludeArgs(root, ignoreNames, ignoredDirs) {
  var args = []
  var i
  for (i = 0; i < ignoreNames.length; i++) {
    if (ignoreNames[i]) args.push("--exclude", String(ignoreNames[i]))
  }
  for (i = 0; i < ignoredDirs.length; i++) {
    var dir = String(ignoredDirs[i] || "")
    if (!dir) continue
    if (dir === root || dir.indexOf(root + "/") === 0) {
      var rel = dir.slice(root.length).replace(/^\/+/, "")
      // Empty rel means the root itself is ignored — resolveSettings drops
      // such roots; never emit a bare "--exclude /" here.
      if (rel) args.push("--exclude", "/" + rel)
    }
  }
  return args
}

function quotedExcludeSegment(root, cfg) {
  return shellJoin(fdExcludeArgs(root, cfg.ignoreNames, cfg.ignoredDirs)).join(" ")
}

// Policy excludes for ONE combined fd invocation spanning every search
// root. Empirically (fd 10): slash-less globs prune that name at any depth
// under all start dirs, and a "**/a/b" glob extends the same cross-root
// reach to nested paths — slash-anchored patterns would only ever see the
// first positional root. So names pass through verbatim and each ignored
// dir becomes "**/<rel>", with rel taken from its deepest matching root.
function combinedExcludeArgs(ignoreNames, ignoredDirs, searchDirs) {
  var args = []
  var seen = {}
  var i
  for (i = 0; i < ignoreNames.length; i++) {
    var name = String(ignoreNames[i] || "")
    if (!name || seen[name]) continue
    seen[name] = true
    args.push("--exclude", name)
  }
  for (i = 0; i < ignoredDirs.length; i++) {
    var dir = String(ignoredDirs[i] || "")
    if (!dir || seen[dir]) continue
    var rel = relativeToDeepestRoot(dir, searchDirs)
    if (!rel) continue
    seen[dir] = true
    args.push("--exclude", "**/" + rel)
  }
  return args
}

// Overlapping search roots make one combined fd walk emit the same path
// once per enclosing root (a nested root's entries are fully covered by its
// parent anyway). Collapse exact repeats to their first occurrence, then
// drop any root strictly contained by a surviving one — order preserved,
// sibling names that merely share a text prefix ("/mnt/a", "/mnt/ab")
// untouched. The result is a disjoint root set, so every path is indexed
// exactly once no matter how the user lists their roots.
function pruneContainedRoots(dirs) {
  var unique = []
  var seen = {}
  for (var i = 0; i < dirs.length; i++) {
    var dir = String(dirs[i] || "")
    if (!dir || seen[dir]) continue
    seen[dir] = true
    unique.push(dir)
  }
  var pruned = []
  for (i = 0; i < unique.length; i++) {
    var covered = false
    for (var j = 0; j < unique.length && !covered; j++) {
      if (unique[j] !== unique[i] && unique[i].indexOf(unique[j] + "/") === 0) covered = true
    }
    if (!covered) pruned.push(unique[i])
  }
  return pruned
}

// Longest "dir sits below this root" suffix, or "" when no scanned root
// contains it (fd would never descend there anyway).
function relativeToDeepestRoot(dir, searchDirs) {
  var best = ""
  for (var i = 0; i < searchDirs.length; i++) {
    var root = String(searchDirs[i] || "")
    if (dir.indexOf(root + "/") !== 0) continue
    var rel = dir.slice(root.length).replace(/^\/+/, "")
    if (rel && rel.length > best.length) best = rel
  }
  return best
}

function combinedExcludeSegment(cfg) {
  return shellJoin(combinedExcludeArgs(cfg.ignoreNames, cfg.ignoredDirs, cfg.searchDirs)).join(" ")
}

// Bash prologue collecting live roots into __p[], so one dead mount or
// vanished directory cannot fail the whole walk.
function guardedRootsSnippet(searchDirs) {
  var parts = ["__p=()"]
  for (var i = 0; i < searchDirs.length; i++) {
    var quoted = shellQuote(searchDirs[i])
    parts.push("[ -d " + quoted + " ] && __p+=(" + quoted + ")")
  }
  parts.push("[ ${#__p[@]} -gt 0 ] || exit 0")
  return parts.join(" ; ")
}

// Entry points used by QML: dispatch on whether fd_flags overrides. Policy
// excludes (ignored_dirs/ignored_names) are enforced in BOTH modes by being
// part of every fd invocation — user flags stay literal for everything else.
// Both modes walk all search roots in ONE relay-wrapped fd invocation with
// guarded positionals; fd prints directories with a trailing "/" so the
// output needs no framing or post-classification.
function scanCommand(cfg) {
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0) return ["bash", "-c", ""]
  if (cfg && cfg.fdOverrideArgs) {
    var argStr = shellJoin(cfg.fdOverrideArgs).join(" ")
    var ex = combinedExcludeSegment(cfg)
    return ["bash", "-c",
      "( { " + guardedRootsSnippet(cfg.searchDirs) + " ; "
      + termRelay("fd " + argStr + (ex ? " " + ex : "") + " . \"${__p[@]}\" 2>/dev/null")
      + " ; } 2>/dev/null ) | head -n " + cfg.maxScanResults]
  }
  return scanCommandClassic(cfg)
}

function browseCommand(cfg) {
  if (cfg && cfg.fdOverrideArgs) {
    var argStr = shellJoin(cfg.fdOverrideArgs).join(" ")
    var quoted = shellQuote(cfg.browseDir)
    var ex = quotedExcludeSegment(cfg.browseDir, cfg)
    var fdCmd = "fd " + argStr + (ex ? " " + ex : "") + " --min-depth 1 --max-depth 1 . " + quoted
    return ["bash", "-c",
      "{ [ -d " + quoted + " ] || exit 0 ; } ; "
      + "( " + termRelay(fdCmd + " 2>/dev/null") + " | " + fdClassifySnippet(true) + " ) 2>/dev/null"
      + " | head -n " + cfg.maxBrowseRows]
  }
  return browseCommandClassic(cfg)
}

function setting(settings, name, fallback) {
  var value = settings ? settings[name] : undefined
  return value === undefined || value === null ? fallback : value
}

function expandPath(path, home) {
  var value = String(path || "").trim()
  if (!value) return ""
  if (value.indexOf("$HOME") === 0 && (value.length === 5 || value.charAt(5) === "/")) value = home + value.substring(5)
  else if (value.indexOf("~") === 0 && (value.length === 1 || value.charAt(1) === "/")) value = home + value.substring(1)
  while (value.length > 1 && value.charAt(value.length - 1) === "/") value = value.slice(0, -1)
  return value
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  var out = []
  for (var i = 0; i < value.length; i++) {
    var entry = String(value[i] || "").trim()
    if (entry) out.push(entry)
  }
  return out
}

function expandPaths(paths, home) {
  var source = Array.isArray(paths) ? paths : []
  var out = []
  for (var i = 0; i < source.length; i++) {
    var expanded = expandPath(source[i], home)
    if (expanded) out.push(expanded)
  }
  return out
}

function searchDirs(settings, home) {
  var raw = setting(settings, "search_dirs", ["$HOME"])
  var expanded = expandPaths(asStringArray(raw), home)
  return expanded.length > 0 ? expanded : [home]
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

// Runs cmd as a direct child with SIGTERM relayed to it, so killing the bash
// wrapper (stale-process teardown) also stops CPU/disk-heavy leaves like fd
// and pdftoppm instead of orphaning them. Downstream pipeline members need no
// relay: they exit on their own via EOF/EPIPE once the leaf dies.
function termRelay(cmd) {
  return "{ " + cmd + " & __p=$!; trap 'kill -TERM \"$__p\" 2>/dev/null' TERM INT; wait \"$__p\"; }"
}

// Marker lines framing scan output: "@@DIRS@@" separates a directory's file
// chunk from its directory chunk, "@@END@@" closes each per-directory block.
// Absolute paths can never start with "@", so both are unambiguous.
var scanSectionMarker = "@@DIRS@@"
var scanBlockMarker = "@@END@@"

// One relay-wrapped fd walk over every live search root: files and
// directories in a single pass, directories carrying their native trailing
// "/" type marker (normalized by markDirectories). Dead roots are dropped
// by the guard, and head truncation just severs the line stream — any
// prefix of it is a valid index.
function scanCommandClassic(cfg) {
  var flags = fdFlagSegment(cfg.fdFlags)
  flags += "--type file --type directory "
  if (cfg.showHidden) flags += "--hidden "
  var ex = combinedExcludeSegment(cfg)
  if (ex) flags += ex + " "
  flags += "--absolute-path "
  return ["bash", "-c",
    "( { " + guardedRootsSnippet(cfg.searchDirs) + " ; "
    + termRelay("fd " + flags + ". \"${__p[@]}\" 2>/dev/null")
    + " ; } 2>/dev/null ) | head -n " + cfg.maxScanResults]
}

// Collects absolute-path lines from a scan; directory rows keep fd's
// trailing "/" marker, collapsed to exactly one. Marker lines from legacy
// framed cache files never start with "/", so old indexes parse unchanged,
// and any truncated tail is still a valid prefix.
function markDirectories(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.length > 1 && line.charAt(0) === "/") out.push(line.replace(/\/{2,}$/, "/"))
  }
  return out
}

// Non-recursive snapshot of one directory, directories first. Shown when the
// query is empty so the finder opens as a browser of ~/Downloads. A single
// mixed-type fd pass feeds the classify snippet, which reorders dirs ahead
// of files without trusting the walk order.
function browseCommandClassic(cfg) {
  var dir = cfg.browseDir
  var quoted = shellQuote(dir)
  var flags = fdFlagSegment(cfg.fdFlags)
  if (cfg.showHidden) flags += "--hidden "
  var ex = quotedExcludeSegment(dir, cfg)
  if (ex) flags += ex + " "
  return ["bash", "-c",
    "{ [ -d " + quoted + " ] || exit 0 ; } ; "
    + "( "
    + termRelay("fd " + flags + "--type directory --type file --absolute-path --min-depth 1 --max-depth 1 . " + quoted + " 2>/dev/null")
    + " | " + fdClassifySnippet(true)
    + " ) 2>/dev/null"
    + " | head -n " + cfg.maxBrowseRows
  ]
}

function buildSearchCommand(listPath, query, displayLimit) {
  if (displayLimit === undefined) displayLimit = maxDisplayRows
  return [
    "bash", "-c",
    "fzf --filter " + shellQuote(query) + " --scheme=path 2>/dev/null < " + shellQuote(listPath) + " | head -n " + displayLimit
  ]
}

// ================= inline fd flags in the search box =================

// Flags that consume exactly one following value token — mirroring fd's own
// CLI, where -e/-E also take a single value per occurrence. Multiple
// extensions/excludes work by repeating the flag: "-e pdf -e txt .".
var FD_VALUE_FLAGS = {
  "--size": 1, "-S": 1,
  "--type": 1, "-t": 1,
  "--max-depth": 1, "-d": 1,
  "--min-depth": 1,
  "--exact-depth": 1,
  "--changed-within": 1,
  "--changed-before": 1,
  "--changed-after": 1,
  "--max-results": 1,
  "--extension": 1, "-e": 1,
  "--exclude": 1, "-E": 1,
}

// Convenience spellings fd itself rejects, rewritten before the command is
// built so the live walk only ever sees real fd flags. Applies to both the
// bare form (--ext pdf) and the attached form (--ext=pdf).
var FD_FLAG_ALIASES = {
  "--ext": "--extension",
}

function flagLike(token) {
  return token.length > 1 && token.charAt(0) === "-"
}

// Splits a raw query into fd flags and staged text:
//   "invoice"                    -> { args: [], fdPattern: "", fzfQuery: "" }  (classic path)
//   "--size +5mb invoice"        -> args [--size +5mb], pattern "invoice"
//   "--size=+5mb report paid"    -> attached values work; "paid" goes to fzf
//   "-e pdf ."                   -> args [-e pdf], match-all pattern "."
//   "-- -weird"                  -> everything after "--" is literal text
// First text token becomes the fd pattern; the rest joins into the fzf query.
function parseQuery(input) {
  var tokens = String(input || "").trim().split(/\s+/).filter(function (t) { return t })
  var args = []
  var text = []
  var i = 0
  var parsingFlags = true
  while (i < tokens.length) {
    var token = tokens[i]
    if (!parsingFlags) {
      text.push(token)
      i++
      continue
    }
    if (token === "--") {
      parsingFlags = false
      i++
      continue
    }
    if (!flagLike(token)) {
      text.push(token)
      i++
      continue
    }
    // A flag token: push verbatim (aliases rewritten) and consume its
    // single value, if any.
    var bare = token
    var eq = token.indexOf("=")
    if (eq !== -1) bare = token.substring(0, eq)
    var canonical = FD_FLAG_ALIASES.hasOwnProperty(bare)
      ? FD_FLAG_ALIASES[bare] + (eq === -1 ? "" : token.substring(eq))
      : token
    args.push(canonical)
    i++
    // Unknown flags are booleans; attached "=value" forms skip consumption
    // because they miss the table (keys are bare flag names).
    if (!FD_VALUE_FLAGS.hasOwnProperty(canonical)) continue
    if (canonical.indexOf("=") !== -1) continue // --flag=value carries its own
    if (i < tokens.length && tokens[i] !== "--" && !flagLike(tokens[i])) {
      args.push(tokens[i])
      i++
    }
  }
  return {
    args: args,
    fdPattern: text.length > 0 ? text[0] : "",
    fzfQuery: text.slice(1).join(" ")
  }
}

// Live fd walk over all roots with user-supplied flags: one relay-wrapped,
// guarded walk exactly like the index scan. Deliberately NO fzf stage and no
// display cap here — the full (capped) walk is kept in memory as the baseline
// for a query, and the staged text is filtered over that baseline client-side,
// so editing or deleting staged words never re-walks. Errors stay silent — a
// bad flag just yields no lines.
function liveFdCommand(cfg, parsed, cap) {
  if (cap === undefined) cap = maxScanResults
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0 ||
      !parsed || !parsed.args || parsed.args.length === 0) {
    return ["bash", "-c", ""]
  }
  var absArgs = parsed.args.slice()
  if (absArgs.indexOf("--absolute-path") === -1 && absArgs.indexOf("-a") === -1) absArgs.push("--absolute-path")
  if (cfg.showHidden && absArgs.indexOf("--hidden") === -1 && absArgs.indexOf("-H") === -1 && absArgs.indexOf("-u") === -1) {
    absArgs.push("--hidden")
  }
  var argStr = shellJoin(absArgs).join(" ")
  var ex = combinedExcludeSegment(cfg)
  var script = "( { " + guardedRootsSnippet(cfg.searchDirs) + " ; "
    + termRelay("fd " + argStr + (ex ? " " + ex : "")
      + " " + shellQuote(parsed.fdPattern || ".") + " \"${__p[@]}\" 2>/dev/null")
    + " ; } 2>/dev/null )"
  script += " | head -n " + cap
  return ["bash", "-c", script]
}

// Stable identity of a live-fd run's expensive inputs: the canonical flags,
// the pattern, and every setting that alters the walk. Deliberately excludes
// fzfQuery — changing only the staged text must count as the same run so the
// finder can narrow the already-loaded rows without re-walking.
function fdCacheKey(cfg, parsed) {
  if (!parsed || !parsed.args || parsed.args.length === 0 || !parsed.fdPattern) return ""
  var sig = null
  if (cfg) {
    sig = [cfg.searchDirs, cfg.ignoredDirs, cfg.ignoreNames, cfg.showHidden,
      cfg.fdFlags, cfg.fdOverrideArgs]
  }
  return JSON.stringify([parsed.args, parsed.fdPattern, sig])
}

// Smart-case fzf-style subsequence score for ONE term: per-char base plus
// bonuses for contiguous runs and word/path boundaries. The greedy chain is
// attempted from each of the first occurrences of the term's initial (capped)
// and the best alignment wins, so a clean anchored match is never lost to an
// earlier scattered one. Returns -1 when the term cannot be matched.
function fuzzyScore(line, query) {
  var text = String(line)
  var q = String(query)
  if (!/[A-Z]/.test(q)) { text = text.toLowerCase(); q = q.toLowerCase() }
  if (!q) return 0
  var starts = []
  var idx = text.indexOf(q.charAt(0))
  while (idx !== -1 && starts.length < 16) {
    starts.push(idx)
    idx = text.indexOf(q.charAt(0), idx + 1)
  }
  var best = -1
  for (var s = 0; s < starts.length; s++) {
    var score = 0
    var run = 0
    var prevIdx = starts[s] - 1
    var from = starts[s]
    var ok = true
    for (var qi = 0; qi < q.length; qi++) {
      idx = text.indexOf(q.charAt(qi), from)
      if (idx === -1) { ok = false; break }
      score += 16
      if (idx === prevIdx + 1) { run++; score += 4 + run * 2 } else { run = 0 }
      if (idx === 0 || !isWordChar(text.charAt(idx - 1))) score += 8
      prevIdx = idx
      from = idx + 1
    }
    if (ok && score > best) best = score
  }
  return best
}

function isWordChar(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
    || c === "_"
}

// Warm-edit filter over the in-memory baseline, mirroring fzf's --filter
// semantics: whitespace-separated terms are ANDed independently (each must
// subsequence-match somewhere), scores sum, order is score desc with input
// order breaking ties. A blank query passes everything through untouched.
function fuzzyFilterRows(rows, query) {
  var list = Array.isArray(rows) ? rows : []
  var terms = String(query == null ? "" : query).trim().split(/\s+/).filter(function (t) { return t })
  if (terms.length === 0) return list.slice()
  var scored = []
  for (var i = 0; i < list.length; i++) {
    var total = 0
    var miss = false
    for (var t = 0; t < terms.length; t++) {
      var s = fuzzyScore(String(list[i]), terms[t])
      if (s < 0) { miss = true; break }
      total += s
    }
    if (!miss) scored.push({ row: list[i], score: total, i: i })
  }
  scored.sort(function (a, b) { return b.score - a.score || a.i - b.i })
  var out = []
  for (var j = 0; j < scored.length; j++) out.push(scored[j].row)
  return out
}

function buildPreviewCommand(path, byteLimit) {
  if (byteLimit === undefined) byteLimit = previewByteLimit
  var quoted = shellQuote(path)
  // First line is "\t<size>\t<mtime>"; the rest is file content. A size of -1
  // marks an unreadable or vanished file without a second round trip.
  return [
    "bash", "-c",
    "if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " mt=$(stat -Lc %y -- " + quoted + " 2>/dev/null | cut -d. -f1);"
    + ' printf "\\t%s\\t%s\\n" "${sz:-?}" "$mt";'
    + " head -c " + byteLimit + " -- " + quoted + " 2>/dev/null;"
    + " else printf '\\t-1\\t\\n'; fi"
  ]
}

// Directory preview: "\t-2\t<entry-count>" header, then a one-level listing
// where nested directories keep their trailing slash. Dot entries are
// filtered out unless showHidden — matching the index's default policy.
function buildDirPreviewCommand(path, byteLimit, showHidden) {
  if (byteLimit === undefined) byteLimit = previewByteLimit
  var quoted = shellQuote(path)
  var ls = "ls -1Ap --color=never -- " + quoted + " 2>/dev/null"
  if (!showHidden) ls += " | grep -v '^\\.'"
  return [
    "bash", "-c",
    "{ [ -d " + quoted + " ] || exit 0 ; } ;"
    + ' cnt=$(ls -1A -- ' + quoted + ' 2>/dev/null' + (showHidden ? "" : " | grep -v '^\\.'") + ' | wc -l);'
    + ' printf "\\t-2\\t%s\\n" "$cnt";'
    + " " + ls + " | head -c " + byteLimit
  ]
}

function parsePreviewOutput(raw) {
  var text = String(raw || "")
  var newline = text.indexOf("\n")
  var metaLine = newline >= 0 ? text.substring(0, newline) : text
  var content = newline >= 0 ? text.substring(newline + 1) : ""
  var fields = metaLine.split("\t")
  var size = parseInt(fields[1], 10)
  if (isNaN(size)) size = 0
  return { size: size, mtime: String(fields[2] || ""), content: content }
}

function fileName(path) {
  var parts = String(path || "").split("/")
  return parts.length > 0 ? parts[parts.length - 1] : String(path || "")
}

// Readline-style backward kill for the filter box: strips trailing
// whitespace, then the word before it — "foo bar  " becomes "foo ".
function deleteLastWord(text) {
  var value = String(text || "")
  var end = value.length
  while (end > 0 && /\s/.test(value.charAt(end - 1))) end--
  var start = end
  while (start > 0 && !/\s/.test(value.charAt(start - 1))) start--
  return value.substring(0, start)
}

// Directory rows carry a trailing "/" marker through the pipeline.
function isDirPath(path) {
  var value = String(path || "")
  return value.length > 1 && value.charAt(value.length - 1) === "/"
}

// Strips every trailing slash; fd emits them itself on symlinked roots, so
// the type-marker sed must stay idempotent against that.
function cleanPath(path) {
  var value = String(path || "")
  while (value.length > 1 && value.charAt(value.length - 1) === "/") value = value.slice(0, -1)
  return value
}

function dirName(path) {
  var value = String(path || "")
  var slash = value.lastIndexOf("/")
  if (slash <= 0) return "/"
  return value.substring(0, slash)
}

function shortenPath(path, home) {
  var value = String(path || "")
  if (home && value.indexOf(home) === 0) {
    var rest = value.substring(home.length)
    if (rest === "") return "~"
    if (rest.charAt(0) === "/") return "~" + rest
  }
  return value
}

function isImagePath(path) {
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(String(path || ""))
}

function isPdfPath(path) {
  return /\.pdf$/i.test(String(path || ""))
}

function isVideoPath(path) {
  return /\.(mp4|mkv|webm|mov|avi|m4v|mpg|mpeg|wmv|flv|m2ts|ts|3gp|ogv)$/i.test(String(path || ""))
}

// Renders page 1 of a PDF into a per-job PRIVATE scratch directory
// ("<base>.XXXXXX", mktemp -d's mode-0700 regardless of umask — so
// overlapping or killed renders can never read each other's pixels and no
// other user can read ours) and reports "\t<size>\t" followed by the image
// as base64 text, so the whole payload survives the stdout text collector
// and can live in an in-memory cache instead of aliasing a shared file that
// the next render overwrites. pdftoppm is relay-wrapped to die on
// stale-process teardown. Producer-side ceiling: only a non-empty PNG at or
// under thumbPngByteCeiling bytes is shipped; an over-ceiling render
// reports the -3 marker instead of flooding the collector, and a corrupt or
// unreadable document reports size -1 rather than being cached as
// successfully rendered. The scratch directory is removed even after failed
// renders; only a SIGKILLed mid-render job could leak one.
function buildPdfPreviewCommand(path, outBase, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var quoted = shellQuote(path)
  return [
    "bash", "-c",
    "umask 077;"
    + " if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " tmpd=$(mktemp -d -- " + shellQuote(outBase) + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
    + " tmp=\"$tmpd/page.png\";"
    + " " + termRelay("pdftoppm -png -f 1 -singlefile -scale-to " + scale + " " + quoted + " \"${tmp%.png}\"") + ";"
    + " if [ -s \"$tmp\" ]; then"
    + " if [ \"$(stat -Lc %s -- \"$tmp\")\" -le " + ceiling + " ]; then"
    + ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 \"$tmp\";"
    + " else printf '\\t-3\\t\\n'; fi"
    + " else printf '\\t-1\\t\\n'; fi;"
    + " rm -rf -- \"$tmpd\";"
    + " else printf '\\t-1\\t\\n'; fi"
  ]
}

// Wraps base64 PNG bytes into a self-contained <img> source. Whitespace must
// go: base64's trailing newline would corrupt the data URI. Returns "" when
// the payload is empty or exceeds the producer ceiling — callers treat ""
// as "thumbnail unavailable" instead of ever constructing an unbounded data
// URL (defense in depth against a misbehaving or future-edited producer).
function pdfDataUrl(b64) {
  var s = String(b64 || "").replace(/\s+/g, "")
  if (s.length === 0 || s.length > Math.ceil(thumbPngByteCeiling / 3) * 4) return ""
  return "data:image/png;base64," + s
}

// Grabs one representative frame of a video into a per-job PRIVATE scratch
// directory ("<base>.XXXXXX", same mktemp -d scheme as PDF renders) and
// reports "\t<size>\t" followed by the image as base64 text — identical wire
// format and identical producer-side ceiling, so the payload lands in the
// same bounded in-memory cache. Seeks 1s in for a representative frame;
// videos shorter than that (or with no decodable frame at 1s) retry from 0s,
// and only then report size -1; an over-ceiling frame reports size -3.
// ffmpeg is relay-wrapped to die on stale teardown, -nostdin keeps it from
// ever eating a collector's stdin, and the scratch directory is removed even
// after failed runs; only a SIGKILLed mid-extract job could leak one.
function buildVideoThumbnailCommand(path, outBase, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var quoted = shellQuote(path)
  var grab = function (ss) {
    return termRelay("ffmpeg -nostdin -hide_banner -loglevel error -ss " + ss
      + " -i " + quoted
      + " -frames:v 1 -map v:0 -vf 'scale=min(iw\\," + scale + "):-2'"
      + " -y \"$tmp\"") + ";"
  }
  return [
    "bash", "-c",
    "umask 077;"
    + " if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " tmpd=$(mktemp -d -- " + shellQuote(outBase) + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
    + " tmp=\"$tmpd/page.png\";"
    + grab(1)
    + " if [ ! -s \"$tmp\" ]; then " + grab(0) + " fi;"
    + " if [ -s \"$tmp\" ]; then"
    + " if [ \"$(stat -Lc %s -- \"$tmp\")\" -le " + ceiling + " ]; then"
    + ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 \"$tmp\";"
    + " else printf '\\t-3\\t\\n'; fi"
    + " else printf '\\t-1\\t\\n'; fi;"
    + " rm -rf -- \"$tmpd\";"
    + " else printf '\\t-1\\t\\n'; fi"
  ]
}

function formatBytes(bytes) {
  var n = Number(bytes)
  if (!isFinite(n) || n < 0) return "? B"
  if (n < 1024) return n + " B"
  var units = ["KB", "MB", "GB", "TB"]
  var value = n
  for (var i = 0; i < units.length; i++) {
    value = value / 1024
    if (value < 1024 || i === units.length - 1) return value.toFixed(value < 10 ? 1 : 0) + " " + units[i]
  }
  return n + " B"
}

if (typeof module !== "undefined") {
  module.exports = {
    maxScanResults: maxScanResults,
    maxDisplayRows: maxDisplayRows,
    maxBrowseRows: maxBrowseRows,
    previewByteLimit: previewByteLimit,
    previewCacheLimit: previewCacheLimit,
    pdfCacheLimit: pdfCacheLimit,
    previewWorkers: previewWorkers,
    debounceMs: debounceMs,
    rescanIntervalMs: rescanIntervalMs,
    pdfRenderScale: pdfRenderScale,
    builtinIgnoreNames: builtinIgnoreNames,
    termRelay: termRelay,
    scanSectionMarker: scanSectionMarker,
    scanBlockMarker: scanBlockMarker,
    setting: setting,
    positiveInt: positiveInt,
    nonNegativeInt: nonNegativeInt,
    ignoredNames: ignoredNames,
    boolSetting: boolSetting,
    sanitizedFdFlags: sanitizedFdFlags,
    fdFlagSegment: fdFlagSegment,
    fdOverrideArgs: fdOverrideArgs,
    fdClassifySnippet: fdClassifySnippet,
    shellJoin: shellJoin,
    fdExcludeArgs: fdExcludeArgs,
    quotedExcludeSegment: quotedExcludeSegment,
    combinedExcludeArgs: combinedExcludeArgs,
    combinedExcludeSegment: combinedExcludeSegment,
    relativeToDeepestRoot: relativeToDeepestRoot,
    guardedRootsSnippet: guardedRootsSnippet,
    resolveBrowseDir: resolveBrowseDir,
    resolveSettings: resolveSettings,
    scanCommand: scanCommand,
    browseCommand: browseCommand,
    expandPath: expandPath,
    asStringArray: asStringArray,
    expandPaths: expandPaths,
    searchDirs: searchDirs,
    pruneContainedRoots: pruneContainedRoots,
    shellQuote: shellQuote,
    fdDebounceMs: fdDebounceMs,
    FD_VALUE_FLAGS: FD_VALUE_FLAGS,
    FD_FLAG_ALIASES: FD_FLAG_ALIASES,
    parseQuery: parseQuery,
    liveFdCommand: liveFdCommand,
    fdCacheKey: fdCacheKey,
    fuzzyFilterRows: fuzzyFilterRows,
    deleteLastWord: deleteLastWord,
    markDirectories: markDirectories,
    buildSearchCommand: buildSearchCommand,
    buildPreviewCommand: buildPreviewCommand,
    buildDirPreviewCommand: buildDirPreviewCommand,
    parsePreviewOutput: parsePreviewOutput,
    fileName: fileName,
    dirName: dirName,
    isDirPath: isDirPath,
    cleanPath: cleanPath,
    shortenPath: shortenPath,
    isImagePath: isImagePath,
    isPdfPath: isPdfPath,
    isVideoPath: isVideoPath,
    buildPdfPreviewCommand: buildPdfPreviewCommand,
    buildVideoThumbnailCommand: buildVideoThumbnailCommand,
    thumbPngByteCeiling: thumbPngByteCeiling,
    pdfDataUrl: pdfDataUrl,
    formatBytes: formatBytes
  }
}
