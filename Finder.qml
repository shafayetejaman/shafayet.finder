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
  property int previewSerial: 0
  property bool previewIsImage: false
  property bool previewIsVideo: false
  property string previewSource: ""
  property string previewMeta: ""
  property string previewContent: ""

  // path → { meta, content }, oldest-first key list for eviction. Read and
  // written imperatively only, so no binding ever depends on it.
  readonly property int previewCacheLimit: 500
  property var previewCache: ({})
  property var previewCacheKeys: []
  // Rendered first pages live at a fixed path; pdfCache remembers which
  // document each render belongs to so revisits skip pdftoppm entirely.
  readonly property string pdfPngBase: home + "/.local/state/omarchy/file-finder-pdf"
  readonly property string pdfPngPath: pdfPngBase + ".png"
  property var pdfCache: ({})
  // Qt's image cache keys on the URL, and every render lands on the same
  // file — without a version bump a second PDF would keep showing the first.
  property int pdfRenderVersion: 0

  function pdfSourceUrl(version) {
    return Util.fileUrl(root.pdfPngPath) + "?v=" + version
  }

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
  property int contentFontSize: Style.font.title
  property int contentMargin: Style.spacing.panelPadding
  property int headerHeight: Math.max(Style.space(34), Style.font.title + Style.spacing.controlPaddingY * 2)
  property int contentSpacing: Style.spacing.md
  property int cardWidth: Math.min(Style.space(875), panel.width - Style.gapsOut * 2)
  property int cardHeight: Math.min(Style.space(550), panel.height - Style.gapsOut * 2)
  property int rowHeight: Math.max(Style.space(58), root.contentFontSize + Style.font.caption + Style.spacing.rowPaddingX * 2)

  readonly property string home: Quickshell.env("HOME")
  readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : "shafayet.finder"
  readonly property string listPath: home + "/.local/state/omarchy/file-finder-list.txt"
  // Shown instead of nothing while the query is empty, so opening the finder
  // doubles as a browser of recent downloads.
  readonly property string browseDir: home + "/Downloads"

  // Settings come from this plugin's entry in shell.json plugins[], e.g.
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
  readonly property var searchDirs: FinderModel.searchDirs(pluginSettings, home)
  readonly property var ignorePatterns: FinderModel.ignorePatterns(pluginSettings, home)

  function open(payloadJson) {
    root.opened = true
    root.filterText = ""
    root.selectedIndex = 0
    root.cursorActive = true
    root.disarmPointer()
    root.clearPreview()
    // Fresh previews each session so long-lived entries never go stale.
    root.previewCache = ({})
    root.previewCacheKeys = []
    root.pdfCache = ({})
    root.rebuildDisplay()
    root.refreshScan()
    searchDebounce.restart()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open("{}")
  }

  function refreshScan() {
    root.scanSerial++
    scanProc.revision = root.scanSerial
    scanProc.command = FinderModel.buildScanCommand(root.searchDirs, root.ignorePatterns)
    scanProc.running = true
    root.scanning = true
  }

  function applyScan(raw) {
    var count = 0
    var lines = String(raw || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) count++
    }

    root.fileListCount = count
    root.scanning = false
    listFile.setText(String(raw || ""))
    if (root.opened && root.filterText.trim()) searchDebounce.restart()
  }

  function startBrowse() {
    if (browseProc.running) {
      browseDebounce.restart()
      return
    }
    root.browseSerial++
    browseProc.revision = root.browseSerial
    browseProc.command = FinderModel.buildBrowseCommand(root.browseDir)
    browseProc.running = true
  }

  function requestSearch() {
    if (!root.opened) return

    root.searchSerial++
    var query = root.filterText.trim()
    if (!query) {
      root.startBrowse()
      return
    }
    if (root.fileListCount === 0 || scanProc.running) {
      root.searchResults = []
      root.rebuildDisplay()
      return
    }

    searchProc.revision = root.searchSerial
    searchProc.command = FinderModel.buildSearchCommand(root.listPath, query)
    searchProc.running = true
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
    searchDebounce.restart()
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

  function cachedPreview(path) {
    return root.previewCache[path] || null
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
    root.previewIsVideo = false

    if (FinderModel.isDirPath(marked)) {
      root.previewIsImage = false
      var cleanDir = FinderModel.cleanPath(marked)
      var dirHit = root.cachedPreview(cleanDir)
      if (dirHit) {
        root.previewMeta = dirHit.meta
        root.previewContent = dirHit.content
        return
      }
      if (previewProc.running) {
        // Invalidate the in-flight run so it can never land for this
        // selection, then retry once it exits.
        root.previewSerial++
        previewDebounce.restart()
        return
      }
      root.previewSerial++
      previewProc.revision = root.previewSerial
      previewProc.currentPath = cleanDir
      previewProc.command = FinderModel.buildDirPreviewCommand(cleanDir)
      previewProc.running = true
      return
    }

    if (FinderModel.isPdfPath(marked)) {
      var cleanPdf = FinderModel.cleanPath(marked)
      var pdfHit = root.pdfCache[cleanPdf]
      if (pdfHit) {
        root.previewIsImage = true
        root.previewSource = root.pdfSourceUrl(pdfHit.ver)
        root.previewMeta = pdfHit.meta
        root.previewContent = ""
        return
      }
      if (previewProc.running) {
        // Invalidate the in-flight render so its result can never land for
        // this (different) selection, then retry once it exits.
        root.previewSerial++
        previewDebounce.restart()
        return
      }
      root.previewSerial++
      previewProc.kind = "pdf"
      previewProc.revision = root.previewSerial
      previewProc.currentPath = cleanPdf
      previewProc.command = FinderModel.buildPdfPreviewCommand(cleanPdf, root.pdfPngBase)
      previewProc.running = true
      return
    }

    if (FinderModel.isVideoPath(marked)) {
      root.previewIsImage = false
      root.previewIsVideo = true
      root.previewSource = ""
      root.previewMeta = ""
      root.previewContent = ""
      return
    }

    if (FinderModel.isImagePath(marked)) {
      root.previewSerial++
      root.previewIsImage = true
      root.previewSource = Util.fileUrl(marked)
      root.previewMeta = ""
      root.previewContent = ""
      return
    }

    root.previewIsImage = false
    var fileHit = root.cachedPreview(marked)
    if (fileHit) {
      root.previewMeta = fileHit.meta
      root.previewContent = fileHit.content
      return
    }
    if (previewProc.running) {
      // A Process ignores a command change while running: invalidate whatever
      // is in flight so its result cannot land for this selection, then retry.
      root.previewSerial++
      previewDebounce.restart()
      return
    }
    root.previewSerial++
    previewProc.revision = root.previewSerial
    previewProc.kind = "file"
    previewProc.currentPath = marked
    previewProc.command = FinderModel.buildPreviewCommand(marked)
    previewProc.running = true
  }

  Component.onCompleted: mkdirProc.running = true

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
  }

  Process {
    id: mkdirProc
    command: ["bash", "-c", "mkdir -p \"$HOME/.local/state/omarchy\""]
    onExited: root.refreshScan()
  }

  Process {
    id: scanProc
    property int revision: 0
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (scanProc.revision === root.scanSerial) root.applyScan(text)
      }
    }
  }

  Timer {
    id: searchDebounce
    interval: 120
    onTriggered: root.requestSearch()
  }

  Timer {
    id: browseDebounce
    interval: 120
    onTriggered: root.startBrowse()
  }

  Process {
    id: browseProc
    property int revision: 0
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (browseProc.revision !== root.browseSerial) return
        var rows = []
        var lines = String(text || "").split("\n")
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          if (line.length > 4 && line.indexOf("/") === 0) rows.push(line)
        }
        root.searchResults = rows
        root.rebuildDisplay()
      }
    }
  }

  Process {
    id: searchProc
    property int revision: -1
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (searchProc.revision !== root.searchSerial) return
        var rows = []
        var lines = String(text || "").split("\n")
        for (var i = 0; i < lines.length && rows.length < FinderModel.maxDisplayRows; i++) {
          var line = lines[i]
          if (line.length > 4 && line.indexOf("/") === 0) rows.push(line)
        }
        root.searchResults = rows
        root.rebuildDisplay()
      }
    }
  }

  Timer {
    id: previewDebounce
    interval: 120
    onTriggered: root.requestPreview()
  }

  Process {
    id: previewProc
    property int revision: 0
    property string currentPath: ""
    property string kind: "file"
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (previewProc.revision !== root.previewSerial) return
        var parsed = FinderModel.parsePreviewOutput(text)
        if (previewProc.kind === "pdf") {
          if (parsed.size === -1) {
            root.previewIsImage = false
            root.previewMeta = "Unreadable file"
            root.previewContent = ""
            return
          }
          var label = "PDF"
          var pages = parseInt(parsed.mtime, 10)
          if (!isNaN(pages) && pages > 0) label += " · " + pages + (pages === 1 ? " page" : " pages")
          if (parsed.size > 0) label += " · " + FinderModel.formatBytes(parsed.size)
          root.pdfRenderVersion++
          root.previewIsImage = true
          root.previewSource = root.pdfSourceUrl(root.pdfRenderVersion)
          root.previewMeta = label
          root.previewContent = ""
          root.pdfCache[previewProc.currentPath] = { meta: label, ver: root.pdfRenderVersion }
          return
        }
        if (parsed.size === -2) {
          var items = parseInt(parsed.mtime, 10)
          root.previewMeta = "Directory — " + (isNaN(items) ? "?" : items) + " items"
          root.previewContent = parsed.content
          root.storePreviewInCache(previewProc.currentPath, root.previewMeta, root.previewContent)
          return
        }
        if (parsed.size === -1) {
          // Uncached so a file that reappears gets a fresh attempt.
          root.previewMeta = "Unreadable file"
          root.previewContent = ""
          return
        }
        if (parsed.content.indexOf("\u0000") >= 0) {
          root.previewMeta = FinderModel.formatBytes(parsed.size) + " — binary file"
          root.previewContent = ""
          root.storePreviewInCache(previewProc.currentPath, root.previewMeta, root.previewContent)
          return
        }
        var meta = FinderModel.formatBytes(parsed.size)
        if (parsed.mtime) meta += "  ·  " + parsed.mtime
        root.previewMeta = meta
        root.previewContent = parsed.content
        root.storePreviewInCache(previewProc.currentPath, root.previewMeta, root.previewContent)
      }
    }
  }

  onSelectedIndexChanged: previewDebounce.restart()

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
            font.pixelSize: Style.font.heading
            elide: Text.ElideRight
          }

          Text {
            id: statusLabel
            visible: !root.filterText && (root.scanning || root.fileListCount > 0)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.scanning ? "scanning…" : root.fileListCount.toLocaleString() + " files"
            color: root.foreground
            opacity: 0.5
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
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
                      font.pixelSize: Style.font.caption
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
                font.pixelSize: Style.font.caption
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
                  font.pixelSize: Style.font.displayLarge * 2
                  horizontalAlignment: Text.AlignHCenter
                  width: parent.width
                }

                Text {
                  text: "No video preview"
                  color: root.foreground
                  opacity: 0.55
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
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
              font.pixelSize: Style.font.displayLarge
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Text {
              text: root.scanning && root.fileListCount === 0
                ? "Scanning files…"
                : (!root.filterText.trim() ? "~/Downloads is empty" : "No matches for “" + root.filterText + "”")
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
