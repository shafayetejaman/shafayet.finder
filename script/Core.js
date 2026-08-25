// Generic toolbox shared by every feature module: shell quoting, setting
// primitives, path utilities, type detectors, and path-line scanners.
// QML-free where possible so node can exercise it directly.

function positiveInt(settings, name, fallback) {
  var value = parseInt(setting(settings, name, fallback), 10)
  return isFinite(value) && value > 0 ? value : fallback
}

function nonNegativeInt(settings, name, fallback) {
  var value = parseInt(setting(settings, name, fallback), 10)
  return isFinite(value) && value >= 0 ? value : fallback
}

function setting(settings, name, fallback) {
  var value = settings ? settings[name] : undefined
  return value === undefined || value === null ? fallback : value
}

function boolSetting(settings, name, fallback) {
  var value = setting(settings, name, fallback)
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
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

function expandPath(path, home) {
  var value = String(path || "").trim()
  if (!value) return ""
  if (value.indexOf("$HOME") === 0 && (value.length === 5 || value.charAt(5) === "/")) value = home + value.substring(5)
  else if (value.indexOf("~") === 0 && (value.length === 1 || value.charAt(1) === "/")) value = home + value.substring(1)
  while (value.length > 1 && value.charAt(value.length - 1) === "/") value = value.slice(0, -1)
  return value
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

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

function shellJoin(args) {
  var parts = []
  for (var i = 0; i < args.length; i++) parts.push(shellQuote(args[i]))
  return parts
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
    positiveInt: positiveInt,
    nonNegativeInt: nonNegativeInt,
    setting: setting,
    boolSetting: boolSetting,
    asStringArray: asStringArray,
    expandPath: expandPath,
    expandPaths: expandPaths,
    shellQuote: shellQuote,
    shellJoin: shellJoin,
    isDirPath: isDirPath,
    cleanPath: cleanPath,
    dirName: dirName,
    parentDir: parentDir,
    fileName: fileName,
    deleteLastWord: deleteLastWord,
    shortenPath: shortenPath,
    isImagePath: isImagePath,
    isPdfPath: isPdfPath,
    isVideoPath: isVideoPath,
    markDirectories: markDirectories,
    countPaths: countPaths,
    formatBytes: formatBytes
  }
}
