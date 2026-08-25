// Search execution: the fzf index filter, live flag-mode fd walks, and the
// run-identity memo that lets staged-text edits refilter without re-walking.

.import "Core.js" as Core
.import "FdQuery.js" as FdQuery
.import "Walks.js" as Walks

function buildSearchCommand(listPath, query, displayLimit) {
  if (displayLimit === undefined) displayLimit = 50
  return [
    "bash", "-c",
    "fzf --filter " + Core.shellQuote(query) + " --scheme=path 2>/dev/null < " + Core.shellQuote(listPath) + " | head -n " + displayLimit
  ]
}

// Live flag-mode walk, deliberately WITHOUT an fzf stage or display cap: the
// full (capped) walk is kept as the in-memory baseline and staged text
// filters client-side, so editing words never re-walks. Bad flags yield
// silence.
function liveFdCommand(cfg, parsed, cap) {
  if (cap === undefined) cap = 100000
  if (!cfg || !cfg.searchDirs || cfg.searchDirs.length === 0 ||
      !parsed || !parsed.args || parsed.args.length === 0) {
    return ["bash", "-c", ""]
  }
  var absArgs = parsed.args.slice()
  if (absArgs.indexOf("--absolute-path") === -1 && absArgs.indexOf("-a") === -1) absArgs.push("--absolute-path")
  if (cfg.showHidden && absArgs.indexOf("--hidden") === -1 && absArgs.indexOf("-H") === -1 && absArgs.indexOf("-u") === -1) {
    absArgs.push("--hidden")
  }
  if (!FdQuery.hasColorFlag(absArgs)) absArgs.push("--color=never")
  var argStr = Core.shellJoin(absArgs).join(" ")
  var ex = Walks.combinedExcludeSegment(cfg)
  return ["bash", "-c",
    Walks.cappedRelay("fd " + argStr + (ex ? " " + ex : "")
      + " " + Core.shellQuote(parsed.fdPattern || ".") + " \"${__p[@]}\" 2>/dev/null",
      cap, Walks.guardedRootsSnippet(cfg.searchDirs))]
}

// Live-fd run identity: config signature + args + pattern, deliberately
// excluding fzfQuery (staged-text edits count as the same run). Memoized on
// cfg object identity; mutating cfg in place would stale it — nothing does.
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

if (typeof module !== "undefined") {
  module.exports = {
    buildSearchCommand: buildSearchCommand,
    liveFdCommand: liveFdCommand,
    fdConfigSignature: fdConfigSignature,
    fdCacheKey: fdCacheKey
  }
}
