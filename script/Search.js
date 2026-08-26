// Search execution: the fzf index filter, live flag-mode fd walks, the
// run-identity memo that lets staged-text edits refilter without re-walking,
// and the effective-query resolver that merges tab flags into queries.

.import "Core.js" as Core
.import "FdQuery.js" as FdQuery
.import "Walks.js" as Walks

// Resolves a raw search-box query against the active filter tab.  Returns null
// when no tab injection is needed (classic fzf-over-index path), or a parsed
// object with merged args, fdPattern, fzfQuery, and optional sortMode.
function effectiveQuery(text, tab) {
  var tabInfo = FdQuery.tabArgs(tab)
  var parsed = FdQuery.parseQuery(text)

  // No tab flags and no manual flags → classic fzf-over-index.
  if (tabInfo.args.length === 0 && !tabInfo.sort && parsed.args.length === 0) {
    return null
  }
  // Manual flags only (no tab injection) → existing flag mode verbatim.
  if (tabInfo.args.length === 0 && !tabInfo.sort) {
    return parsed
  }
  // Tab active: merge manual flags with tab flags, all text goes to fzf
  // staging, fd pattern is match-all (the tab flags do the filtering).
  var mergedArgs = parsed.args.concat(tabInfo.args)
  var staged = []
  if (parsed.fdPattern) staged.push(parsed.fdPattern)
  if (parsed.fzfQuery) staged.push(parsed.fzfQuery)
  return {
    args: mergedArgs,
    fdPattern: (mergedArgs.length > 0 || tabInfo.sort) ? "." : "",
    fzfQuery: staged.join(" "),
    sortMode: tabInfo.sort || null
  }
}

// Returns true when the user typed manual fd flags on a non-'all' tab,
// which is not allowed — the tab already injects its own flags.
function hasInvalidFlags(text, tab) {
  var tabInfo = FdQuery.tabArgs(tab)
  if (tabInfo.args.length === 0 && !tabInfo.sort) return false
  var parsed = FdQuery.parseQuery(text)
  return parsed.args.length > 0
}

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
      !parsed || !parsed.args || (parsed.args.length === 0 && !parsed.sortMode)) {
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
  var fdCmd = "fd " + argStr + (ex ? " " + ex : "")
    + " " + Core.shellQuote(parsed.fdPattern || ".") + " \"${__p[@]}\" 2>/dev/null"
  if (parsed.sortMode) {
    fdCmd += " " + FdQuery.sortPipeSnippet(parsed.sortMode)
  }
  return ["bash", "-c",
    Walks.cappedRelay(fdCmd, cap, Walks.guardedRootsSnippet(cfg.searchDirs))]
}

// Live-fd run identity: config signature + args + pattern + sortMode,
// deliberately excluding fzfQuery (staged-text edits count as the same run).
// Memoized on cfg object identity; mutating cfg in place would stale it.
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
  if (!parsed) return ""
  if (parsed.args.length === 0 && !parsed.sortMode) return ""
  if (!parsed.fdPattern) return ""
  return JSON.stringify([parsed.args, parsed.fdPattern, parsed.sortMode || null, fdConfigSignature(cfg)])
}

if (typeof module !== "undefined") {
  module.exports = {
    effectiveQuery: effectiveQuery,
    hasInvalidFlags: hasInvalidFlags,
    buildSearchCommand: buildSearchCommand,
    liveFdCommand: liveFdCommand,
    fdConfigSignature: fdConfigSignature,
    fdCacheKey: fdCacheKey
  }
}
