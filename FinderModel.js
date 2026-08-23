// Pure helpers for the fuzzy file finder: settings parsing, path display,
// and command construction for the fd/fzf pipeline. Kept free of QML so it
// can be exercised with node like ClipboardHistory.js.

var maxScanResults = 100000
var maxDisplayRows = 50
var maxBrowseRows = 200
var previewByteLimit = 65536
var previewCacheLimit = 500
var previewWorkers = 3
var debounceMs = 40
var rescanIntervalMs = 60000
var pdfRenderScale = 1200

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
    searchDirs: effectiveDirs,
    // Names prune as unanchored excludes (any depth); dirs as anchored
    // per-root excludes (see fdExcludeArgs).
    ignoreNames: builtinIgnoreNames.concat(ignoredNames(settings)),
    ignoredDirs: ignoredDirs,
    maxScanResults: positiveInt(settings, "max_scan_results", maxScanResults),
    maxDisplayRows: positiveInt(settings, "max_display_rows", maxDisplayRows),
    maxBrowseRows: positiveInt(settings, "max_browse_rows", maxBrowseRows),
    previewByteLimit: positiveInt(settings, "preview_byte_limit", previewByteLimit),
    previewCacheLimit: positiveInt(settings, "preview_cache_limit", previewCacheLimit),
    previewWorkers: positiveInt(settings, "preview_workers", previewWorkers),
    debounceMs: nonNegativeInt(settings, "debounce_ms", debounceMs),
    rescanIntervalMs: nonNegativeInt(settings, "rescan_interval_ms", rescanIntervalMs),
    pdfRenderScale: positiveInt(settings, "pdf_render_scale", pdfRenderScale),
    showHidden: boolSetting(settings, "show_hidden", false),
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

// Renders page 1 of a PDF to <outBase>.png and reports "\t<size>\t" so the
// caller can label the thumbnail. pdftoppm writes straight to a file rather
// than the pipe, so it is relay-wrapped to die on stale-process teardown,
// and the header is only printed after checking that a non-empty PNG
// actually landed: a corrupt or unreadable document reports size -1 instead
// of being cached as successfully rendered.
function buildPdfPreviewCommand(path, outBase, scale) {
  if (scale === undefined) scale = pdfRenderScale
  var quoted = shellQuote(path)
  var pngQuoted = shellQuote(outBase + ".png")
  var render = termRelay("pdftoppm -png -f 1 -singlefile -scale-to " + scale + " " + quoted + " " + shellQuote(outBase))
  return [
    "bash", "-c",
    "if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " " + render + ";"
    + " if [ -s " + pngQuoted + " ]; then"
    + ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " else printf '\\t-1\\t\\n'; fi"
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
    shellQuote: shellQuote,
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
    formatBytes: formatBytes
  }
}
