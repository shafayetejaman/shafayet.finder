// fd flag handling: user-flag sanitizing, exec/color gates, override-mode
// argument assembly, search-box query parsing, and filter-tab definitions.

.import "Core.js" as Core

// Ordered tab ids for the UI chip row.  "all" is the default (no flags).
var TAB_LIST = ["all", "folder", "document", "image", "music", "pdf", "modified", "created"]

// Per-tab fd args and optional stat-sort mode.  Extension tabs emit repeated
// -e pairs; sort tabs return an empty args array plus a mode string that the
// caller wires into a stat-based descending pipeline.
function tabArgs(tab) {
  var id = String(tab || "").toLowerCase()
  switch (id) {
  case "folder":
    return { args: ["--type", "directory"], sort: null }
  case "document":
    return { args: ["-e", "pdf", "-e", "doc", "-e", "docx", "-e", "odt", "-e", "rtf",
                     "-e", "txt", "-e", "md", "-e", "xls", "-e", "xlsx", "-e", "csv",
                     "-e", "ppt", "-e", "pptx", "-e", "epub"], sort: null }
  case "image":
    return { args: ["-e", "png", "-e", "jpg", "-e", "jpeg", "-e", "gif", "-e", "webp",
                     "-e", "svg", "-e", "bmp", "-e", "tiff", "-e", "ico"], sort: null }
  case "music":
    return { args: ["-e", "mp3", "-e", "flac", "-e", "wav", "-e", "ogg", "-e", "opus",
                     "-e", "m4a", "-e", "aac", "-e", "wma"], sort: null }
  case "pdf":
    return { args: ["-e", "pdf"], sort: null }
  case "modified":
    return { args: [], sort: "mtime" }
  case "created":
    return { args: [], sort: "birth" }
  default:
    return { args: [], sort: null }
  }
}

// Stat-sort shell snippet that reads paths from stdin and emits them sorted
// descending by the given stat field.  "mtime" uses %Y, "birth" uses %W.
// Produces a pipe segment the caller appends to fd output.
// xargs -P 8 parallelizes stat calls for faster sort on large result sets.
function sortPipeSnippet(sortMode) {
  var field = sortMode === "birth" ? "%W" : "%Y"
  return "| xargs -0 -I {} -P 8 sh -c "
    + "'printf \"%s\\t%s\\n\" \"$(stat -c '" + field + "' -- \"{}\" 2>/dev/null || echo 0)\" \"{}\"'"
    + " | sort -t'	' -rn | cut -f2-"
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

// -x/--exec consume variable argument lists, so excising them reliably is
// riskier than discarding the override; config falls back to the classic baseline.
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
  for (var i = 0; i < clean.length; i++) parts.push(Core.shellQuote(clean[i]))
  return parts.length > 0 ? parts.join(" ") + " " : ""
}

// Override-mode flags verbatim, plus forced --absolute-path when neither
// spelling is present: the index stores absolute paths, so relative output
// would be unusable.
function fdOverrideArgs(flags) {
  var args = Array.isArray(flags) ? flags.slice() : []
  var found = false
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--absolute-path" || args[i] === "-a") { found = true; break }
  }
  if (!found) args.push("--absolute-path")
  if (!hasColorFlag(args)) args.push("--color=never")
  return args
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

if (typeof module !== "undefined") {
  module.exports = {
    FD_VALUE_FLAGS: FD_VALUE_FLAGS,
    FD_FLAG_ALIASES: FD_FLAG_ALIASES,
    FD_EXEC_FLAGS: FD_EXEC_FLAGS,
    sanitizedFdFlags: sanitizedFdFlags,
    hasExecFlag: hasExecFlag,
    hasColorFlag: hasColorFlag,
    fdFlagSegment: fdFlagSegment,
    fdOverrideArgs: fdOverrideArgs,
    parseQuery: parseQuery,
    TAB_LIST: TAB_LIST,
    tabArgs: tabArgs,
    sortPipeSnippet: sortPipeSnippet
  }
}
