// Filesystem walks: root guarding, policy excludes, kill-safe relays, and
// the scan/browse command builders over both classic and override fd modes.

.import "Core.js" as Core
.import "FdQuery.js" as FdQuery

// Emitted to the scan's stderr as "<marker><alive>/<total>"; lets QML tell a
// partially dead walk (e.g. unmounted HDD shrinking the index to $HOME-only)
// apart from a full one before trusting its output.
var scanRootsMarker = "FINDER_ROOTS="

// "@@DIRS@@" frames the file/dir chunks; absolute paths never start with "@",
// so marker lines stay unambiguous against legacy cached indexes.
var scanSectionMarker = "@@DIRS@@"

// Relays SIGTERM to the direct child, so killing the bash wrapper also stops
// CPU-heavy leaves like fd/pdftoppm. Pipeline members downstream exit on
// their own via EOF/EPIPE once the leaf dies.
function termRelay(cmd) {
  return "{ " + cmd + " & __p=$!; trap 'kill -TERM \"$__p\" 2>/dev/null' TERM INT; wait \"$__p\"; }"
}

// Shared tail of every root walk: fd silenced inside the relay braces, output
// capped by head (any truncated prefix stays a valid index/listing). The
// optional prologue sits inside the braces only where callers need it there.
function cappedRelay(fdCmd, cap, prologue) {
  return "( { " + (prologue ? prologue + " ; " : "") + termRelay(fdCmd)
    + " ; } 2>/dev/null ) | head -n " + cap
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

// Bash prologue collecting live roots into __p[], so one dead mount cannot
// fail the whole walk. Runs UNSILENCED at top level: the stderr ratio report
// must reach the caller, and an all-dead set exits before any pipeline starts.
function guardedRootsSnippet(searchDirs, reportRatio) {
  var parts = ["__p=()"]
  for (var i = 0; i < searchDirs.length; i++) {
    var quoted = Core.shellQuote(searchDirs[i])
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
  return Core.shellJoin(fdExcludeArgs(root, cfg.ignoreNames, cfg.ignoredDirs)).join(" ")
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
  return Core.shellJoin(combinedExcludeArgs(cfg.ignoreNames, cfg.ignoredDirs, cfg.searchDirs)).join(" ")
}

// QML entry point: policy excludes enforced in both override and classic
// modes; one relay-wrapped fd walk over all roots. stateDir folds its mkdir in.
function scanCommand(cfg, stateDir) {
  var pre = stateDir ? "mkdir -p -- " + Core.shellQuote(stateDir) + "; " : ""
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0) return ["bash", "-c", pre]
  if (cfg && cfg.fdOverrideArgs) {
    var argStr = Core.shellJoin(cfg.fdOverrideArgs).join(" ")
    var ex = combinedExcludeSegment(cfg)
    return ["bash", "-c",
      pre
      + guardedRootsSnippet(cfg.searchDirs, true) + " ; "
      + cappedRelay("fd " + argStr + (ex ? " " + ex : "") + " . \"${__p[@]}\" 2>/dev/null",
        cfg.maxScanResults)]
  }
  return ["bash", "-c", pre + scanCommandClassic(cfg)[2]]
}

// One relay-wrapped fd walk over every live root. Head truncation severs the
// line stream, and any prefix of it is a valid index.
function scanCommandClassic(cfg) {
  var flags = FdQuery.fdFlagSegment(cfg.fdFlags)
  flags += "--type file --type directory "
  if (cfg.showHidden) flags += "--hidden "
  var ex = combinedExcludeSegment(cfg)
  if (ex) flags += ex + " "
  flags += "--absolute-path "
  return ["bash", "-c",
    guardedRootsSnippet(cfg.searchDirs, true) + " ; "
    + cappedRelay("fd " + flags + ". \"${__p[@]}\" 2>/dev/null", cfg.maxScanResults)]
}

// Depth-limited browse variant: the relay feeds fdClassifySnippet so
// directories list before files regardless of walk order.
function classifiedRelay(fdCmd, cap) {
  return "( " + termRelay(fdCmd) + " | " + fdClassifySnippet(true)
    + " ) 2>/dev/null | head -n " + cap
}

function browseCommand(cfg) {
  if (cfg && cfg.fdOverrideArgs) {
    var argStr = Core.shellJoin(cfg.fdOverrideArgs).join(" ")
    var quoted = Core.shellQuote(cfg.browseDir)
    var ex = quotedExcludeSegment(cfg.browseDir, cfg)
    var fdCmd = "fd " + argStr + (ex ? " " + ex : "") + " --min-depth 1 --max-depth 1 . " + quoted
    return ["bash", "-c",
      "{ [ -d " + quoted + " ] || exit 0 ; } ; "
      + classifiedRelay(fdCmd + " 2>/dev/null", cfg.maxBrowseRows)]
  }
  return browseCommandClassic(cfg)
}

// Empty-query browse snapshot of one directory. The classify snippet orders
// directories first without trusting the walk order.
function browseCommandClassic(cfg) {
  var dir = cfg.browseDir
  var quoted = Core.shellQuote(dir)
  var flags = FdQuery.fdFlagSegment(cfg.fdFlags)
  if (cfg.showHidden) flags += "--hidden "
  var ex = quotedExcludeSegment(dir, cfg)
  if (ex) flags += ex + " "
  return ["bash", "-c",
    "{ [ -d " + quoted + " ] || exit 0 ; } ; "
    + classifiedRelay("fd " + flags
      + "--type directory --type file --absolute-path --min-depth 1 --max-depth 1 . " + quoted + " 2>/dev/null",
      cfg.maxBrowseRows)]
}

// ================= resident change watcher =================

// Escapes a literal string for embedding in an inotifywait --exclude POSIX
// extended regex: metacharacters become inert literals.
function escapeRegex(text) {
  return String(text || "").replace(/[.[\]{}()*+?^$|\\]/g, "\\$&")
}

// One --exclude extended regex mirroring the scan policy, so churn inside
// never-indexed trees cannot dirty the index. Names match at any depth;
// ignored dirs anchor at their absolute path; without show_hidden, hidden
// components are skipped exactly like an un--hidden fd walk would.
function watchExcludeRegex(cfg) {
  var parts = []
  var names = cfg && cfg.ignoreNames ? cfg.ignoreNames : []
  for (var i = 0; i < names.length; i++) {
    if (names[i]) parts.push("/" + escapeRegex(names[i]) + "/")
  }
  var dirs = cfg && cfg.ignoredDirs ? cfg.ignoredDirs : []
  for (i = 0; i < dirs.length; i++) {
    if (dirs[i]) parts.push("^" + escapeRegex(dirs[i]) + "(/|$)")
  }
  if (cfg && !cfg.showHidden) parts.push("(^|/)\\.")
  return parts.join("|")
}

// Resident recursive watcher over every live root. Deliberately plain argv —
// no bash wrapper, nothing to quote, nothing to inject. Default output keeps
// real newlines (this build does not expand "\n" escapes in --format), and
// Finder.qml treats every line as one event. Returns null with no live roots
// so the caller keeps its existing lifecycle rather than spawning an eternal
// no-op.
function buildWatchCommand(cfg) {
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0) return null
  var args = ["inotifywait", "-m", "-r", "-q",
    "-e", "create,delete,moved_to,moved_from,close_write"]
  var ex = watchExcludeRegex(cfg)
  if (ex) args.push("--exclude", ex)
  return args.concat(cfg.searchDirs.slice())
}

if (typeof module !== "undefined") {
  module.exports = {
    scanRootsMarker: scanRootsMarker,
    scanSectionMarker: scanSectionMarker,
    termRelay: termRelay,
    cappedRelay: cappedRelay,
    fdClassifySnippet: fdClassifySnippet,
    guardedRootsSnippet: guardedRootsSnippet,
    fdExcludeArgs: fdExcludeArgs,
    quotedExcludeSegment: quotedExcludeSegment,
    combinedExcludeArgs: combinedExcludeArgs,
    combinedExcludeSegment: combinedExcludeSegment,
    relativeToDeepestRoot: relativeToDeepestRoot,
    scanCommand: scanCommand,
    scanCommandClassic: scanCommandClassic,
    browseCommand: browseCommand,
    browseCommandClassic: browseCommandClassic,
    escapeRegex: escapeRegex,
    watchExcludeRegex: watchExcludeRegex,
    buildWatchCommand: buildWatchCommand
  }
}
