// Preview producers: file/dir text dumps, PDF page renders, video frame
// grabs, their shared disk-backed thumbnail store, and the failure memo
// constants consumed by the QML worker pool.

.import "Core.js" as Core
.import "Walks.js" as Walks

var pdfRenderScale = 1200
// Hard cap for one pdftoppm/ffmpeg render; a hung producer must surface as an
// honest -1 failure instead of an eternal blank pane.
var renderTimeoutSecs = 45
// Producers refuse PNGs above this; bounds the stdout collector and the
// resident memory of cached data URLs (base64 inflates bytes ~4/3).
var thumbPngByteCeiling = 3 * 1024 * 1024
// Failed previews are remembered this long so a pathological video/PDF cannot
// re-trigger a full-length render on every selection; expiry lets a changed
// file retry honestly.
var previewFailureTtlMs = 300000
var previewFailureLimit = 32

// Wire: "\t<size>\t<mtime>\n" followed by content. Size -1 marks an
// unreadable or vanished file without a second round trip.
function buildPreviewCommand(path, byteLimit) {
  if (byteLimit === undefined) byteLimit = 65536
  var quoted = Core.shellQuote(path)
  return [
    "bash", "-c",
    "if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
    + " mt=$(stat -Lc %y -- " + quoted + " 2>/dev/null | cut -d. -f1);"
    + ' printf "\\t%s\\t%s\\n" "${sz:-?}" "$mt";'
    + " head -c " + byteLimit + " -- " + quoted + " 2>/dev/null;"
    + " else printf '\\t-1\\t\\n'; fi"
  ]
}

// Wire: "\t-2\t<entry-count>\n" followed by a one-level listing where nested
// directories keep their trailing slash. Dot entries hidden unless showHidden.
function buildDirPreviewCommand(path, byteLimit, showHidden) {
  if (byteLimit === undefined) byteLimit = 65536
  var quoted = Core.shellQuote(path)
  var ls = "ls -1Ap --color=never -- " + quoted + " 2>/dev/null"
  if (!showHidden) ls += " | grep -v '^\\.'"
  return [
    "bash", "-c",
    "{ [ -d " + quoted + " ] || exit 0 ; } ;"
    + ' cnt=$(ls -1A -- ' + quoted + ' 2>/dev/null' + (showHidden ? "" : " | grep -v '^\\.'") + ' | wc -l);'
    + ' printf "\\t-2\\t%s\\n" "$cnt";'
    + " " + ls + " | head -c " + byteLimit
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

// True when a recorded failure still blocks re-dispatch: valid timestamp and
// not yet expired. Garbage entries (0/NaN) never block.
function isFailureFresh(recordedAt, now, ttl) {
  var t = Number(recordedAt)
  var age = now - t
  return isFinite(t) && t > 0 && isFinite(age) && age >= 0 && age < ttl
}

// Last 12 bytes of every complete PNG (IEND length+type+CRC); header-only
// checks accept truncated files, which older versions could publish.
var pngEndMarker = "0000000049454e44ae426082"

// Shell condition: true when the file's tail carries the PNG IEND trailer.
function pngCompleteTest(fileExpr) {
  return '[ "$(tail -c 12 -- ' + fileExpr
    + ' 2>/dev/null | od -An -tx1 | tr -d \' \\n\')" = "' + pngEndMarker + '" ]'
}

// Shared body for both thumbnail producers (PDF/video differ only in the
// render snippet). Key = md5("<path>|<size>|<mtime>|<inode>") — an edited or
// replaced source never hits stale. Hit: IEND-complete stored PNG streams and
// exits before any renderer runs; corrupt entries are deleted for re-render.
// Miss: private render, atomic .part publish only when within the byte ceiling
// AND IEND-complete (-3 oversized, -1 failed/truncated are never saved), then
// GC to the newest <cacheLimit>. No storeDir or limit <= 0 disables the disk.
function thumbnailShellBody(path, outBase, storeDir, cacheLimit, renderSnippet, ceiling) {
  var quoted = Core.shellQuote(path)
  var quotedBase = Core.shellQuote(outBase)
  var scratchPre = "mkdir -p -- " + Core.shellQuote(Core.parentDir(outBase)) + " 2>/dev/null;"
  var keep = parseInt(cacheLimit, 10)
  var head = "umask 077;"
    + " if [ -f " + quoted + " ] && [ -r " + quoted + " ]; then"
    + " sz=$(stat -Lc %s -- " + quoted + " 2>/dev/null);"
  var mid = " tmp=\"$tmpd/page.png\";"
    + " " + renderSnippet
    + " if [ -s \"$tmp\" ] && " + pngCompleteTest('"$tmp"') + "; then"
    + " if [ \"$(stat -Lc %s -- \"$tmp\")\" -le " + ceiling + " ]; then"
  var close = ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 \"$tmp\";"
    + " else printf '\\t-3\\t\\n'; fi"
    + " else printf '\\t-1\\t\\n'; fi;"
    + " rm -rf -- \"$tmpd\";"
    + " else printf '\\t-1\\t\\n'; fi"
  if (!storeDir || !(keep > 0)) {
    return head
      + " " + scratchPre
      + " tmpd=$(mktemp -d -- " + quotedBase + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
      + mid
      + close
  }
  // .part files are concurrent saves in flight: they count toward no cap and
  // must never be deleted out from under a publishing job.
  var gc = "ls -1t -- \"$store\" 2>/dev/null | grep -v '\\.part$'"
    + " | tail -n +" + (keep + 1)
    + " | while IFS= read -r f; do rm -f -- \"$store/$f\"; done"
  return head
    + " mt=$(stat -Lc %Y -- " + quoted + " 2>/dev/null);"
    + " in=$(stat -Lc %i -- " + quoted + " 2>/dev/null);"
    + " key=$(printf '%s|%s|%s|%s\\n' " + quoted + " \"${sz:-?}\" \"${mt:-?}\" \"${in:-?}\" | md5sum | cut -d' ' -f1);"
    + " store=" + Core.shellQuote(storeDir) + ";"
    + " thumb=\"\";"
    + " { [ -d \"$store\" ] || mkdir -p -- \"$store\"; } 2>/dev/null && thumb=\"$store/$key.png\";"
    + " if [ -n \"$thumb\" ] && [ -s \"$thumb\" ]; then"
    + " if " + pngCompleteTest('"$thumb"') + "; then"
    + ' printf "\\t%s\\t\\n" "${sz:-?}";'
    + " base64 -w0 -- \"$thumb\"; exit 0; fi;"
    + " rm -f -- \"$thumb\"; fi;"
    + " " + scratchPre
    + " tmpd=$(mktemp -d -- " + quotedBase + ".XXXXXX) || { printf '\\t-1\\t\\n'; exit 0; };"
    + mid
    + " if [ -n \"$thumb\" ]; then"
    + " rm -f -- \"$thumb.part\";"
    + " { cp -f -- \"$tmp\" \"$thumb.part\" && mv -f -- \"$thumb.part\" \"$thumb\"; } 2>/dev/null;"
    + " " + gc + ";"
    + " fi;"
    + close
}

// Page-1 render into a private mode-0700 mktemp dir; relay-wrapped so stale
// teardown kills it. Scratch is removed even after failed renders.
function buildPdfPreviewCommand(path, outBase, storeDir, cacheLimit, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var render = Walks.termRelay("timeout -k 5 " + renderTimeoutSecs
    + " pdftoppm -png -f 1 -singlefile -scale-to " + scale
    + " " + Core.shellQuote(path) + " \"${tmp%.png}\"") + ";"
  return ["bash", "-c", thumbnailShellBody(path, outBase, storeDir, cacheLimit, render, ceiling)]
}

// Self-contained <img> source, or "" for empty/over-ceiling payloads so an
// unbounded data URL can never be constructed.
function pdfDataUrl(b64) {
  var s = String(b64 || "").replace(/\s+/g, "")
  if (s.length === 0 || s.length > Math.ceil(thumbPngByteCeiling / 3) * 4) return ""
  return "data:image/png;base64," + s
}

// Same wire/store/GC as the PDF producer; seeks 1s in, retries from 0s when
// the clip is shorter or has no decodable frame. -nostdin protects collectors.
function buildVideoThumbnailCommand(path, outBase, storeDir, cacheLimit, scale, ceiling) {
  if (scale === undefined) scale = pdfRenderScale
  if (!isFinite(ceiling) || ceiling <= 0) ceiling = thumbPngByteCeiling
  var grab = function (ss) {
    return Walks.termRelay("timeout -k 5 " + renderTimeoutSecs
      + " ffmpeg -nostdin -hide_banner -loglevel error -ss " + ss
      + " -i " + Core.shellQuote(path)
      + " -frames:v 1 -map v:0 -vf 'scale=min(iw\\," + scale + "):-2'"
      + " -y \"$tmp\"") + ";"
  }
  return ["bash", "-c", thumbnailShellBody(path, outBase, storeDir, cacheLimit,
    grab(1) + " if [ ! -s \"$tmp\" ]; then " + grab(0) + " fi;", ceiling)]
}

if (typeof module !== "undefined") {
  module.exports = {
    pdfRenderScale: pdfRenderScale,
    renderTimeoutSecs: renderTimeoutSecs,
    thumbPngByteCeiling: thumbPngByteCeiling,
    pngEndMarker: pngEndMarker,
    pngCompleteTest: pngCompleteTest,
    previewFailureTtlMs: previewFailureTtlMs,
    previewFailureLimit: previewFailureLimit,
    isFailureFresh: isFailureFresh,
    buildPreviewCommand: buildPreviewCommand,
    buildDirPreviewCommand: buildDirPreviewCommand,
    parsePreviewOutput: parsePreviewOutput,
    buildPdfPreviewCommand: buildPdfPreviewCommand,
    buildVideoThumbnailCommand: buildVideoThumbnailCommand,
    pdfDataUrl: pdfDataUrl
  }
}
