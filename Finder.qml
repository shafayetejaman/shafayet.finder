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
  property bool previewIsImage: false
  property bool previewIsVideo: false
  property string previewSource: ""
  property string previewMeta: ""
  property string previewContent: ""

  // path → { meta, content }, oldest-first key list for eviction. Read and
  // written imperatively only, so no binding ever depends on it.
  readonly property int previewCacheLimit: root.cfg.previewCacheLimit
  property var previewCache: ({})
  property var previewCacheKeys: []
  // Scratch base for pdftoppm runs: each job appends its own "-<pid>.png"
  // suffix and removes the file afterwards, so concurrent or killed renders
  // can never overwrite each other and nothing persists on disk.
  readonly property string pdfPngBase: home + "/.local/state/omarchy/file-finder-pdf"
  // path → { url }, url being a self-contained data:image/png;base64 payload
  // held in memory. Storing bytes instead of pointing at a shared render file
  // means an entry can never go stale under us — switching PDFs overwrites
  // nothing, so arrowing between documents always shows each one's own page.
  readonly property int pdfCacheLimit: root.cfg.pdfCacheLimit
  property var pdfCache: ({})
  property var pdfCacheKeys: []

  // Shares the [menu] surface tokens — themes that style the menu also
  // style the finder, matching the clipboard overlay's approach.
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
  readonly property string listPath: home + "/.local/state/omarchy/file-finder-list.txt"
  // Shown instead of nothing while the query is empty, so opening the finder
  // doubles as a browser of a configurable directory (~/Downloads default).
  readonly property string browseDir: root.cfg.browseDir

  // Settings come from this plugin's entry in shell.json plugins[]. Every
  // tunable is merged over static defaults by resolveSettings, so the finder
  // works untouched and each value stays individually overridable, e.g.
  // { "id": "shafayet.finder", "search_dirs": ["$HOME"], "ignored_dirs": ["$HOME/.cache"] }
  readonly property var pluginSettings: {
    var config = shell && shell.shellConfig ? shell.shellConfig : null
    var entries = config && Array.isArray(config.plugins) ? config.plugins : []
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry && String(entry.id || "") === pluginId) return entry
    }
    return {}
  }

  // Single source for every knob: search dirs, ignores, limits, pool size,
  // debounce, PDF scale. See FinderModel.resolveSettings for the defaults.
  readonly property var cfg: FinderModel.resolveSettings(pluginSettings, home)

  function open(payloadJson) {
    root.opened = true
    root.filterText = ""
    root.selectedIndex = 0
    root.cursorActive = true
    root.disarmPointer()
    root.clearPreview()
    // The preview caches persist across toggles for the whole shell session,
    // so revisiting a file re-shows its preview instantly — PDF thumbnails
    // included, since their entries are self-contained data URLs.
    root.rebuildDisplay()
    root.refreshScan()
    searchDebounce.restart()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    // Blank immediately, cancel anything queued, and stop every process this
    // session made stale: a pending debounce must not repaint the pane after
    // the overlay is gone. The scan is left running on purpose — its result
    // feeds the persistent list cache that makes the next open instant.
    root.opened = false
    searchDebounce.stop()
    browseDebounce.stop()
    fdDebounce.stop()
    previewDebounce.stop()
    root.cancelPendingWork()
    root.clearPreview()
    // Last session's rows must not flash under the empty filter on reopen.
    // The PDF cache stays too: its entries are self-contained data URLs that
    // reference no disk state, so they cannot go stale across sessions.
    root.searchResults = []
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  // Termination is asynchronous: a Process ignores `running = true` until it
  // fully exits, so a fresh run requested mid-teardown queues itself and
  // starts from onExited instead of being silently dropped.
  function refreshScan() {
    // A scan already in flight (or queued behind a teardown) will land on
    // its own — restarting it would only discard nearly-fresh work.
    if (scanProc.running || root.scanQueued) return
    if (root.lastScanFinishedAt
        && Date.now() - root.lastScanFinishedAt < root.cfg.rescanIntervalMs) {
      // The index was rebuilt moments ago — skip the churn and keep serving
      // the existing list; the next open past the interval rescans.
      return
    }
    root.scanSerial++
    scanProc.revision = root.scanSerial
    root.scanning = true
    root.scanQueued = true
    startScan()
  }

  function startScan() {
    if (!root.scanQueued) return
    root.scanQueued = false
    scanProc.command = FinderModel.scanCommand(root.cfg)
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

  // Called at shell start when the persisted list loads: the cached index is
  // counted into memory immediately so the finder opens searchable without
  // waiting for the first rescan. A refresh landing later simply overwrites
  // this via applyScan.
  function loadCachedList(raw) {
    root.fileListCount = FinderModel.markDirectories(String(raw || "")).length
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

    // Inline fd flags route to a live walk over the roots themselves — the
    // persisted index is irrelevant there. A flags-only query (no pattern)
    // runs nothing and clears instantly.
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
    // Searching is allowed even while a rescan is in flight: the persisted
    // list from the previous scan stays valid until the new one lands.
    if (root.fileListCount === 0) {
      root.searchResults = []
      root.rebuildDisplay()
      return
    }

    searchProc.queuedStart = true
    if (!searchProc.running) startSearch()
    else searchProc.running = false
  }

  // Revalidates at actual start time: whatever the filter is THEN is what
  // runs, so a query superseded during teardown never launches stale.
  function startSearch() {
    if (!searchProc.queuedStart) return
    searchProc.queuedStart = false
    var query = root.filterText.trim()
    if (!query || !root.opened || FinderModel.parseQuery(query).args.length > 0 || root.fileListCount === 0) return
    searchProc.revision = root.searchSerial
    searchProc.command = FinderModel.buildSearchCommand(root.listPath, query, root.cfg.maxDisplayRows)
    searchProc.running = true
  }

  // Same teardown-safe queueing as startSearch, but re-parses so a parked
  // job only launches when its input still carries fd flags with a pattern.
  function startFdSearch() {
    if (!fdProc.queuedStart) return
    fdProc.queuedStart = false
    var parsed = FinderModel.parseQuery(root.filterText.trim())
    if (!root.opened || parsed.args.length === 0 || !parsed.fdPattern) return
    fdProc.revision = root.fdSerial
    fdProc.command = FinderModel.liveFdCommand(root.cfg, parsed, root.cfg.maxDisplayRows)
    fdProc.running = true
  }

  function rebuildDisplay() {
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

    if (displayModel.count === 0) selectedIndex = 0
    else if (selectedIndex >= displayModel.count) selectedIndex = displayModel.count - 1
    else if (selectedIndex < 0) selectedIndex = 0

    // A fresh result set keeps the selection index unchanged, so the index
    // change signal alone would never preview the first row.
    if (displayModel.count > 0) previewDebounce.restart()

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

  function setFilter(nextFilter) {
    root.filterText = nextFilter
    root.selectedIndex = 0
    root.cursorActive = true
    root.disarmPointer()
    // Every keystroke makes every in-flight search/browse/preview stale:
    // stop them now instead of letting them run to an invisible finish.
    root.cancelPendingWork()
    searchDebounce.stop()
    fdDebounce.stop()
    var parsed = FinderModel.parseQuery(nextFilter)
    if (parsed.args.length > 0) {
      if (!parsed.fdPattern) {
        // Flags-only: nothing to run, clear immediately for feedback.
        root.searchResults = []
        root.rebuildDisplay()
        return
      }
      // Flag mode walks real trees: a slower debounce keeps the churn down.
      fdDebounce.restart()
      return
    }
    searchDebounce.restart()
  }

  // Orphans the serials of anything in flight so late output can never land,
  // then SIGTERMs the processes themselves to free CPU and disk at once.
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

  // Shared tail for every result producer: absolute-path lines only, capped,
  // straight into the display. Directories keep their trailing "/" marker.
  function applyPathLines(raw) {
    var rows = []
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length && rows.length < root.cfg.maxDisplayRows; i++) {
      var line = lines[i]
      if (line.length > 1 && line.charAt(0) === "/") rows.push(line)
    }
    root.searchResults = rows
    root.rebuildDisplay()
  }

  function killPreviewWorkers() {
    for (var i = 0; i < previewPool.length; i++) {
      var worker = previewPool[i]
      if (worker.running) {
        worker.cancelled = true
        worker.cooldown = true
        worker.running = false
      } else {
        // Not running: a parked job here can never be pumped (no pending
        // onExited), so drop it instead of leaking a phantom-busy slot.
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

  // Moves the selected row to the freedesktop trash via trash-cli so it can
  // be restored; closes first, mirroring open/copy/reveal.
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

  // Moves a key to the tail on hit so eviction follows real recency (LRU).
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

  // Moves a key to the tail on hit so eviction follows real recency (LRU).
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
    root.previewIsVideo = false
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
      root.previewIsImage = false
      root.previewIsVideo = true
      root.previewSource = ""
      root.previewMeta = ""
      root.previewContent = ""
      return
    }
    root.previewIsVideo = false

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
      // PDF renders are heavy; not prefetched, so no neighbor pass here.
      root.dispatchPreview("pdf", cleanPdf, marked, FinderModel.buildPdfPreviewCommand(cleanPdf, root.pdfPngBase, root.cfg.pdfRenderScale))
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
    mkdirProc.running = true
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
    id: mkdirProc
    command: ["bash", "-c", "mkdir -p \"$HOME/.local/state/omarchy\""]
    onExited: root.refreshScan()
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

  // Flag mode walks real directory trees, so it debounces slower than the
  // plain fzf path — every keystroke still kills the previous run eagerly.
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

  // Live fd-flag search: same queue-on-teardown lifecycle as searchProc,
  // but the walk runs against the roots themselves instead of the index.
  Process {
    id: fdProc
    property int revision: -1
    property bool queuedStart: false
    onExited: root.startFdSearch()
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (fdProc.revision !== root.fdSerial) return
        root.applyPathLines(text)
      }
    }
  }

  Timer {
    id: previewDebounce
    interval: root.cfg.debounceMs
    onTriggered: root.requestPreview()
  }

  // Preview workers run concurrently so a slow PDF render never serializes
  // behind directory listings or text heads, and prefetched neighbors land
  // while the selected row is still being read. Results are keyed by path,
  // so a killed stale worker's partial output can only ever populate the
  // cache for its own file — display updates additionally require the
  // worker's row to still be selected. Dispatches queue through onExited
  // (like searchProc) so a job aimed at a mid-teardown worker is never
  // silently dropped.
  Component {
    id: previewWorkerComp

    Process {
      id: worker
      property string kind: "file"
      property string currentPath: ""
      property string displayKey: ""
      // Set when the worker is killed mid-run so its truncated output can
      // never populate the cache.
      property bool cancelled: false
      // A Process ignores `running = true` until it fully exits, so a fresh
      // job requested mid-teardown parks here and starts from onExited.
      property bool queuedStart: false
      // Must stay a var: the command is an argv array, and a string-typed
      // property would coerce it into one mangled token no binary matches.
      property var jobCommand: null
      // True from kill until the process has fully exited; idle selection
      // skips cooled-down workers so a start can never land mid-teardown.
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

  // Idle = fully exited, not holding a queued job, and not cooling down.
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
      // All slots busy: retry shortly rather than queueing work that may be
      // stale by the time a slot frees up.
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

  // Starts a queued job on a fully-exited worker. Jobs parked while the
  // worker was mid-teardown are pumped from onExited instead of being
  // silently dropped.
  function pumpPreviewWorker(worker) {
    if (!worker.queuedStart || worker.running || worker.cooldown) return
    worker.queuedStart = false
    if (!root.opened || worker.cancelled) return
    worker.command = worker.jobCommand
    worker.running = true
  }

  // Renders adjacent rows' previews into the cache ahead of time using spare
  // workers, so arrowing through results feels instantaneous. Videos, images
  // and PDFs are excluded — they need no process, decode off-thread already,
  // or cost more than background churn is worth.
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

    if (worker.kind === "pdf") {
      if (parsed.size === -1) {
        if (isSelected) {
          root.previewIsImage = false
          root.previewMeta = "Unreadable file"
          root.previewContent = ""
        }
        return
      }
      var url = FinderModel.pdfDataUrl(parsed.content)
      root.storePdfInCache(worker.currentPath, url)
      if (isSelected) {
        // No meta line for PDFs: the page thumbnail owns the whole pane.
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
      // Uncached so a file that reappears gets a fresh attempt.
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

  // Tries to render the selected row without spawning anything: images and
  // videos are direct sources, and dir/file/PDF previews may already sit in
  // the LRU (prefetched neighbors, revisits). Returns false when a worker
  // would be needed, letting the caller fall back to the debounce. Mirrors
  // the instant branches of requestPreview().
  function showCachedPreview() {
    if (!root.opened || displayModel.count === 0) {
      root.clearPreview()
      return true
    }
    var row = activeRow(root.selectedIndex)
    if (!row) return false
    var marked = row.path

    if (FinderModel.isVideoPath(marked)) {
      root.previewIsImage = false
      root.previewIsVideo = true
      root.previewSource = ""
      root.previewMeta = ""
      root.previewContent = ""
      root.prefetchNeighbors()
      return true
    }
    if (FinderModel.isImagePath(marked)) {
      root.previewIsImage = true
      root.previewIsVideo = false
      root.previewSource = Util.fileUrl(marked)
      root.previewMeta = ""
      root.previewContent = ""
      root.prefetchNeighbors()
      return true
    }
    root.previewIsVideo = false
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
            // Intercepted ahead of Util.editsFilter so the shell's plain
            // backspace handling never eats the modifier variant.
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
                visible: !root.previewIsImage && !root.previewIsVideo
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

              Column {
                visible: root.previewIsVideo
                anchors.centerIn: parent
                spacing: Style.space(8)

                Text {
                  text: ""
                  color: root.selectedText
                  opacity: 0.6
                  font.family: root.fontFamily
                  font.pixelSize: root.cfg.contentDisplayLarge * 2
                  horizontalAlignment: Text.AlignHCenter
                  width: parent.width
                }

                Text {
                  text: "No video preview"
                  color: root.foreground
                  opacity: 0.55
                  font.family: root.fontFamily
                  font.pixelSize: root.cfg.contentCaption
                  horizontalAlignment: Text.AlignHCenter
                  width: parent.width
                }
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
