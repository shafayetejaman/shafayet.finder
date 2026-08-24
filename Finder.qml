import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import QtQuick
import qs.Commons
import qs.Ui
import "FinderModel.js" as FinderModel

Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
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

  // Identity (fdCacheKey) of the last COMPLETED live-fd walk plus its full
  // baseline; staged-text edits refilter it in memory. Key changes re-walk.
  property string lastFdKey: ""
  property var fdBaseRows: []
  property bool previewIsImage: false
  property string previewSource: ""
  property string previewMeta: ""
  property string previewContent: ""

  // path -> { meta, content }; oldest-first keys for LRU eviction.
  readonly property int previewCacheLimit: root.cfg.previewCacheLimit
  property var previewCache: ({})
  property var previewCacheKeys: []
  // mktemp template for per-job private scratch dirs; nothing here persists.
  readonly property string pdfPngBase: home + "/.local/state/omarchy/file-finder-pdf"
  // Persistent thumbnail store, keyed md5("<path>|<size>|<mtime>") so an
  // edited source can never hit stale. Plugin subdir avoids freedesktop-spec
  // directories other apps own and garbage-collect.
  readonly property string thumbStoreBase: (Quickshell.env("XDG_CACHE_HOME") || home + "/.cache") + "/thumbnails/" + pluginId
  // Self-contained data URLs so entries never go stale under us; the first
  // look of a session is served from thumbStoreBase instead of re-rendering.
  readonly property int pdfCacheLimit: root.cfg.pdfCacheLimit
  property var pdfCache: ({})
  property var pdfCacheKeys: []
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
  readonly property string stateBase: home + "/.local/state/omarchy"
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

  readonly property var cfg: FinderModel.resolveSettings(pluginSettings, home)

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
    searchDebounce.restart()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    // The scan keeps running on purpose — its result feeds the persisted index.
    root.opened = false
    searchDebounce.stop()
    browseDebounce.stop()
    fdDebounce.stop()
    previewDebounce.stop()
    root.cancelPendingWork()
    root.clearPreview()
    root.searchResults = []
    root.lastFdKey = ""
    root.fdBaseRows = []
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  // A Process ignores `running = true` until it fully exits, so work requested
  // mid-teardown parks in queuedStart and launches from onExited instead of
  // being silently dropped. Shared by searchProc/fdProc/preview workers.
  function refreshScan() {
    // An in-flight scan lands on its own; restarting discards fresh work.
    if (scanProc.running || root.scanQueued) return
    if (root.lastScanFinishedAt
        && Date.now() - root.lastScanFinishedAt < root.cfg.rescanIntervalMs) return
    root.scanSerial++
    scanProc.revision = root.scanSerial
    root.scanning = true
    root.scanQueued = true
    startScan()
  }

  function startScan() {
    if (!root.scanQueued) return
    root.scanQueued = false
    scanProc.command = FinderModel.scanCommand(root.cfg, root.stateBase)
    scanProc.running = true
  }

  function applyScan(raw) {
    var text = String(raw || "")
    root.fileListCount = FinderModel.markDirectories(text).length
    root.lastScanFinishedAt = Date.now()
    root.scanning = false
    listFile.setText(text)
    if (root.opened && root.filterText.trim()) searchDebounce.restart()
  }

  // Cached index counted at startup so first searches need no rescan.
  function loadCachedList(raw) {
    root.fileListCount = FinderModel.markDirectories(String(raw || "")).length
  }

  // Cold-start prewarm stage 1: dispatch row 0's normal preview builder.
  function warmFirstRow(raw) {
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.length <= 1 || line.charAt(0) !== "/") continue
      var marked = line
      var isDir = FinderModel.isDirPath(marked)
      var key = isDir ? FinderModel.cleanPath(marked) : marked
      if (!key) return
      root.prewarmKey = key
      warmPreviewProc.command = isDir
        ? FinderModel.buildDirPreviewCommand(key, root.cfg.previewByteLimit, root.cfg.showHidden)
        : FinderModel.buildPreviewCommand(marked, root.cfg.previewByteLimit)
      warmPreviewProc.running = true
      return
    }
  }

  // Stage 2: identical meta wording to a live dispatch, so the cache entry is
  // indistinguishable.
  function storeWarmedPreview(raw) {
    var key = root.prewarmKey
    if (!key) return
    var parsed = FinderModel.parsePreviewOutput(String(raw || ""))
    if (parsed.size === -1) return
    var meta
    if (parsed.size === -2) {
      var items = parseInt(parsed.mtime, 10)
      meta = "Directory — " + (isNaN(items) ? "?" : items) + " items"
    } else {
      meta = FinderModel.formatBytes(parsed.size)
    }
    root.storePreviewInCache(key, meta, parsed.content)
  }

  function startBrowse() {
    if (browseProc.running) {
      browseDebounce.restart()
      return
    }
    root.browseSerial++
    browseProc.revision = root.browseSerial
    browseProc.command = FinderModel.browseCommand(root.cfg)
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
    var parsed = FinderModel.parseQuery(query)
    if (parsed.args.length > 0) {
      if (!parsed.fdPattern) {
        root.searchResults = []
        root.rebuildDisplay()
        return
      }
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
    if (!query || !root.opened || FinderModel.parseQuery(query).args.length > 0 || root.fileListCount === 0) return
    searchProc.revision = root.searchSerial
    searchProc.command = FinderModel.buildSearchCommand(root.listPath, query, root.cfg.maxDisplayRows)
    searchProc.running = true
  }

  function startFdSearch() {
    if (!fdProc.queuedStart) return
    fdProc.queuedStart = false
    var parsed = FinderModel.parseQuery(root.filterText.trim())
    if (!root.opened || parsed.args.length === 0 || !parsed.fdPattern) return
    // Only a finished run promotes pendingKey to lastFdKey, so typing during
    // the walk can never poison the warm path.
    fdProc.pendingKey = FinderModel.fdCacheKey(root.cfg, parsed)
    fdProc.revision = root.fdSerial
    fdProc.command = FinderModel.liveFdCommand(root.cfg, parsed, root.cfg.maxScanResults)
    fdProc.running = true
  }

  // immediatePreview: open() dispatches row 0 instantly instead of riding the
  // keystroke debounce; other callers keep coalescing.
  function rebuildDisplay(immediatePreview) {
    var rows = root.searchResults ? root.searchResults : []

    displayModel.clear()
    for (var i = 0; i < rows.length; i++) {
      var marked = rows[i]
      var isDir = FinderModel.isDirPath(marked)
      var path = FinderModel.cleanPath(marked)
      displayModel.append({
        path: marked,
        name: FinderModel.fileName(path) + (isDir ? "/" : ""),
        dir: FinderModel.dirName(path)
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
    var p = FinderModel.parseQuery(root.filterText.trim())
    return (p.args.length > 0 && p.fdPattern) ? String(p.fzfQuery || "") : ""
  }

  // Warm path: same-key edits land here with zero latency, never clearing rows.
  function refreshFlagDisplay() {
    root.searchResults = FinderModel.fuzzyFilterRows(root.fdBaseRows, fdStagedText())
      .slice(0, root.cfg.maxDisplayRows)
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
    var parsed = FinderModel.parseQuery(nextFilter)
    if (parsed.args.length === 0 || !parsed.fdPattern) {
      root.lastFdKey = ""
      root.fdBaseRows = []
    }
    if (parsed.args.length > 0) {
      if (!parsed.fdPattern) {
        root.searchResults = []
        root.rebuildDisplay()
        return
      }
      // Same walk as displayed: refilter the baseline in memory — instant in
      // both directions, no clearing.
      var key = FinderModel.fdCacheKey(root.cfg, parsed)
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
    if (browseProc.running) browseProc.running = false
    else browseDebounce.stop()
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
      if (line.length > 1 && line.charAt(0) === "/") rows.push(line)
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
    Util.execDetached("xdg-open " + Util.shellQuote(FinderModel.cleanPath(row.path)))
  }

  function copyIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached('printf "%s" ' + Util.shellQuote(FinderModel.cleanPath(row.path)) + ' | wl-copy')
  }

  function revealIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached("nautilus --select " + Util.shellQuote(FinderModel.cleanPath(row.path)))
  }

  function trashIndex(index) {
    var row = activeRow(index)
    if (!row) return
    root.close()
    Util.execDetached("trash-put " + Util.shellQuote(FinderModel.cleanPath(row.path)))
  }

  function cachedPreview(path) {
    var hit = root.previewCache[path] || null
    if (hit) root.touchPreviewCache(path)
    return hit
  }

  // Moves a key to the tail on hit so eviction follows real recency.
  function touchPreviewCache(path) {
    var keys = root.previewCacheKeys
    var idx = keys.indexOf(path)
    if (idx < 0 || idx === keys.length - 1) return
    keys.splice(idx, 1)
    keys.push(path)
  }

  function storePreviewInCache(path, meta, content) {
    if (!path) return
    var cache = root.previewCache
    if (!cache[path]) {
      var keys = root.previewCacheKeys.slice()
      keys.push(path)
      while (keys.length > root.previewCacheLimit) delete cache[keys.shift()]
      root.previewCacheKeys = keys
    }
    cache[path] = { meta: meta, content: content }
  }

  function cachedPdf(path) {
    var hit = root.pdfCache[path] || null
    if (hit) root.touchPdfCache(path)
    return hit
  }

  function touchPdfCache(path) {
    var keys = root.pdfCacheKeys
    var idx = keys.indexOf(path)
    if (idx < 0 || idx === keys.length - 1) return
    keys.splice(idx, 1)
    keys.push(path)
  }

  function storePdfInCache(path, url) {
    if (!path || !url) return
    var cache = root.pdfCache
    if (!cache[path]) {
      var keys = root.pdfCacheKeys.slice()
      keys.push(path)
      while (keys.length > root.pdfCacheLimit) delete cache[keys.shift()]
      root.pdfCacheKeys = keys
    }
    cache[path] = { url: url }
  }

  function clearPreview() {
    root.previewIsImage = false
    root.previewSource = ""
    root.previewMeta = ""
    root.previewContent = ""
  }

  function requestPreview() {
    var row = activeRow(root.selectedIndex)
    if (!row || !root.opened || displayModel.count === 0) {
      root.clearPreview()
      return
    }

    var marked = row.path

    if (FinderModel.isVideoPath(marked)) {
      var cleanVideo = FinderModel.cleanPath(marked)
      var videoHit = root.cachedPdf(cleanVideo)
      if (videoHit) {
        root.previewIsImage = true
        root.previewSource = videoHit.url
        root.previewMeta = ""
        root.previewContent = ""
        root.prefetchNeighbors()
        return
      }
      root.dispatchPreview("video", cleanVideo, marked, FinderModel.buildVideoThumbnailCommand(cleanVideo, root.pdfPngBase, root.thumbStoreBase, root.cfg.thumbnailCacheLimit, root.cfg.pdfRenderScale))
      return
    }

    if (FinderModel.isImagePath(marked)) {
      root.previewIsImage = true
      root.previewSource = Util.fileUrl(marked)
      root.previewMeta = ""
      root.previewContent = ""
      root.prefetchNeighbors()
      return
    }
    root.previewIsImage = false

    if (FinderModel.isDirPath(marked)) {
      var cleanDir = FinderModel.cleanPath(marked)
      var dirHit = root.cachedPreview(cleanDir)
      if (dirHit) {
        root.previewMeta = dirHit.meta
        root.previewContent = dirHit.content
        root.prefetchNeighbors()
        return
      }
      root.dispatchPreview("dir", cleanDir, marked, FinderModel.buildDirPreviewCommand(cleanDir, root.cfg.previewByteLimit, root.cfg.showHidden))
      root.prefetchNeighbors()
      return
    }

    if (FinderModel.isPdfPath(marked)) {
      var cleanPdf = FinderModel.cleanPath(marked)
      var pdfHit = root.cachedPdf(cleanPdf)
      if (pdfHit) {
        root.previewIsImage = true
        root.previewSource = pdfHit.url
        root.previewMeta = ""
        root.previewContent = ""
        return
      }
      root.dispatchPreview("pdf", cleanPdf, marked, FinderModel.buildPdfPreviewCommand(cleanPdf, root.pdfPngBase, root.thumbStoreBase, root.cfg.thumbnailCacheLimit, root.cfg.pdfRenderScale))
      return
    }

    var fileHit = root.cachedPreview(marked)
    if (fileHit) {
      root.previewMeta = fileHit.meta
      root.previewContent = fileHit.content
      root.prefetchNeighbors()
      return
    }
    root.dispatchPreview("file", marked, marked, FinderModel.buildPreviewCommand(marked, root.cfg.previewByteLimit))
    root.prefetchNeighbors()
  }

  Component.onCompleted: {
    ensurePool()
    // Scan folds its state-dir mkdir, so no dedicated startup process is needed.
    root.refreshScan()
    warmRowProc.command = ["bash", "-c",
      "( " + FinderModel.browseCommand(root.cfg)[2] + " ) 2>/dev/null | head -n 4"]
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
    onLoaded: root.loadCachedList(text())
    onLoadFailed: root.loadCachedList("")
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
    onExited: root.startScan()
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (scanProc.revision === root.scanSerial) root.applyScan(text)
      }
    }
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
        root.refreshFlagDisplay()
      }
    }
  }

  Timer {
    id: previewDebounce
    interval: root.cfg.debounceMs
    onTriggered: root.requestPreview()
  }

  // Concurrent pool so a slow PDF render never blocks text previews. Results
  // are keyed by path and display requires the row still selected, so a killed
  // worker's partial output can never mispaint.
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
    if (previewPool.length > 0) return
    var size = Math.max(1, root.cfg.previewWorkers)
    for (var i = 0; i < size; i++) {
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
      if (FinderModel.isVideoPath(marked) || FinderModel.isImagePath(marked) || FinderModel.isPdfPath(marked)) continue
      var isDir = FinderModel.isDirPath(marked)
      var cachePath = isDir ? FinderModel.cleanPath(marked) : marked
      if (root.cachedPreview(cachePath)) continue
      var command = isDir
        ? FinderModel.buildDirPreviewCommand(cachePath, root.cfg.previewByteLimit, root.cfg.showHidden)
        : FinderModel.buildPreviewCommand(marked, root.cfg.previewByteLimit)
      dispatchPreview("file", cachePath, "", command)
      if (!root.idlePreviewWorker()) return
    }
  }

  function finishPreview(worker, rawOutput) {
    if (!root.opened || worker.cancelled) return
    var parsed = FinderModel.parsePreviewOutput(rawOutput)
    var selectedRow = activeRow(root.selectedIndex)
    var isSelected = selectedRow !== null && worker.displayKey !== "" && worker.displayKey === selectedRow.path

    if (worker.kind === "pdf" || worker.kind === "video") {
      if (parsed.size === -1) {
        if (isSelected) {
          root.previewIsImage = false
          root.previewMeta = "Unreadable file"
          root.previewContent = ""
        }
        return
      }
      // Left uncached so lowering pdf_render_scale succeeds next time.
      var url = FinderModel.pdfDataUrl(parsed.content)
      if (parsed.size === -3 || url === "") {
        if (isSelected) {
          root.previewIsImage = false
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
      var items = parseInt(parsed.mtime, 10)
      var dirMeta = "Directory — " + (isNaN(items) ? "?" : items) + " items"
      root.storePreviewInCache(worker.currentPath, dirMeta, parsed.content)
      if (isSelected) {
        root.previewMeta = dirMeta
        root.previewContent = parsed.content
      }
      return
    }
    if (parsed.size === -1) {
      // Uncached so a reappearance gets a fresh attempt.
      if (isSelected) {
        root.previewMeta = "Unreadable file"
        root.previewContent = ""
      }
      return
    }
    var meta
    var content
    if (parsed.content.indexOf("\u0000") >= 0) {
      meta = FinderModel.formatBytes(parsed.size) + " — binary file"
      content = ""
    } else {
      meta = FinderModel.formatBytes(parsed.size)
      if (parsed.mtime) meta += "  ·  " + parsed.mtime
      content = parsed.content
    }
    root.storePreviewInCache(worker.currentPath, meta, content)
    if (isSelected) {
      root.previewMeta = meta
      root.previewContent = content
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
    var marked = row.path

    if (FinderModel.isVideoPath(marked)) {
      var videoHit = root.cachedPdf(FinderModel.cleanPath(marked))
      if (videoHit) {
        root.previewIsImage = true
        root.previewSource = videoHit.url
        root.previewMeta = ""
        root.previewContent = ""
        root.prefetchNeighbors()
        return true
      }
      return false
    }
    if (FinderModel.isImagePath(marked)) {
      root.previewIsImage = true
      root.previewSource = Util.fileUrl(marked)
      root.previewMeta = ""
      root.previewContent = ""
      root.prefetchNeighbors()
      return true
    }
    root.previewIsImage = false

    var hit = null
    var isDir = FinderModel.isDirPath(marked)
    if (isDir) {
      hit = root.cachedPreview(FinderModel.cleanPath(marked))
    } else if (FinderModel.isPdfPath(marked)) {
      var pdfHit = root.cachedPdf(FinderModel.cleanPath(marked))
      if (pdfHit) {
        root.previewIsImage = true
        root.previewSource = pdfHit.url
        root.previewMeta = ""
        root.previewContent = ""
        return true
      }
      return false
    } else {
      hit = root.cachedPreview(marked)
    }
    if (!hit) return false
    root.previewMeta = hit.meta
    root.previewContent = hit.content
    root.prefetchNeighbors()
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
          if (event.key === Qt.Key_Escape) {
            if (root.filterText) root.setFilter("")
            else root.close()
            event.accepted = true
          } else if (event.key === Qt.Key_Backspace && (event.modifiers & Qt.ControlModifier)) {
            // Must run before Util.editsFilter or plain backspace eats Ctrl.
            root.setFilter(FinderModel.deleteLastWord(root.filterText))
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

        Rectangle {
          width: parent.width
          height: root.headerHeight
          radius: root.cornerRadius
          color: "transparent"

          Text {
            anchors.left: parent.left
            anchors.right: statusLabel.visible ? statusLabel.left : parent.right
            anchors.rightMargin: statusLabel.visible ? Style.space(12) : 0
            anchors.verticalCenter: parent.verticalCenter
            text: root.filterText || "Search files…"
            color: root.foreground
            opacity: root.filterText ? 1 : 0.58
            font.family: root.fontFamily
            font.pixelSize: root.cfg.contentHeading
            elide: Text.ElideRight
          }

          Text {
            id: statusLabel
            visible: !root.filterText && (root.scanning || root.fileListCount > 0)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.scanning ? "scanning…" : root.fileListCount.toLocaleString() + " entries"
            color: root.foreground
            opacity: 0.5
            font.family: root.fontFamily
            font.pixelSize: root.cfg.contentCaption
          }
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

                delegate: Rectangle {
                  id: row
                  required property int index
                  required property string path
                  required property string name
                  required property string dir

                  readonly property bool hasCursor: root.cursorActive && index === root.selectedIndex

                  width: ListView.view.width
                  height: root.rowHeight
                  radius: root.cornerRadius
                  color: hasCursor ? root.selectedBackground : "transparent"

                  Column {
                    anchors.fill: parent
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    anchors.topMargin: Style.space(8)
                    anchors.bottomMargin: Style.space(8)
                    spacing: 0

                    Text {
                      width: parent.width
                      text: parent.parent.name
                      color: parent.parent.hasCursor ? root.selectedText : root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: root.contentFontSize
                      elide: Text.ElideRight
                    }

                    Text {
                      width: parent.width
                      text: FinderModel.shortenPath(parent.parent.dir, root.home)
                      color: parent.parent.hasCursor ? root.selectedText : root.foreground
                      opacity: 0.55
                      font.family: root.fontFamily
font.pixelSize: root.cfg.contentCaption
                      elide: Text.ElideMiddle
                    }
                  }

                  MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onPositionChanged: function(mouse) {
                      root.selectFromPointer(row.index, row, mouse)
                    }
                    onClicked: {
                      root.cursorActive = true
                      root.selectedIndex = row.index
                      root.activateIndex(row.index)
                    }
                  }
                }
              }
            }

            Item {
              width: parent.width / 2
              height: parent.height
              clip: true

              Rectangle {
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: Style.normalBorderWidth
                color: Util.alpha(root.border, 0.28)
              }

              Text {
                id: previewMetaLabel
                visible: root.previewMeta.length > 0
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.leftMargin: root.contentMargin
                anchors.topMargin: 0
                text: root.previewMeta
                color: root.foreground
                opacity: 0.55
                font.family: root.fontFamily
                font.pixelSize: root.cfg.contentCaption
                elide: Text.ElideRight
              }

              Text {
                visible: !root.previewIsImage
                anchors.top: parent.top
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                anchors.right: parent.right
                anchors.leftMargin: root.contentMargin
                anchors.topMargin: root.previewMeta.length > 0 ? Style.space(22) : 0
                text: root.previewContent
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: root.contentFontSize
                wrapMode: Text.WrapAnywhere
                elide: Text.ElideRight
                verticalAlignment: Text.AlignTop
              }

              Image {
                visible: root.previewIsImage
                anchors.fill: parent
                anchors.leftMargin: root.contentMargin
                anchors.topMargin: 0
                source: root.previewSource
                fillMode: Image.PreserveAspectFit
                verticalAlignment: Image.AlignTop
                asynchronous: true
                smooth: true
              }
            }
          }

          Column {
            anchors.centerIn: parent
            spacing: Style.space(8)
            visible: displayModel.count === 0

            Text {
              text: "󰍉"
              color: root.selectedText
              opacity: 0.8
              font.family: root.fontFamily
              font.pixelSize: root.cfg.contentDisplayLarge
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              text: root.scanning && root.fileListCount === 0
                ? "Scanning files…"
                : (!root.filterText.trim() ? FinderModel.shortenPath(root.browseDir, root.home) + " is empty" : "No matches for “" + root.filterText + "”")
              color: root.foreground
              opacity: 0.7
              font.family: root.fontFamily
              font.pixelSize: root.contentFontSize
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }
          }
        }
      }
    }
  }
}
