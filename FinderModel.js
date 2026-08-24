// Pure command builders and settings helpers for the finder. QML-free so
// node can exercise it directly.

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
// Hard cap for one pdftoppm/ffmpeg render; a hung producer must surface as an
// honest -1 failure instead of an eternal blank pane.
var renderTimeoutSecs = 45
// Persistent thumbnails under ~/.cache/thumbnails/<plugin>/{pdf,video}/,
// keyed by md5("<path>|<size>|<mtime>|<inode>"). <= 0 disables persistence.
var thumbnailCacheLimit = 500
// Producers refuse PNGs above this; bounds the stdout collector and the
// resident memory of cached data URLs (base64 inflates bytes ~4/3).
var thumbPngByteCeiling = 3 * 1024 * 1024
var fontTitle = 13
var fontCaption = 12
var fontHeading = 16
var fontDisplayLarge = 18

// Non-hidden junk directories fd would otherwise index.
var builtinIgnoreNames = ["node_modules", "__pycache__"]

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

// User fd_flags minus any type selection: builders pick --type per pass, and
// fd unions repeated --type flags, which would corrupt the file/dir chunking.
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

// Any execution flag disqualifies a static override entirely: -x/--exec and
// friends consume variable argument lists (up to ";"), so reliably excising
// them is riskier than discarding the override. The search box already
// demotes typed exec flags; config gets the same outcome by falling back to
// the classic baseline.
function hasExecFlag(flags) {
  var source = Array.isArray(flags) ? flags : []
  for (var i = 0; i < source.length; i++) {
    var flag = String(source[i] || "")
    if (!flag) continue
    var bare = flag
    var eq = flag.indexOf("=")
    if (eq !== -1) bare = flag.substring(0, eq)
    if (FD_EXEC_FLAGS.hasOwnProperty(bare)) return true
  }
  return false
}

// fd's --color is long-only and takes at most one value token. Any spelling
// counts as user-owned; otherwise --color=never is forced everywhere: fd
// honors CLICOLOR_FORCE even when piped, and ANSI bytes would make index
// lines fail the leading-"/" check and vanish from searches.
function hasColorFlag(args) {
  for (var i = 0; i < args.length; i++) {
    var flag = String(args[i] || "")
    if (flag === "--color" || flag.indexOf("--color=") === 0) return true
  }
  return false
}

function fdFlagSegment(flags) {
  var clean = sanitizedFdFlags(flags)
  if (!hasColorFlag(clean)) clean.push("--color=never")
  var parts = []
  for (var i = 0; i < clean.length; i++) parts.push(shellQuote(clean[i]))
  return parts.length > 0 ? parts.join(" ") + " " : ""
}

function shellJoin(args) {
  var parts = []
  for (var i = 0; i < args.length; i++) parts.push(shellQuote(args[i]))
  return parts
}

// Override-mode flags verbatim, plus forced --absolute-path when neither
// spelling is present: the index stores absolute paths, so relative output
// would be unusable.
function fdOverrideArgs(flags) {
  var args = Array.isArray(flags) ? flags.slice() : []
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--absolute-path" || args[i] === "-a") break
  }
  if (i === args.length) args.push("--absolute-path")
  if (!hasColorFlag(args)) args.push("--color=never")
  return args
}

// Splits fd's stdin into the framed file/dir chunks markDirectories() expects,
// using only bash builtins. Adds the "/" dir marker in override mode, where no
// dedicated directory pass exists to do it.
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

// Merges a shell.json plugins[] entry over the static defaults. Safe to call
// with {} or null.
function resolveSettings(settings, home) {
  var rawFd = asStringArray(setting(settings, "fd_flags", []))
  // One gate for both consumers: a poisoned fd_flags must not reach the
  // classic flag segment any more than the override path.
  var safeFd = hasExecFlag(rawFd) ? [] : rawFd
  var ignoredDirs = expandPaths(asStringArray(setting(settings, "ignored_dirs", [])), home)
  var dirs = searchDirs(settings, home)
  // A root listed in ignored_dirs opts its whole subtree out.
  var effectiveDirs = []
  for (var i = 0; i < dirs.length; i++) {
    if (ignoredDirs.indexOf(dirs[i]) === -1) effectiveDirs.push(dirs[i])
  }
  return {
    // Disjoint root set: nested roots are pruned so no path is indexed twice.
    searchDirs: pruneContainedRoots(effectiveDirs),
    ignoreNames: builtinIgnoreNames.concat(ignoredNames(settings)),
    ignoredDirs: ignoredDirs,
    maxScanResults: positiveInt(settings, "max_scan_results", maxScanResults),
    maxDisplayRows: positiveInt(settings, "max_display_rows", maxDisplayRows),
    maxBrowseRows: positiveInt(settings, "max_browse_rows", maxBrowseRows),
    previewByteLimit: positiveInt(settings, "preview_byte_limit", previewByteLimit),
    previewCacheLimit: positiveInt(settings, "preview_cache_limit", previewCacheLimit),
    pdfCacheLimit: positiveInt(settings, "pdf_cache_limit", pdfCacheLimit),
    // 0 is the documented opt-out, hence nonNegativeInt.
    thumbnailCacheLimit: nonNegativeInt(settings, "thumbnail_cache_limit", thumbnailCacheLimit),
    // More than 3 slots can never be fed: selected row + two neighbors.
    previewWorkers: Math.min(3, positiveInt(settings, "preview_workers", previewWorkers)),
    debounceMs: nonNegativeInt(settings, "debounce_ms", debounceMs),
    fdDebounceMs: nonNegativeInt(settings, "fd_debounce_ms", fdDebounceMs),
    rescanIntervalMs: nonNegativeInt(settings, "rescan_interval_ms", rescanIntervalMs),
    pdfRenderScale: Math.min(4000, Math.max(64, positiveInt(settings, "pdf_render_scale", pdfRenderScale))),
    showHidden: boolSetting(settings, "show_hidden", false),
    contentFontSize: positiveInt(settings, "content_font_size", fontTitle),
    contentCaption: positiveInt(settings, "content_caption", fontCaption),
    contentHeading: positiveInt(settings, "content_heading", fontHeading),
    contentDisplayLarge: positiveInt(settings, "content_display_large", fontDisplayLarge),
    fdFlags: sanitizedFdFlags(safeFd),
    fdOverrideArgs: safeFd.length > 0 ? fdOverrideArgs(safeFd) : null,
    browseDir: resolveBrowseDir(settings, home)
  }
}

// Per-root excludes for the single-directory browse command. Dirs translate to
// anchored globs so "/home/x/.cache" only ever prunes that exact subtree.
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
      // rel empty means the root itself is ignored (dropped upstream).
      if (rel) args.push("--exclude", "/" + rel)
    }
  }
  return args
}

function quotedExcludeSegment(root, cfg) {
  return shellJoin(fdExcludeArgs(root, cfg.ignoreNames, cfg.ignoredDirs)).join(" ")
}

// Excludes for ONE combined walk spanning every root. Empirically (fd 10):
// slash-less globs prune at any depth under all start dirs, and "**/a/b"
// extends that reach to nested paths — slash-anchored patterns would only see
// the first positional root. So names pass through verbatim and each ignored
// dir becomes "**/<rel>" from its deepest containing root.
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

// Overlapping roots would make one combined walk emit paths twice; collapse
// exact repeats, then drop roots contained by a surviving one. Order preserved.
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

// Longest "<root>/..." suffix, or "" when no scanned root contains the dir.
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

// Emitted to the scan's stderr as "<marker><alive>/<total>"; lets QML tell a
// partially dead walk (e.g. unmounted HDD shrinking the index to $HOME-only)
// apart from a full one before trusting its output.
var scanRootsMarker = "FINDER_ROOTS="

// Bash prologue collecting live roots into __p[], so one dead mount cannot
// fail the whole walk. Runs UNSILENCED at top level: the stderr ratio report
// must reach the caller, and an all-dead set exits before any pipeline starts.
function guardedRootsSnippet(searchDirs, reportRatio) {
  var parts = ["__p=()"]
  for (var i = 0; i < searchDirs.length; i++) {
    var quoted = shellQuote(searchDirs[i])
    parts.push("[ -d " + quoted + " ] && __p+=(" + quoted + ")")
  }
  // Only index-writing scans report: flag-mode walks never touch the index,
  // and their stderr would otherwise leak the ratio to the user's terminal.
  if (reportRatio) {
    parts.push("printf '%s%s/%s\\n' '" + scanRootsMarker + "' \"${#__p[@]}\" '"
      + searchDirs.length + "' >&2")
  }
  parts.push("[ ${#__p[@]} -gt 0 ] || exit 0")
  return parts.join(" ; ")
}

// QML entry points: dispatch on whether fd_flags overrides. Policy excludes
// are enforced in BOTH modes; both walk all roots in one relay-wrapped fd
// invocation. Optional stateDir folds its mkdir into the command so the
// persisted index can be written when the scan lands.
function scanCommand(cfg, stateDir) {
  var pre = stateDir ? "mkdir -p -- " + shellQuote(stateDir) + "; " : ""
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0) return ["bash", "-c", pre]
  if (cfg && cfg.fdOverrideArgs) {
    var argStr = shellJoin(cfg.fdOverrideArgs).join(" ")
    var ex = combinedExcludeSegment(cfg)
    return ["bash", "-c",
      pre
      + guardedRootsSnippet(cfg.searchDirs, true) + " ; "
      + "( { " + termRelay("fd " + argStr + (ex ? " " + ex : "") + " . \"${__p[@]}\" 2>/dev/null")
      + " ; } 2>/dev/null ) | head -n " + cfg.maxScanResults]
  }
  return ["bash", "-c", pre + scanCommandClassic(cfg)[2]]
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

// Relays SIGTERM to the direct child, so killing the bash wrapper also stops
// CPU-heavy leaves like fd/pdftoppm. Pipeline members downstream exit on
// their own via EOF/EPIPE once the leaf dies.
function termRelay(cmd) {
  return "{ " + cmd + " & __p=$!; trap 'kill -TERM \"$__p\" 2>/dev/null' TERM INT; wait \"$__p\"; }"
}

// "@@DIRS@@" frames the file/dir chunks; absolute paths never start with "@",
// so marker lines stay unambiguous against legacy cached indexes.
var scanSectionMarker = "@@DIRS@@"

// One relay-wrapped fd walk over every live root. Head truncation severs the
// line stream, and any prefix of it is a valid index.
function scanCommandClassic(cfg) {
  var flags = fdFlagSegment(cfg.fdFlags)
  flags += "--type file --type directory "
  if (cfg.showHidden) flags += "--hidden "
  var ex = combinedExcludeSegment(cfg)
  if (ex) flags += ex + " "
  flags += "--absolute-path "
  return ["bash", "-c",
    guardedRootsSnippet(cfg.searchDirs, true) + " ; "
    + "( { " + termRelay("fd " + flags + ". \"${__p[@]}\" 2>/dev/null")
    + " ; } 2>/dev/null ) | head -n " + cfg.maxScanResults]
}

// Marker lines from legacy framed cache files never start with "/", so old
// indexes parse unchanged; a truncated tail is still a valid prefix.
function markDirectories(raw) {
  var out = []
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.length > 1 && line.charAt(0) === "/") out.push(line.replace(/\/{2,}$/, "/"))
  }
  return out
}

// Count-only twin of markDirectories() for callers that merely display the
// entry total: no output array, no per-line regex substitution, and line
// scanning via indexOf so no per-line strings are built at all.
function countPaths(raw) {
  var text = String(raw || "")
  var count = 0
  var start = 0
  var len = text.length
  while (start <= len) {
    var nl = text.indexOf("\n", start)
    var end = nl === -1 ? len : nl
    if (end - start > 1 && text.charCodeAt(start) === 47) count++
    if (nl === -1) break
    start = nl + 1
  }
  return count
}

// Empty-query browse snapshot of one directory. The classify snippet orders
// directories first without trusting the walk order.
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

// Flags that consume exactly one value token, mirroring fd's CLI.
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
  "--color": 1,
}

// Spellings fd rejects, rewritten before any command is built.
var FD_FLAG_ALIASES = {
  "--ext": "--extension",
}

// fd flags that run commands instead of printing paths. The search box must
// never execute anything, so these are treated as literal search text.
var FD_EXEC_FLAGS = {
  "-x": 1, "--exec": 1,
  "-X": 1, "--exec-batch": 1,
}

function flagLike(token) {
  return token.length > 1 && token.charAt(0) === "-"
}

// Splits a raw query into fd flags and staged text:
//   "invoice"                 -> classic path
//   "--size +5mb invoice"     -> args [--size +5mb], pattern "invoice"
//   "--size=+5mb report paid" -> attached values work; "paid" goes to fzf
//   "-e pdf ."                -> args [-e pdf], match-all pattern "."
//   "-- -weird"               -> everything after "--" is literal text
//   "-x rm"                   -> exec flags are literal text, never run
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
    var bare = token
    var eq = token.indexOf("=")
    if (eq !== -1) bare = token.substring(0, eq)
    // Execution flags never reach fd: the rest of the query becomes literal
    // text, exactly like an explicit "--" separator.
    if (FD_EXEC_FLAGS.hasOwnProperty(bare)) {
      parsingFlags = false
      text.push(token)
      i++
      continue
    }
    var canonical = FD_FLAG_ALIASES.hasOwnProperty(bare)
      ? FD_FLAG_ALIASES[bare] + (eq === -1 ? "" : token.substring(eq))
      : token
    args.push(canonical)
    i++
    // Unknown flags are booleans; attached "=value" forms miss the table
    // (keys are bare flag names) and carry their own value anyway.
    if (!FD_VALUE_FLAGS.hasOwnProperty(canonical)) continue
    if (canonical.indexOf("=") !== -1) continue
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

// Live flag-mode walk, deliberately WITHOUT an fzf stage or display cap: the
// full (capped) walk is kept as the in-memory baseline and staged text
// filters client-side, so editing words never re-walks. Bad flags yield
// silence.
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
  if (!hasColorFlag(absArgs)) absArgs.push("--color=never")
  var argStr = shellJoin(absArgs).join(" ")
  var ex = combinedExcludeSegment(cfg)
  var script = "( { " + guardedRootsSnippet(cfg.searchDirs) + " ; "
    + termRelay("fd " + argStr + (ex ? " " + ex : "")
      + " " + shellQuote(parsed.fdPattern || ".") + " \"${__p[@]}\" 2>/dev/null")
    + " ; } 2>/dev/null )"
  script += " | head -n " + cap
  return ["bash", "-c", script]
}

// Identity of a live-fd run's expensive inputs. Deliberately excludes
// fzfQuery: changing only staged text must count as the same run.
// The settings signature is memoized on config object identity — QML rebuilds
// cfg only when shell.json changes, so per-keystroke calls skip re-stringifying
// every array. Mutating cfg in place would stale the memo; nothing does.
var fdSigMemo = { cfg: null, sig: "" }

function fdConfigSignature(cfg) {
  if (!cfg) return ""
  if (fdSigMemo.cfg === cfg) return fdSigMemo.sig
  var sig = JSON.stringify([cfg.searchDirs, cfg.ignoredDirs, cfg.ignoreNames, cfg.showHidden,
    cfg.fdFlags, cfg.fdOverrideArgs])
  fdSigMemo.cfg = cfg
  fdSigMemo.sig = sig
  return sig
}

function fdCacheKey(cfg, parsed) {
  if (!parsed || !parsed.args || parsed.args.length === 0 || !parsed.fdPattern) return ""
  return JSON.stringify([parsed.args, parsed.fdPattern, fdConfigSignature(cfg)])
}

// Smart-case subsequence score for one term: contiguity and boundary bonuses;
// the greedy chain is retried from each early occurrence of the term's
// initial char so anchored matches beat scattered ones. -1 when unmatched.
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

// fzf --filter-style filter: whitespace terms AND together independently;
// ties keep input order. Blank query passes everything through. With a
// positive finite limit only the best <limit> rows survive: candidates are
// streamed past a bounded top-N selector whose strict-greater replacement
// keeps the output identical to sorting everything and slicing, without the
// full scored array or sort (the warm path runs this per keystroke over
// six-figure baselines).
function fuzzyFilterRows(rows, query, limit) {
  var list = Array.isArray(rows) ? rows : []
  var capped = typeof limit === "number" && isFinite(limit) && limit > 0
  var terms = String(query == null ? "" : query).trim().split(/\s+/).filter(function (t) { return t })
  if (terms.length === 0) return capped ? list.slice(0, limit) : list.slice()
  var best = []
  var minAt = -1
  for (var i = 0; i < list.length; i++) {
    var total = 0
    var miss = false
    for (var t = 0; t < terms.length; t++) {
      var s = fuzzyScore(String(list[i]), terms[t])
      if (s < 0) { miss = true; break }
      total += s
    }
    if (miss) continue
    if (!capped || best.length < limit) {
      best.push({ row: list[i], score: total, i: i })
      // Track the eviction candidate: lowest score, highest index — exactly
      // the entry a full stable sort would place last inside the cap.
      if (capped && (minAt < 0 || total <= best[minAt].score)) minAt = best.length - 1
    } else if (total > best[minAt].score) {
      // Later indexes lose ties by construction, so equal scores never
      // displace an incumbent.
      best[minAt] = { row: list[i], score: total, i: i }
      minAt = 0
      for (var k = 1; k < best.length; k++) {
        var bScore = best[k].score
        if (bScore < best[minAt].score || (bScore === best[minAt].score && best[k].i > best[minAt].i)) minAt = k
      }
    }
  }
  best.sort(function (a, b) { return b.score - a.score || a.i - b.i })
  var out = []
  for (var j = 0; j < best.length; j++) out.push(best[j].row)
  return out
}

// Candidate set for the warm refilter. While typing EXTENDS the previous
// staged text, every term of the longer query either extends a term of the
// shorter one or is brand new, so whatever matched before is exactly the
// plausible universe — narrowing never needs a baseline pass. Backspace,
// mid-text edits and prefix breaks widen and must rescan. An incomplete
// cache (the previous pass hit its cap, so matches beyond it are unknown)
// and a blank predecessor also refuse; an empty match list stays usable
// since zero matches stay zero under narrowing.
function warmCandidates(matches, prevStaged, nextStaged, complete) {
  if (!complete || !Array.isArray(matches)) return null
  var prev = String(prevStaged == null ? "" : prevStaged)
  if (!prev) return null
  var next = String(nextStaged == null ? "" : nextStaged)
  if (next.indexOf(prev) !== 0) return null
  return matches
}

// Wire: "\t<size>\t<mtime>\n" followed by content. Size -1 marks an
// unreadable or vanished file without a second round trip.
function buildPreviewCommand(path, byteLimit) {
  if (byteLimit === undefined) byteLimit = previewByteLimit
  var quoted = shellQuote(path)
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

// Wire: "\t-2\t<entry-count>\n" followed by a one-level listing where nested
// directories keep their trailing slash. Dot entries hidden unless showHidden.
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

function deleteLastWord(text) {
  var value = String(text || "")
  var end = value.length
  while (end > 0 && /\s/.test(value.charAt(end - 1))) end--
  var start = end
  while (start > 0 && !/\s/.test(value.charAt(start - 1))) start--
  return value.substring(0, start)
}

// Directory rows carry a trailing "/" marker through the whole pipeline.
function isDirPath(path) {
  var value = String(path || "")
  return value.length > 1 && value.charAt(value.length - 1) === "/"
}

// Idempotent: fd emits doubled slashes itself on symlinked roots.
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

// Parent of a path ("." when none) — lets thumbnail jobs create their own
// scratch base instead of depending on an earlier startup step.
function parentDir(path) {
  var value = String(path || "")
  var slash = value.lastIndexOf("/")
  if (slash < 0) return "."
  if (slash === 0) return "/"
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

// Last 12 bytes of every complete PNG: IEND's length prefix, type and CRC.
// Header-only checks ([ -s ], file(1)) accept truncated files, which older
// plugin versions could publish — serving one yields a silent blank pane.
var pngEndMarker = "0000000049454e44ae426082"

// Shell condition: true when the file's tail carries the PNG IEND trailer.
function pngCompleteTest(fileExpr) {
  return '[ "$(tail -c 12 -- ' + fileExpr
    + ' 2>/dev/null | od -An -tx1 | tr -d \' \\n\')" = "' + pngEndMarker + '" ]'
}

// Shared body for both thumbnail producers (PDF/video differ only in the
// render snippet). Disk protocol: key = md5("<path>|<size>|<mtime>|<inode>")
// so an edited or replaced source can never produce a false hit. Hit streams
// the stored PNG and exits before any renderer or scratch dir runs; a stored
// file failing the IEND check is deleted and falls through to a fresh render,
// healing poison left by earlier versions. Miss renders privately and
// publishes atomically (.part unlinked then renamed) only when within the
// byte ceiling AND itself IEND-complete; oversized (-3), truncated and failed
// (-1) results are never saved. After a save the store is pruned to the newest
// <cacheLimit> files. An unavailable store degrades to render-without-persist.
// Empty storeDir or limit <= 0 disables the disk layer entirely.
function thumbnailShellBody(path, outBase, storeDir, cacheLimit, renderSnippet, ceiling) {
  var quoted = shellQuote(path)
  var quotedBase = shellQuote(outBase)
  var scratchPre = "mkdir -p -- " + shellQuote(parentDir(outBase)) + " 2>/dev/null;"
  var keep = parseInt(cacheLimit, 10)
  var head = "umask 077;"
    + " if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
  var mid = " tmp=\"$tmpd/page.png\";"
    + " " + renderSnippet
    + " if [ -s \"$tmp\" ] && " + pngCompleteTest('"$tmp"') + "; then"
    + " if [ \"$(stat -Lc %s -- \"$tmp\")\" -le " + ceiling + " ]; then"
  var close = ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 \"$tmp\";"
    + " else printf '\\t-3\\t\\n'; fi"
    + " else printf '\\t-1\\t\\n'; fi;"
    + " rm -rf -- \"$tmpd\";"
    + " else printf '\\t-1\\t\\n'; fi"
  if (!storeDir || !(keep > 0)) {
    return head
      + " " + scratchPre
      + " tmpd=$(mktemp -d -- " + quotedBase + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
      + mid
      + close
  }
  // .part files are concurrent saves in flight: they count toward no cap and
  // must never be deleted out from under a publishing job.
  var gc = "ls -1t -- \"$store\" 2>/dev/null | grep -v '\\.part$'"
    + " | tail -n +" + (keep + 1)
    + " | while IFS= read -r f; do rm -f -- \"$store/$f\"; done"
  return head
    + " mt=$(stat -Lc %Y -- " + quoted + " 2>/dev/null);"
    + " in=$(stat -Lc %i -- " + quoted + " 2>/dev/null);"
    + " key=$(printf '%s|%s|%s|%s\\n' " + quoted + " \"${sz:-?}\" \"${mt:-?}\" \"${in:-?}\" | md5sum | cut -d' ' -f1);"
    + " store=" + shellQuote(storeDir) + ";"
    + " thumb=\"\";"
    + " { [ -d \"$store\" ] || mkdir -p -- \"$store\"; } 2>/dev/null && thumb=\"$store/$key.png\";"
    + " if [ -n \"$thumb\" ] && [ -s \"$thumb\" ]; then"
    + " if " + pngCompleteTest('"$thumb"') + "; then"
    + ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 -- \"$thumb\"; exit 0; fi;"
    + " rm -f -- \"$thumb\"; fi;"
    + " " + scratchPre
    + " tmpd=$(mktemp -d -- " + quotedBase + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
    + mid
    + " if [ -n \"$thumb\" ]; then"
    + " rm -f -- \"$thumb.part\";"
    + " { cp -f -- \"$tmp\" \"$thumb.part\" && mv -f -- \"$thumb.part\" \"$thumb\"; } 2>/dev/null;"
    + " " + gc + ";"
    + " fi;"
    + close
}

// Renders page 1 into a private mode-0700 mktemp dir (concurrent or killed
// renders can never touch each other) and reports "\t<size>\t" + base64 PNG.
// pdftoppm is relay-wrapped to die on stale teardown. Scratch is removed even
// after failed renders.
function buildPdfPreviewCommand(path, outBase, storeDir, cacheLimit, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var render = termRelay("timeout -k 5 " + renderTimeoutSecs
    + " pdftoppm -png -f 1 -singlefile -scale-to " + scale
    + " " + shellQuote(path) + " \"${tmp%.png}\"") + ";"
  return ["bash", "-c", thumbnailShellBody(path, outBase, storeDir, cacheLimit, render, ceiling)]
}

// Self-contained <img> source, or "" for empty/over-ceiling payloads so an
// unbounded data URL can never be constructed.
function pdfDataUrl(b64) {
  var s = String(b64 || "").replace(/\s+/g, "")
  if (s.length === 0 || s.length > Math.ceil(thumbPngByteCeiling / 3) * 4) return ""
  return "data:image/png;base64," + s
}

// Same wire format/store/GC as the PDF producer. Seeks 1s in; clips shorter
// than that (or without a decodable frame at 1s) retry from 0s. -nostdin
// keeps ffmpeg from eating a collector's stdin.
function buildVideoThumbnailCommand(path, outBase, storeDir, cacheLimit, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var grab = function (ss) {
    return termRelay("timeout -k 5 " + renderTimeoutSecs
      + " ffmpeg -nostdin -hide_banner -loglevel error -ss " + ss
      + " -i " + shellQuote(path)
      + " -frames:v 1 -map v:0 -vf 'scale=min(iw\\," + scale + "):-2'"
      + " -y \"$tmp\"") + ";"
  }
  return ["bash", "-c", thumbnailShellBody(path, outBase, storeDir, cacheLimit,
    grab(1) + " if [ ! -s \"$tmp\" ]; then " + grab(0) + " fi;", ceiling)]
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
    thumbnailCacheLimit: thumbnailCacheLimit,
    previewWorkers: previewWorkers,
    debounceMs: debounceMs,
    rescanIntervalMs: rescanIntervalMs,
    pdfRenderScale: pdfRenderScale,
    builtinIgnoreNames: builtinIgnoreNames,
    termRelay: termRelay,
    scanSectionMarker: scanSectionMarker,
    scanRootsMarker: scanRootsMarker,
    setting: setting,
    positiveInt: positiveInt,
    nonNegativeInt: nonNegativeInt,
    ignoredNames: ignoredNames,
    boolSetting: boolSetting,
    sanitizedFdFlags: sanitizedFdFlags,
    hasExecFlag: hasExecFlag,
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
    FD_EXEC_FLAGS: FD_EXEC_FLAGS,
    parseQuery: parseQuery,
    liveFdCommand: liveFdCommand,
    fdCacheKey: fdCacheKey,
    fuzzyFilterRows: fuzzyFilterRows,
    warmCandidates: warmCandidates,
    deleteLastWord: deleteLastWord,
    markDirectories: markDirectories,
    countPaths: countPaths,
    buildSearchCommand: buildSearchCommand,
    buildPreviewCommand: buildPreviewCommand,
    buildDirPreviewCommand: buildDirPreviewCommand,
    parsePreviewOutput: parsePreviewOutput,
    fileName: fileName,
    dirName: dirName,
    isDirPath: isDirPath,
    cleanPath: cleanPath,
    parentDir: parentDir,
    shortenPath: shortenPath,
    isImagePath: isImagePath,
    isPdfPath: isPdfPath,
    isVideoPath: isVideoPath,
    buildPdfPreviewCommand: buildPdfPreviewCommand,
    buildVideoThumbnailCommand: buildVideoThumbnailCommand,
    thumbPngByteCeiling: thumbPngByteCeiling,
    pdfDataUrl: pdfDataUrl,
    renderTimeoutSecs: renderTimeoutSecs,
    pngEndMarker: pngEndMarker,
    pngCompleteTest: pngCompleteTest,
    formatBytes: formatBytes
  }
}
