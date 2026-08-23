// Pure helpers for the fuzzy file finder: settings parsing, path display,
// and command construction for the fd/fzf pipeline. Kept free of QML so it
// can be exercised with node like ClipboardHistory.js.

var maxScanResults = 100000
var maxDisplayRows = 50
var maxBrowseRows = 200
var previewByteLimit = 65536

// Non-hidden junk directories fd would otherwise happily index. Hidden dirs
// never reach the list because the scan omits --hidden; these are the ones
// users actually complain about.
var builtinIgnoreNames = ["node_modules", "__pycache__"]

function setting(settings, name, fallback) {
  var value = settings ? settings[name] : undefined
  return value === undefined || value === null ? fallback : value
}

function expandPath(path, home) {
  var value = String(path || "").trim()
  if (!value) return ""
  if (value.indexOf("$HOME") === 0) value = home + value.substring(5)
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

function ignorePatterns(settings, home) {
  var configured = expandPaths(asStringArray(setting(settings, "ignored_dirs", [])), home)
  return builtinIgnoreNames.concat(configured)
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

// One fd pass per search dir for files and another for directories so a
// missing directory cannot sink the others; directories carry a trailing "/"
// through the pipeline as their type marker.
function buildScanCommand(dirs, patterns) {
  var parts = []
  for (var i = 0; i < dirs.length; i++) {
    parts.push("fd --type file --absolute-path . " + shellQuote(dirs[i]) + " 2>/dev/null"
      + " ; fd --type directory --absolute-path . " + shellQuote(dirs[i]) + " 2>/dev/null | sed 's|[^/]$|&/|'")
  }
  var script = "( " + parts.join(" ; ") + " ) 2>/dev/null"
  var clean = []
  for (var p = 0; p < patterns.length; p++) {
    if (patterns[p]) clean.push(patterns[p])
  }
  if (clean.length > 0) {
    var args = []
    for (var e = 0; e < clean.length; e++) args.push("-e " + shellQuote(clean[e]))
    script += " | grep -vF " + args.join(" ")
  }
  script += " | head -n " + maxScanResults
  return ["bash", "-c", script]
}

// Non-recursive snapshot of one directory, directories first. Shown when the
// query is empty so the finder opens as a browser of ~/Downloads.
function buildBrowseCommand(dir) {
  return ["bash", "-c",
    "{ [ -d " + shellQuote(dir) + " ] || exit 0 ; } ; "
    + "( fd --type directory --absolute-path --min-depth 1 --max-depth 1 . " + shellQuote(dir) + " 2>/dev/null | sed 's|[^/]$|&/|'"
    + " ; fd --type file --absolute-path --min-depth 1 --max-depth 1 . " + shellQuote(dir) + " 2>/dev/null )"
    + " | head -n " + maxBrowseRows
  ]
}

function buildSearchCommand(listPath, query) {
  return [
    "bash", "-c",
    "fzf --filter " + shellQuote(query) + " --scheme=path 2>/dev/null < " + shellQuote(listPath) + " | head -n " + maxDisplayRows
  ]
}

function buildPreviewCommand(path) {
  var quoted = shellQuote(path)
  // First line is "\t<size>\t<mtime>"; the rest is file content. A size of -1
  // marks an unreadable or vanished file without a second round trip.
  return [
    "bash", "-c",
    "if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " mt=$(stat -Lc %y -- " + quoted + " 2>/dev/null | cut -d. -f1);"
    + ' printf "\\t%s\\t%s\\n" "${sz:-?}" "$mt";'
    + " head -c " + previewByteLimit + " -- " + quoted + " 2>/dev/null;"
    + " else printf '\\t-1\\t\\n'; fi"
  ]
}

// Directory preview: "\t-2\t<entry-count>" header, then a one-level listing
// where nested directories keep their trailing slash.
function buildDirPreviewCommand(path) {
  var quoted = shellQuote(path)
  return [
    "bash", "-c",
    "{ [ -d " + quoted + " ] || exit 0 ; } ;"
    + ' cnt=$(ls -1A -- ' + quoted + ' 2>/dev/null | wc -l);'
    + ' printf "\\t-2\\t%s\\n" "$cnt";'
    + " ls -1Ap --color=never -- " + quoted + " 2>/dev/null | head -c " + previewByteLimit
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

// Renders page 1 of a PDF to <outBase>.png and reports "\t<size>\t<pages>"
// so the caller can label the thumbnail without a second process.
function buildPdfPreviewCommand(path, outBase) {
  var quoted = shellQuote(path)
  return [
    "bash", "-c",
    "if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " pg=$(pdfinfo " + quoted + " 2>/dev/null | awk '/^Pages:/ {print $2}');"
    + ' printf "\\t%s\\t%s\\n" "${sz:-?}" "$pg";'
    + " pdftoppm -png -f 1 -singlefile -scale-to 1200 " + quoted + " " + shellQuote(outBase) + " 2>/dev/null;"
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
    builtinIgnoreNames: builtinIgnoreNames,
    setting: setting,
    expandPath: expandPath,
    asStringArray: asStringArray,
    expandPaths: expandPaths,
    searchDirs: searchDirs,
    ignorePatterns: ignorePatterns,
    shellQuote: shellQuote,
    buildScanCommand: buildScanCommand,
    buildBrowseCommand: buildBrowseCommand,
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
