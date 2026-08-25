import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "script/Core.js" as Core
import "script/Fuzzy.js" as Fuzzy
import "script/FdQuery.js" as FdQuery
import "script/Walks.js" as Walks
import "script/Search.js" as Search
import "script/Settings.js" as Settings
import "script/Preview.js" as Preview

Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool opened: false
  property string filterText: ""
  property int selectedIndex: 0
  property bool cursorActive: false
  property bool scanning: false
  property int fileListCount: 0

  property int scanSerial: 0
  property int searchSerial: 0
  property int browseSerial: 0
  property int fdSerial: 0
  property bool scanQueued: false
  property double lastScanFinishedAt: 0
  // Creation time; early post-restart walks truncate, so the first rescan
  // waits one interval while a disk-loaded index exists (see refreshScan).
  property double startedAt: Date.now()
  // On-disk index dedup: file text + whether it was truly disk-loaded (a
  // failed load must not suppress the first write).
  property string lastIndexedText: ""
  property bool lastIndexFromDisk: false
  // Consecutive refused (dead/partial) walks; drives the bounded self-retry.
  property int scanRefusals: 0

  // Identity (fdCacheKey) of the last COMPLETED live-fd walk plus its full
  // baseline; staged-text edits refilter it in memory. Key changes re-walk.
  property string lastFdKey: ""
  property var fdBaseRows: []
  // Warm-refilter memo { staged, matches, complete }: extensions rescore only
  // `matches`; complete=false past a cap hit. Nulled with fdBaseRows reassigns.
  property var fdWarmCache: null
  // Cap for full-baseline warm passes: big enough that ordinary match sets
  // stay complete (and thus narrowable) yet bounded for pathological queries.
  readonly property int fdWarmCacheCap: Math.max(root.cfg.maxDisplayRows, 2000)
  // Paths deleted this session; filtered out of every result producer so a
  // trashed file never resurfaces before the next index rescan.
  property var trashedPaths: ({})
  // One-shot startup probe; Delete-to-trash degrades to an honest hint when
  // trash-cli is absent instead of silently pretending the row was trashed.
  property bool trashAvailable: false
  property bool previewIsImage: false
  property string previewSource: ""
  property string previewMeta: ""
  property string previewContent: ""
  // Selected row's preview is known-broken (unreadable, over-ceiling,
  // undecodable): placeholder instead of stale pixels; reset per request.
  property bool previewUnavailable: false
  property bool helpVisible: false

  // path -> { meta, content }; oldest-first keys for LRU eviction.
  readonly property int previewCacheLimit: root.cfg.previewCacheLimit
  property var previewCache: ({})
  property var previewCacheKeys: []
  // mktemp template for per-job private scratch dirs; nothing here persists.
  readonly property string pdfPngBase: home + "/.local/state/omarchy/file-finder-pdf"
  // Persistent thumbnail store, <base>/{pdf,video}, keyed md5 of
  // path|size|mtime|inode so an edited source can never hit stale.
  readonly property string thumbStoreBase: (Quickshell.env("XDG_CACHE_HOME") || home + "/.cache") + "/thumbnails/" + pluginId
  // Self-contained data URLs so entries never go stale under us; the first
  // look of a session is served from thumbStoreBase instead of re-rendering.
  readonly property int pdfCacheLimit: root.cfg.pdfCacheLimit
  property var pdfCache: ({})
  property var pdfCacheKeys: []
  // path -> failed-at epoch ms; bounded LRU of recent render failures so a
  // pathological producer is not relaunched on every selection.
  readonly property int previewFailureTtlMs: Preview.previewFailureTtlMs
  property var previewFailCache: ({})
  property var previewFailKeys: []
  property string prewarmKey: ""

  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  property color selectedBackground: Color.menu.selectedBackground
  property color selectedText: Color.menu.selectedText
  readonly property int cornerRadius: Style.cornerRadius
  property string fontFamily: Style.font.menuFamily
  property int contentFontSize: root.cfg.contentFontSize
  property int contentMargin: Style.spacing.panelPadding
  property int headerHeight: Math.max(Style.space(34), root.contentFontSize + Style.spacing.controlPaddingY * 2)
  property int contentSpacing: Style.spacing.md
  property int cardWidth: Math.min(Style.space(875), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(550), panel.height - Style.gapsOut * 2)
  property int rowHeight: Math.max(Style.space(58), root.contentFontSize + root.cfg.contentCaption + Style.spacing.rowPaddingX * 2)

  readonly property string home: Quickshell.env("HOME")
  readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : "shafayet.finder"
  readonly property string stateBase: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy"
  readonly property string listPath: root.stateBase + "/file-finder-list.txt"
  // Empty-query browser directory (~/Downloads default).
  readonly property string browseDir: root.cfg.browseDir

  // This plugin's entry in shell.json plugins[].
  readonly property var pluginSettings: {
    var config = shell && shell.shellConfig ? shell.shellConfig : null
    var entries = config && Array.isArray(config.plugins) ? config.plugins : []
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry && String(entry.id || "") === pluginId) return entry
    }
    return {}
  }

  readonly property var cfg: Settings.resolveSettings(pluginSettings, home)

  onCfgChanged: {
    root.ensurePool()
    root.previewFailCache = {}
    root.previewFailKeys = []
  }

  function open(payloadJson) {
    root.opened = true
    root.filterText = ""
    root.selectedIndex = 0
    root.cursorActive = true
    root.disarmPointer()
    root.clearPreview()
    // Caches survive toggles for the session; thumbnails survive restarts on
    // disk, so even a session's first look skips pdftoppm/ffmpeg.
    root.rebuildDisplay(true)
    root.refreshScan()
    // External deletion of the index is invisible to FileView; searches pipe
    // fzf from this path, so verify it still exists each open.
    if (root.lastIndexFromDisk && !indexProbeProc.running) indexProbeProc.running = true
    searchDebounce.restart()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    // The scan keeps running on purpose — its result feeds the persisted index.
    root.opened = false
    root.helpVisible = false
    searchDebounce.stop()
    browseDebounce.stop()
    fdDebounce.stop()
    previewDebounce.stop()
    root.cancelPendingWork()
    root.clearPreview()
    root.searchResults = []
    root.lastFdKey = ""
    root.fdBaseRows = []
    root.fdWarmCache = null
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  // A Process ignores `running = true` until fully exited: mid-teardown work
  // parks in queuedStart and launches from onExited. Shared by search/fd/preview.
  function refreshScan() {
    // An in-flight scan lands on its own; restarting discards fresh work.
    if (scanProc.running || root.scanQueued) return
    if (root.lastScanFinishedAt
        && Date.now() - root.lastScanFinishedAt < root.cfg.rescanIntervalMs) return
    // Startup grace: serve the disk cache until one interval elapses
    // (rescan_interval_ms 0 never blocks) — an early open must not scan-and-
    // persist a truncated walk.
    if (root.lastIndexFromDisk && root.fileListCount > 0
        && Date.now() - root.startedAt < root.cfg.rescanIntervalMs) return
    root.scanSerial++
    scanProc.revision = root.scanSerial
    root.scanning = true
    root.scanQueued = true
    startScan()
  }

  function startScan() {
    if (!root.scanQueued) return
    root.scanQueued = false
    scanProc.command = Walks.scanCommand(root.cfg, root.stateBase)
    scanProc.running = true
  }

  function applyScan(raw, scanStderr) {
    var text = String(raw || "")
    // A partially dead walk (unmounted HDD shrinking the index to $HOME-only)
    // is never persisted — staying empty beats shipping wrong results.
    var ratio = String(scanStderr || "").match(new RegExp(Walks.scanRootsMarker + "(\\d+)/(\\d+)"))
    var partial = !!ratio && parseInt(ratio[1], 10) < parseInt(ratio[2], 10)
    if (!text || partial) {
      // Keep the "scanning…" indicator up across retries: with no usable
      // index, "scanning" is the honest state until a full walk lands.
      root.scanning = true
      // Deliberately no lastScanFinishedAt bump: the next open must be able
      // to rescan immediately instead of waiting out the success interval.
      root.scanRefusals++
      if (root.scanRefusals <= 24) {
        partialScanRetry.restart()
      } else {
        // Give up quietly: a permanently absent root must not spin forever.
        root.scanning = false
      }
      return
    }
    root.scanRefusals = 0
    partialScanRetry.stop()
    root.fileListCount = Core.countPaths(text)
    root.lastScanFinishedAt = Date.now()
    root.scanning = false
    // Rewriting megabytes of identical index every rescan is pure disk churn;
    // skip unless the on-disk copy is missing or actually differs.
    if (!root.lastIndexFromDisk || text !== root.lastIndexedText) {
      root.lastIndexedText = text
      listFile.setText(text)
    }
    if (root.opened && root.filterText.trim()) searchDebounce.restart()
  }

  // Cached index counted at startup so first searches need no rescan. The
  // text is remembered as the on-disk baseline for the write-skip above.
  function loadCachedList(raw) {
    var text = String(raw || "")
    root.fileListCount = Core.countPaths(text)
    root.lastIndexedText = text
  }

  // Cold-start prewarm stage 1: dispatch row 0's normal preview builder.
  function warmFirstRow(raw) {
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.length <= 1 || line.charAt(0) !== "/") continue
      var marked = line
      var isDir = Core.isDirPath(marked)
      var key = isDir ? Core.cleanPath(marked) : marked
      if (!key) return
      root.prewarmKey = key
      warmPreviewProc.command = isDir
        ? Preview.buildDirPreviewCommand(key, root.cfg.previewByteLimit, root.cfg.showHidden)
        : Preview.buildPreviewCommand(marked, root.cfg.previewByteLimit)
      warmPreviewProc.running = true
      return
    }
  }

  // Stage 2: identical meta wording to a live dispatch, so the cache entry is
  // indistinguishable.
  function storeWarmedPreview(raw) {
    var key = root.prewarmKey
    if (!key) return
    var parsed = Preview.parsePreviewOutput(String(raw || ""))
    if (parsed.size === -1) return
    // Oversize renders stay uncached so selecting the file later reports
    // "Thumbnail too large" instead of serving an empty warmed entry.
    if (parsed.size === -3) return
    var meta = parsed.size === -2 ? root.dirMeta(parsed.mtime) : Core.formatBytes(parsed.size)
    root.storePreviewInCache(key, meta, parsed.content)
  }

  // Directory caption wording shared by warmed and live previews.
  function dirMeta(countText) {
    var items = parseInt(countText, 10)
    return "Directory — " + (isNaN(items) ? "?" : items) + " items"
  }

  function startBrowse() {
    if (browseProc.running) {
      browseDebounce.restart()
      return
    }
    root.browseSerial++
    browseProc.revision = root.browseSerial
    browseProc.command = Walks.browseCommand(root.cfg)
    browseProc.running = true
  }

  function requestSearch() {
    if (!root.opened) return

    var query = root.filterText.trim()
    if (!query) {
      root.startBrowse()
      return
    }

    // Flag queries walk the roots live — the persisted index is irrelevant.
    var parsed = FdQuery.parseQuery(query)
    if (parsed.args.length > 0) {
      if (!parsed.fdPattern) {
        root.searchResults = []
        root.rebuildDisplay()
        return
      }
      // Same completed walk (e.g. a background rescan landed mid-query):
      // refilter the baseline instantly instead of killing and re-walking.
      var key = Search.fdCacheKey(root.cfg, parsed)
      if (key !== "" && key === root.lastFdKey) {
        refreshFlagDisplay()
        return
      }
      // Identical walk already queued or in flight: let it finish.
      if (fdProc.pendingKey === key && (fdProc.running || fdProc.queuedStart)) return
      root.searchSerial++
      root.fdSerial++
      fdProc.revision = root.fdSerial
      fdProc.queuedStart = true
      if (!fdProc.running) startFdSearch()
      else fdProc.running = false
      return
    }

    root.searchSerial++
    // The previous scan's list stays valid until the new one lands.
    if (root.fileListCount === 0) {
      root.searchResults = []
      root.rebuildDisplay()
      return
    }

    searchProc.queuedStart = true
    if (!searchProc.running) startSearch()
    else searchProc.running = false
  }

  // Revalidated at actual start time so superseded queries never launch stale.
  function startSearch() {
    if (!searchProc.queuedStart) return
    searchProc.queuedStart = false
    var query = root.filterText.trim()
    if (!query || !root.opened || FdQuery.parseQuery(query).args.length > 0 || root.fileListCount === 0) return
    searchProc.revision = root.searchSerial
    searchProc.command = Search.buildSearchCommand(root.listPath, query, root.cfg.maxDisplayRows)
    searchProc.running = true
  }

  function startFdSearch() {
    if (!fdProc.queuedStart) return
    fdProc.queuedStart = false
    var parsed = FdQuery.parseQuery(root.filterText.trim())
    if (!root.opened || parsed.args.length === 0 || !parsed.fdPattern) return
    // Only a finished run promotes pendingKey to lastFdKey, so typing during
    // the walk can never poison the warm path.
    fdProc.pendingKey = Search.fdCacheKey(root.cfg, parsed)
    fdProc.revision = root.fdSerial
    fdProc.command = Search.liveFdCommand(root.cfg, parsed, root.cfg.maxScanResults)
    fdProc.running = true
  }

  // immediatePreview: open() dispatches row 0 instantly instead of riding the
  // keystroke debounce; other callers keep coalescing.
  function rebuildDisplay(immediatePreview) {
    var rows = root.searchResults ? root.searchResults : []

    displayModel.clear()
    for (var i = 0; i < rows.length; i++) {
      var marked = rows[i]
      var isDir = Core.isDirPath(marked)
      var path = Core.cleanPath(marked)
      displayModel.append({
        path: marked,
        name: Core.fileName(path) + (isDir ? "/" : ""),
        dir: Core.dirName(path)
      })
    }

    if (displayModel.count === 0) {
      // Clear even when selectedIndex doesn't change (often already 0): its
      // signal would never fire.
      selectedIndex = 0
      root.clearPreview()
    }
    else if (selectedIndex >= displayModel.count) selectedIndex = displayModel.count - 1
    else if (selectedIndex < 0) selectedIndex = 0

    if (displayModel.count > 0) {
      if (immediatePreview) root.requestPreview()
      else previewDebounce.restart()
    }

    Qt.callLater(function() {
      if (displayModel.count > 0) resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    })
  }

  function select(delta) {
    if (displayModel.count === 0) return
    root.disarmPointer()
    if (!cursorActive) {
      cursorActive = true
      selectedIndex = delta < 0 ? displayModel.count - 1 : 0
    } else {
      selectedIndex = (selectedIndex + delta + displayModel.count) % displayModel.count
    }
    resultList.positionViewAtIndex(selectedIndex, ListView.Contain)
  }

  function selectAbsolute(index) {
    if (displayModel.count === 0) return
    root.disarmPointer()
    root.cursorActive = true
    root.selectedIndex = Math.max(0, Math.min(index, displayModel.count - 1))
    resultList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
  }

  function fdStagedText() {
    var p = FdQuery.parseQuery(root.filterText.trim())
    return (p.args.length > 0 && p.fdPattern) ? String(p.fzfQuery || "") : ""
  }

  // Warm path: same-key edits land here with zero latency. The generous cap
  // keeps finished passes `complete`; a display-sized one would flip complete
  // every step and force full-baseline rescans on the next keystroke.
  function refreshFlagDisplay() {
    var staged = fdStagedText()
    var cache = root.fdWarmCache
    var candidates = Fuzzy.warmCandidates(cache ? cache.matches : null,
      cache ? cache.staged : "", staged, cache ? cache.complete : false)
    if (!candidates) candidates = root.fdBaseRows
    var rows = Fuzzy.fuzzyFilterRows(candidates, staged, root.fdWarmCacheCap)
    // Uncapped-at-limit matches feed the next narrow keystroke; trashed rows
    // stay a display-only concern so the memo keeps describing the walk.
    var visible = []
    for (var i = 0; i < rows.length; i++) {
      if (!root.trashedPaths[rows[i]]) visible.push(rows[i])
    }
    root.fdWarmCache = { staged: staged, matches: rows, complete: rows.length < root.fdWarmCacheCap }
    root.searchResults = visible.slice(0, root.cfg.maxDisplayRows)
    root.rebuildDisplay()
  }

  function setFilter(nextFilter) {
    root.filterText = nextFilter
    root.selectedIndex = 0
    root.cursorActive = true
    root.disarmPointer()
    // Every keystroke makes in-flight search/browse/preview stale — kill now.
    root.cancelPendingWork()
    searchDebounce.stop()
    fdDebounce.stop()
    var parsed = FdQuery.parseQuery(nextFilter)
    if (parsed.args.length === 0 || !parsed.fdPattern) {
      root.lastFdKey = ""
      root.fdBaseRows = []
      root.fdWarmCache = null
    }
    if (parsed.args.length > 0) {
      if (!parsed.fdPattern) {
        root.searchResults = []
        root.rebuildDisplay()
        return
      }
      // Same walk as displayed: refilter the baseline in memory — instant in
      // both directions, no clearing.
      var key = Search.fdCacheKey(root.cfg, parsed)
      if (key !== "" && key === root.lastFdKey) {
        refreshFlagDisplay()
        return
      }
      fdDebounce.restart()
      return
    }
    searchDebounce.restart()
  }

  // Orphan serials so late output can never land, then SIGTERM to free CPU/disk.
  function cancelPendingWork() {
    root.searchSerial++
    searchProc.revision = root.searchSerial
    if (searchProc.running) searchProc.running = false
    else searchProc.queuedStart = false
    root.browseSerial++
    browseProc.revision = root.browseSerial
    // Stop unconditionally: an armed retry timer must not fire after the kill
    // and overwrite a live query's results with a stale browse listing.
    browseDebounce.stop()
    if (browseProc.running) browseProc.running = false
    root.fdSerial++
    fdProc.revision = root.fdSerial
    if (fdProc.running) fdProc.running = false
    else fdProc.queuedStart = false
    root.killPreviewWorkers()
  }

  // Shared tail for browse/search arrivals: absolute-path lines only, capped.
  function applyPathLines(raw) {
    var rows = []
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length && rows.length < root.cfg.maxDisplayRows; i++) {
      var line = lines[i]
      if (line.length > 1 && line.charAt(0) === "/" && !root.trashedPaths[line]) rows.push(line)
    }
    root.searchResults = rows
    // Browse fills happen on open/rescan, never per keystroke, so their row-0
    // preview skips the keystroke debounce.
    root.rebuildDisplay(root.filterText.trim() === "")
  }

  function killPreviewWorkers() {
    for (var i = 0; i < previewPool.length; i++) {
      var worker = previewPool[i]
      if (worker.running) {
        worker.cancelled = true
        worker.cooldown = true
        worker.running = false
      } else {
        // Parked job here can never be pumped (no pending onExited) — drop it.
        worker.queuedStart = false
      }
    }
  }

  function disarmPointer() {
    pointerGate.reset()
  }

  function selectFromPointer(index, item, mouse) {
    if (!pointerGate.moved(item, mouse)) return
    root.cursorActive = true
    root.selectedIndex = index
  }

  function activeRow(index) {
    if (index < 0 || index >= displayModel.count) return null
    return displayModel.get(index)
  }

  function activateIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached("xdg-open " + Util.shellQuote(Core.cleanPath(row.path)))
  }

  function copyIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached('printf "%s" ' + Util.shellQuote(Core.cleanPath(row.path)) + ' | wl-copy')
  }

  function revealIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached("nautilus --select " + Util.shellQuote(Core.cleanPath(row.path)))
  }

  function trashIndex(index) {
    var row = activeRow(index)
    if (!row) return
    if (!root.trashAvailable) {
      // Keep the row and selection intact; the hint clears on the next
      // selection change, when requestPreview/showCachedPreview reset meta.
      root.previewIsImage = false
      root.previewUnavailable = true
      root.previewMeta = "Cannot trash: trash-cli is not installed"
      root.previewContent = ""
      return
    }
    Util.execDetached("trash-put " + Util.shellQuote(Core.cleanPath(row.path)))
    root.trashedPaths[row.path] = true
    // Stay open: drop the trashed row and let the selection fall on the next
    // entry, so several files can be removed in one pass.
    var remaining = []
    var results = root.searchResults || []
    for (var i = 0; i < results.length; i++) {
      if (results[i] !== row.path) remaining.push(results[i])
    }
    root.searchResults = remaining
    root.rebuildDisplay(true)
  }

  function cachedPreview(path) {
    var hit = root.previewCache[path] || null
    if (hit) root.lruTouch(root.previewCacheKeys, path)
    return hit
  }

  function cachedPdf(path) {
    var hit = root.pdfCache[path] || null
    if (hit) root.lruTouch(root.pdfCacheKeys, path)
    return hit
  }

  // Moves a key to the tail on hit so eviction follows real recency.
  function lruTouch(keys, path) {
    var idx = keys.indexOf(path)
    if (idx < 0 || idx === keys.length - 1) return
    keys.splice(idx, 1)
    keys.push(path)
  }

  function storePreviewInCache(path, meta, content) {
    if (!path) return
    root.storeLru(root.previewCache, root.previewCacheKeys, root.previewCacheLimit, path,
      { meta: meta, content: content })
  }

  function storePdfInCache(path, url) {
    if (!path || !url) return
    root.storeLru(root.pdfCache, root.pdfCacheKeys, root.pdfCacheLimit, path, { url: url })
  }

  function markPreviewFailed(path) {
    if (!path) return
    root.storeLru(root.previewFailCache, root.previewFailKeys,
      Preview.previewFailureLimit, path, Date.now())
  }

  function recentlyFailedPreview(path) {
    var at = root.previewFailCache[path]
    if (!at || !Preview.isFailureFresh(at, Date.now(), root.previewFailureTtlMs)) return false
    root.lruTouch(root.previewFailKeys, path)
    return true
  }

  // Generic LRU insert: evict oldest keys beyond the cap, then store.
  function storeLru(cache, keys, limit, path, value) {
    if (!cache[path]) {
      keys.push(path)
      while (keys.length > limit) delete cache[keys.shift()]
    }
    cache[path] = value
  }

  function clearPreview() {
    root.previewIsImage = false
    root.previewSource = ""
    root.previewMeta = ""
    root.previewContent = ""
    root.previewUnavailable = false
  }

  function requestPreview() {
    var row = activeRow(root.selectedIndex)
    if (!row || !root.opened || displayModel.count === 0) {
      root.clearPreview()
      return
    }
    // Fresh attempt: the placeholder only comes back if this preview fails.
    root.previewUnavailable = false
    root.applyResolvedPreview(root.previewLookup(row.path), row.path)
  }

  // Shared decision tree for the selected row: resolved hit (image/thumb/text)
  // or pool dispatch (workerKind + cachePath + command). Order matters — a
  // directory named *.pdf must classify as a directory.
  function previewLookup(marked) {
    if (Core.isVideoPath(marked)) {
      var cleanVideo = Core.cleanPath(marked)
      var videoHit = root.cachedPdf(cleanVideo)
      if (videoHit) return { kind: "thumb", url: videoHit.url }
      if (root.recentlyFailedPreview(cleanVideo)) return { kind: "fail" }
      return { kind: "worker", workerKind: "video", cachePath: cleanVideo,
        command: Preview.buildVideoThumbnailCommand(cleanVideo, root.pdfPngBase,
          root.thumbStoreBase + "/video", root.cfg.thumbnailCacheLimit, root.cfg.pdfRenderScale) }
    }
    if (Core.isImagePath(marked)) {
      return { kind: "image", url: Util.fileUrl(marked) }
    }
    if (Core.isDirPath(marked)) {
      var cleanDir = Core.cleanPath(marked)
      var dirHit = root.cachedPreview(cleanDir)
      if (dirHit) return { kind: "text", isDir: true, meta: dirHit.meta, content: dirHit.content }
      if (root.recentlyFailedPreview(cleanDir)) return { kind: "fail" }
      return { kind: "worker", workerKind: "dir", cachePath: cleanDir,
        command: Preview.buildDirPreviewCommand(cleanDir, root.cfg.previewByteLimit, root.cfg.showHidden) }
    }
    if (Core.isPdfPath(marked)) {
      var cleanPdf = Core.cleanPath(marked)
      var pdfHit = root.cachedPdf(cleanPdf)
      if (pdfHit) return { kind: "thumb", url: pdfHit.url }
      if (root.recentlyFailedPreview(cleanPdf)) return { kind: "fail" }
      return { kind: "worker", workerKind: "pdf", cachePath: cleanPdf,
        command: Preview.buildPdfPreviewCommand(cleanPdf, root.pdfPngBase,
          root.thumbStoreBase + "/pdf", root.cfg.thumbnailCacheLimit, root.cfg.pdfRenderScale) }
    }
    var fileHit = root.cachedPreview(marked)
    if (fileHit) return { kind: "text", isDir: false, meta: fileHit.meta, content: fileHit.content }
    if (root.recentlyFailedPreview(marked)) return { kind: "fail" }
    return { kind: "worker", workerKind: "file", cachePath: marked,
      command: Preview.buildPreviewCommand(marked, root.cfg.previewByteLimit) }
  }

  // Paints a resolved preview, else hands it to the worker pool.
  function applyResolvedPreview(p, displayKey) {
    if (p.kind === "image" || p.kind === "thumb") {
      root.previewIsImage = true
      root.previewSource = p.url
      root.previewMeta = ""
      root.previewContent = ""
    } else if (p.kind === "text") {
      root.previewIsImage = false
      root.previewMeta = p.meta
      root.previewContent = p.content
      // Empty directories preview fine; contentless files placeholder.
      root.previewUnavailable = !p.isDir && p.content === ""
    } else if (p.kind === "fail") {
      root.previewIsImage = false
      root.previewMeta = ""
      root.previewContent = ""
      root.previewUnavailable = true
    } else {
      // Video/pdf renders keep the previous pane visible while working,
      // exactly like the original inline branches did.
      if (p.workerKind === "dir" || p.workerKind === "file") root.previewIsImage = false
      root.dispatchPreview(p.workerKind, p.cachePath, displayKey, p.command)
    }
    root.prefetchNeighbors()
  }

  Component.onCompleted: {
    ensurePool()
    chmodIndexProc.running = true
    // No startup scan here: listFile's load handlers pick between an
    // immediate first-run walk and the deferred startupScanTimer refresh.
    trashProbeProc.running = true
    warmRowProc.command = ["bash", "-c",
      "( " + Walks.browseCommand(root.cfg)[2] + " ) 2>/dev/null | head -n 4"]
    warmRowProc.running = true
  }

  ListModel { id: displayModel }

  property var searchResults: null

  PointerMoveGate {
    id: pointerGate
    referenceItem: card
  }

  FileView {
    id: listFile
    path: root.listPath
    atomicWrites: true
    printErrors: false
    onSaved: chmodIndexProc.running = true
    onLoaded: {
      root.lastIndexFromDisk = true
      root.loadCachedList(text())
      // A usable cached index is displayed as-is and refreshed only after
      // one full rescan interval; an empty file still needs a walk now.
      if (root.fileListCount > 0) startupScanTimer.restart()
      else root.refreshScan()
    }
    onLoadFailed: {
      root.lastIndexFromDisk = false
      root.loadCachedList("")
      root.refreshScan()
    }
  }

  Process {
    id: indexProbeProc
    command: ["bash", "-c", "[ -f " + Core.shellQuote(root.listPath) + " ]"]
    onExited: {
      if (exitCode === 0 || !root.lastIndexFromDisk) return
      // Deleted mid-session: restore the in-memory copy for fzf; the flag
      // drop makes applyScan's next write unconditional.
      root.lastIndexFromDisk = false
      if (root.lastIndexedText) listFile.setText(root.lastIndexedText)
    }
  }

  Process {
    id: chmodIndexProc
    command: ["chmod", "600", root.listPath]
  }

  Process {
    id: trashProbeProc
    command: ["bash", "-c", "command -v trash-put >/dev/null 2>&1"]
    onExited: root.trashAvailable = exitCode === 0
  }

  Process {
    id: warmRowProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.warmFirstRow(text)
    }
  }

  Process {
    id: warmPreviewProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.storeWarmedPreview(text)
    }
  }

  Process {
    id: scanProc
    property int revision: 0
    // Both collectors settle before exit; reading them there keeps the roots
    // ratio and the walk's stdout from racing each other.
    onExited: {
      if (revision === root.scanSerial) root.applyScan(stdout.text, stderr.text)
      root.startScan()
    }
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }

  Timer {
    id: searchDebounce
    interval: root.cfg.debounceMs
    onTriggered: root.requestSearch()
  }

  // Flag walks hit real directory trees: slower debounce than plain fzf.
  Timer {
    id: fdDebounce
    interval: root.cfg.fdDebounceMs
    onTriggered: root.requestSearch()
  }

  Timer {
    id: browseDebounce
    interval: root.cfg.debounceMs
    onTriggered: root.startBrowse()
  }

  // Heals boot-time mount races: refused walks retry every 10s for ~4 min,
  // then yield to the open-triggered cadence so a dead root cannot hot-loop.
  Timer {
    id: partialScanRetry
    interval: 10000
    onTriggered: root.refreshScan()
  }

  // First rescan of a session, armed only for a non-empty loaded index: the
  // cache serves until this fires (see refreshScan's startup gate).
  Timer {
    id: startupScanTimer
    interval: root.cfg.rescanIntervalMs
    onTriggered: root.refreshScan()
  }

  Process {
    id: browseProc
    property int revision: 0
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (browseProc.revision !== root.browseSerial) return
        root.applyPathLines(text)
      }
    }
  }

  Process {
    id: searchProc
    property int revision: -1
    property bool queuedStart: false
    onExited: root.startSearch()
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (searchProc.revision !== root.searchSerial) return
        root.applyPathLines(text)
      }
    }
  }

  Process {
    id: fdProc
    property int revision: -1
    property bool queuedStart: false
    property string pendingKey: ""
    onExited: root.startFdSearch()
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (fdProc.revision !== root.fdSerial) return
        // Baseline = every walk line; what's displayed filters it client-side.
        var rows = []
        var lines = String(text).split("\n")
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].length > 1 && lines[i].charAt(0) === "/") rows.push(lines[i])
        }
        root.lastFdKey = fdProc.pendingKey
        root.fdBaseRows = rows
        // Fresh walk, fresh memo: stale matches describe the old baseline.
        root.fdWarmCache = null
        root.refreshFlagDisplay()
      }
    }
  }

  Timer {
    id: previewDebounce
    interval: root.cfg.debounceMs
    onTriggered: root.requestPreview()
  }

  // Concurrent pool: slow renders never block text previews; results keyed by
  // path and gated on the row still selected, so kills can never mispaint.
  Component {
    id: previewWorkerComp

    Process {
      id: worker
      property string kind: "file"
      property string currentPath: ""
      property string displayKey: ""
      // Killed mid-run: truncated output must never populate the cache.
      property bool cancelled: false
      property bool queuedStart: false
      // Must stay a var: an argv array coerced through a string-typed
      // property would become one mangled token no binary matches.
      property var jobCommand: null
      property bool cooldown: false
      onExited: {
        worker.cooldown = false
        root.pumpPreviewWorker(worker)
      }
      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: root.finishPreview(worker, text)
      }
    }
  }

  property var previewPool: []

  function ensurePool() {
    var size = Math.max(1, root.cfg.previewWorkers)
    // Shrink only idle workers; busy ones linger until a later call retires
    // them, so a hot-reloaded preview_workers never kills in-flight renders.
    for (var i = previewPool.length - 1; i >= size; i--) {
      var surplus = previewPool[i]
      if (surplus.running || surplus.queuedStart || surplus.cooldown) continue
      previewPool.splice(i, 1)
      surplus.destroy()
    }
    while (previewPool.length < size) {
      previewPool.push(previewWorkerComp.createObject(root))
    }
  }

  function idlePreviewWorker() {
    for (var i = 0; i < previewPool.length; i++) {
      var worker = previewPool[i]
      if (!worker.running && !worker.queuedStart && !worker.cooldown) return worker
    }
    return null
  }

  function dispatchPreview(kind, cachePath, forKey, command) {
    var worker = root.idlePreviewWorker()
    if (!worker) {
      // Retry shortly rather than queueing possibly-stale work.
      previewDebounce.restart()
      return
    }
    worker.kind = kind
    worker.currentPath = cachePath
    worker.displayKey = forKey
    worker.cancelled = false
    worker.jobCommand = command
    worker.queuedStart = true
    root.pumpPreviewWorker(worker)
  }

  function pumpPreviewWorker(worker) {
    if (!worker.queuedStart || worker.running || worker.cooldown) return
    worker.queuedStart = false
    if (!root.opened || worker.cancelled) return
    worker.command = worker.jobCommand
    worker.running = true
  }

  // Spare workers warm adjacent rows ahead of time. Images need no process;
  // PDF/video renders cost more than background churn is worth.
  function prefetchNeighbors() {
    for (var d = -1; d <= 1; d += 2) {
      var idx = root.selectedIndex + d
      if (idx < 0 || idx >= displayModel.count) continue
      var row = activeRow(idx)
      if (!row) continue
      var marked = row.path
      if (Core.isVideoPath(marked) || Core.isImagePath(marked) || Core.isPdfPath(marked)) continue
      var isDir = Core.isDirPath(marked)
      var cachePath = isDir ? Core.cleanPath(marked) : marked
      if (root.cachedPreview(cachePath)) continue
      var command = isDir
        ? Preview.buildDirPreviewCommand(cachePath, root.cfg.previewByteLimit, root.cfg.showHidden)
        : Preview.buildPreviewCommand(marked, root.cfg.previewByteLimit)
      dispatchPreview("file", cachePath, "", command)
      if (!root.idlePreviewWorker()) return
    }
  }

  function finishPreview(worker, rawOutput) {
    if (!root.opened || worker.cancelled) return
    var parsed = Preview.parsePreviewOutput(rawOutput)
    // No header at all means the producer itself died (killed worker,
    // vanished target): indistinguishable from an unreadable file.
    var deadProducer = parsed.size === 0 && parsed.mtime === "" && parsed.content === ""
    var selectedRow = activeRow(root.selectedIndex)
    var isSelected = selectedRow !== null && worker.displayKey !== "" && worker.displayKey === selectedRow.path

    if (worker.kind === "pdf" || worker.kind === "video") {
      if (parsed.size === -1 || deadProducer) {
        root.markPreviewFailed(worker.currentPath)
        if (isSelected) {
          root.previewIsImage = false
          root.previewUnavailable = true
          root.previewMeta = "Unreadable file"
          root.previewContent = ""
        }
        return
      }
      // Left uncached so lowering pdf_render_scale succeeds next time.
      var url = Preview.pdfDataUrl(parsed.content)
      if (parsed.size === -3 || url === "") {
        root.markPreviewFailed(worker.currentPath)
        if (isSelected) {
          root.previewIsImage = false
          root.previewUnavailable = true
          root.previewMeta = "Thumbnail too large"
          root.previewContent = ""
        }
        return
      }
      root.storePdfInCache(worker.currentPath, url)
      if (isSelected) {
        root.previewIsImage = true
        root.previewSource = url
        root.previewMeta = ""
        root.previewContent = ""
      }
      return
    }

    if (parsed.size === -2) {
      var caption = root.dirMeta(parsed.mtime)
      root.storePreviewInCache(worker.currentPath, caption, parsed.content)
      if (isSelected) {
        root.previewMeta = caption
        root.previewContent = parsed.content
      }
      return
    }
    if (parsed.size === -1 || deadProducer) {
      // Uncached so a reappearance gets a fresh attempt; the failure memo
      // bounds how often that attempt can burn a render.
      root.markPreviewFailed(worker.currentPath)
      if (isSelected) {
        root.previewUnavailable = true
        root.previewMeta = "Unreadable file"
        root.previewContent = ""
      }
      return
    }
    var meta
    var content
    if (parsed.content.indexOf("\u0000") >= 0) {
      meta = Core.formatBytes(parsed.size) + " — binary file"
      content = ""
    } else {
      meta = Core.formatBytes(parsed.size)
      if (parsed.mtime) meta += "  ·  " + parsed.mtime
      content = parsed.content
    }
    root.storePreviewInCache(worker.currentPath, meta, content)
    if (isSelected) {
      root.previewMeta = meta
      root.previewContent = content
      // Binary and zero-byte files have nothing renderable: keep their size
      // caption but surface the placeholder instead of a blank pane.
      root.previewUnavailable = content === ""
    }
  }

  // Zero-spawn fast path mirroring requestPreview's cached branches; returns
  // false when a worker is needed, letting the caller fall back to debounce.
  function showCachedPreview() {
    if (!root.opened || displayModel.count === 0) {
      root.clearPreview()
      return true
    }
    var row = activeRow(root.selectedIndex)
    if (!row) return false
    root.previewUnavailable = false
    var p = root.previewLookup(row.path)
    if (p.kind === "worker") {
      if (p.workerKind === "dir" || p.workerKind === "file") root.previewIsImage = false
      return false
    }
    root.applyResolvedPreview(p, row.path)
    return true
  }

  onSelectedIndexChanged: {
    root.killPreviewWorkers()
    if (!root.showCachedPreview()) previewDebounce.restart()
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "shafayet-finder"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.close()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      height: root.cardHeight
      radius: root.cornerRadius
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      padding: root.contentMargin

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          if ((event.key === Qt.Key_Slash || event.key === Qt.Key_Question)
              && (event.modifiers & Qt.ControlModifier) && (event.modifiers & Qt.ShiftModifier)) {
            root.helpVisible = !root.helpVisible
            event.accepted = true
          } else if (root.helpVisible) {
            // Modal owns input: Escape dismisses, everything else is swallowed.
            if (event.key === Qt.Key_Escape) root.helpVisible = false
            event.accepted = true
          } else if (event.key === Qt.Key_Escape) {
            if (root.filterText) root.setFilter("")
            else root.close()
            event.accepted = true
          } else if (event.key === Qt.Key_Backspace && (event.modifiers & Qt.ControlModifier)) {
            // Must run before Util.editsFilter or plain backspace eats Ctrl.
            root.setFilter(Core.deleteLastWord(root.filterText))
            event.accepted = true
          } else if (Util.editsFilter(event, root.filterText)) {
            root.setFilter(Util.editedFilter(event, root.filterText))
            event.accepted = true
          } else if (event.key === Qt.Key_Up) {
            root.select(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_Down) {
            root.select(1)
            event.accepted = true
          } else if ((event.key === Qt.Key_J) && (event.modifiers & Qt.ControlModifier)) {
            root.select(1)
            event.accepted = true
          } else if ((event.key === Qt.Key_K) && (event.modifiers & Qt.ControlModifier)) {
            root.select(-1)
            event.accepted = true
          } else if (event.key === Qt.Key_PageUp) {
            root.select(-6)
            event.accepted = true
          } else if (event.key === Qt.Key_PageDown) {
            root.select(6)
            event.accepted = true
          } else if (event.key === Qt.Key_Home) {
            root.selectAbsolute(0)
            event.accepted = true
          } else if (event.key === Qt.Key_End) {
            root.selectAbsolute(displayModel.count - 1)
            event.accepted = true
          } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            if (event.modifiers & Qt.ShiftModifier) root.copyIndex(root.selectedIndex)
            else if (event.modifiers & Qt.AltModifier) root.revealIndex(root.selectedIndex)
            else if (root.cursorActive) root.activateIndex(root.selectedIndex)
            else if (displayModel.count > 0) root.cursorActive = true
            event.accepted = true
          } else if (event.key === Qt.Key_Delete || (event.key === Qt.Key_D && (event.modifiers & Qt.ControlModifier))) {
            root.trashIndex(root.selectedIndex)
            event.accepted = true
          } else if (event.text && event.text.length === 1 && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127) {
            root.setFilter(root.filterText + event.text)
            event.accepted = true
          }
        }
      }

      Column {
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: root.contentSpacing

        FinderHeader {
          filterText: root.filterText
          scanning: root.scanning
          entryCount: root.fileListCount
          fontFamily: root.fontFamily
          headingSize: root.cfg.contentHeading
          captionSize: root.cfg.contentCaption
          contentSize: root.contentFontSize
          width: parent.width
          height: root.headerHeight
        }

        Item {
          width: parent.width
          height: parent.height - root.headerHeight - root.contentSpacing

          Row {
            anchors.fill: parent
            spacing: 0

            Item {
              width: parent.width / 2
              height: parent.height
              clip: true

              ListView {
                id: resultList
                anchors.fill: parent
                anchors.rightMargin: root.contentMargin
                model: displayModel
                clip: true
                spacing: Style.space(4)
                boundsBehavior: Flickable.StopAtBounds

                delegate: ResultRow {
                  hasCursor: root.cursorActive && index === root.selectedIndex
                  home: root.home
                  fontFamily: root.fontFamily
                  nameSize: root.contentFontSize
                  captionSize: root.cfg.contentCaption
                  rowHeight: root.rowHeight

                  onHoverMoved: function(idx, item, mouse) {
                    root.selectFromPointer(idx, item, mouse)
                  }
                  onActivated: function(idx) {
                    root.cursorActive = true
                    root.selectedIndex = idx
                    root.activateIndex(idx)
                  }
                }
              }
            }

            Item {
              width: parent.width / 2
              height: parent.height

              PreviewPane {
                anchors.fill: parent
                isImage: root.previewIsImage
                source: root.previewSource
                meta: root.previewMeta
                content: root.previewContent
                unavailable: root.previewUnavailable
                fontFamily: root.fontFamily
                captionSize: root.cfg.contentCaption
                contentSize: root.contentFontSize
                displayLargeSize: root.cfg.contentDisplayLarge
                leftPad: root.contentMargin
                onImageFailed: root.previewUnavailable = true
              }
            }
          }

          EmptyState {
            visible: displayModel.count === 0
            anchors.centerIn: parent
            scanning: root.scanning
            entryCount: root.fileListCount
            filterText: root.filterText
            locationLabel: Core.shortenPath(root.browseDir, root.home)
            fontFamily: root.fontFamily
            contentSize: root.contentFontSize
            displayLargeSize: root.cfg.contentDisplayLarge
          }
        }
      }

      ShortcutHelp {
        visible: root.helpVisible
        anchors.fill: parent
        fontFamily: root.fontFamily
        captionSize: root.cfg.contentCaption
        headingSize: root.cfg.contentHeading
        onCloseRequested: root.helpVisible = false
      }
    }
  }
}
