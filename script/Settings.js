// User configuration resolution: shell.json plugins[] entries merged over
// static defaults into the single cfg object every other module consumes.

.import "Core.js" as Core
.import "FdQuery.js" as FdQuery

var maxScanResults = 100000
var maxDisplayRows = 50
var maxBrowseRows = 200
var previewByteLimit = 65536
var previewCacheLimit = 500
var pdfCacheLimit = 12
// -scale-to for page thumbnails; also caps video frame width.
var pdfRenderScale = 800
var previewWorkers = 3
var debounceMs = 40
var fdDebounceMs = 1000
// One background walk per interval at most: scans fire on open (plus the
// one-shot startup refresh), so this bounds bursts without any idle timer.
var rescanIntervalMs = 300000
// Persistent thumbnails under ~/.cache/thumbnails/<plugin>/{pdf,video}/,
// keyed by md5("<path>|<size>|<mtime>|<inode>"). <= 0 disables persistence.
var thumbnailCacheLimit = 500
var fontTitle = 13
var fontCaption = 12
var fontHeading = 16
var fontDisplayLarge = 18

// Non-hidden junk directories fd would otherwise index.
var builtinIgnoreNames = ["node_modules", "__pycache__"]

function ignoredNames(settings) {
  return Core.asStringArray(Core.setting(settings, "ignored_names", []))
}

function resolveBrowseDir(settings, home) {
  var expanded = Core.expandPath(Core.setting(settings, "browse_dir", ""), home)
  return expanded || home + "/Downloads"
}

function searchDirs(settings, home) {
  var raw = Core.setting(settings, "search_dirs", ["$HOME"])
  var expanded = Core.expandPaths(Core.asStringArray(raw), home)
  return expanded.length > 0 ? expanded : [home]
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

// Merges a shell.json plugins[] entry over the static defaults. Safe to call
// with {} or null.
function resolveSettings(settings, home) {
  var rawFd = Core.asStringArray(Core.setting(settings, "fd_flags", []))
  // One gate for both consumers: a poisoned fd_flags must not reach the
  // classic flag segment any more than the override path.
  var safeFd = FdQuery.hasExecFlag(rawFd) ? [] : rawFd
  var ignoredDirs = Core.expandPaths(Core.asStringArray(Core.setting(settings, "ignored_dirs", [])), home)
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
    maxScanResults: Core.positiveInt(settings, "max_scan_results", maxScanResults),
    maxDisplayRows: Core.positiveInt(settings, "max_display_rows", maxDisplayRows),
    maxBrowseRows: Core.positiveInt(settings, "max_browse_rows", maxBrowseRows),
    previewByteLimit: Core.positiveInt(settings, "preview_byte_limit", previewByteLimit),
    previewCacheLimit: Core.positiveInt(settings, "preview_cache_limit", previewCacheLimit),
    pdfCacheLimit: Core.positiveInt(settings, "pdf_cache_limit", pdfCacheLimit),
    // 0 is the documented opt-out, hence nonNegativeInt.
    thumbnailCacheLimit: Core.nonNegativeInt(settings, "thumbnail_cache_limit", thumbnailCacheLimit),
    // More than 3 slots can never be fed: selected row + two neighbors.
    previewWorkers: Math.min(3, Core.positiveInt(settings, "preview_workers", previewWorkers)),
    debounceMs: Core.nonNegativeInt(settings, "debounce_ms", debounceMs),
    fdDebounceMs: Core.nonNegativeInt(settings, "fd_debounce_ms", fdDebounceMs),
    rescanIntervalMs: Core.nonNegativeInt(settings, "rescan_interval_ms", rescanIntervalMs),
    pdfRenderScale: Math.min(4000, Math.max(64, Core.positiveInt(settings, "pdf_render_scale", pdfRenderScale))),
    showHidden: Core.boolSetting(settings, "show_hidden", false),
    contentFontSize: Core.positiveInt(settings, "content_font_size", fontTitle),
    contentCaption: Core.positiveInt(settings, "content_caption", fontCaption),
    contentHeading: Core.positiveInt(settings, "content_heading", fontHeading),
    contentDisplayLarge: Core.positiveInt(settings, "content_display_large", fontDisplayLarge),
    fdFlags: FdQuery.sanitizedFdFlags(safeFd),
    fdOverrideArgs: safeFd.length > 0 ? FdQuery.fdOverrideArgs(safeFd) : null,
    browseDir: resolveBrowseDir(settings, home)
  }
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
    fdDebounceMs: fdDebounceMs,
    rescanIntervalMs: rescanIntervalMs,
    thumbnailCacheLimit: thumbnailCacheLimit,
    builtinIgnoreNames: builtinIgnoreNames,
    ignoredNames: ignoredNames,
    resolveBrowseDir: resolveBrowseDir,
    searchDirs: searchDirs,
    pruneContainedRoots: pruneContainedRoots,
    resolveSettings: resolveSettings
  }
}
