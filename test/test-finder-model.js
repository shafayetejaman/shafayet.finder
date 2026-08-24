// Bash-output contract tests for FinderModel.js — completely standalone.
// Run with:  node test/test-finder-model.js
// Exits non-zero on the first failure and prints what was expected.

var assert = require("assert")
var cp = require("child_process")
var fs = require("fs")
var os = require("os")
var path = require("path")

var M = require(path.join(__dirname, "..", "FinderModel.js"))

var passed = 0
function ok(cond, label) {
  if (!cond) {
    console.error("FAIL: " + label)
    process.exit(1)
  }
  passed++
}
function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected)
  } catch (e) {
    console.error("FAIL: " + label + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual))
    process.exit(1)
  }
  passed++
}

// Counts top-level "fd " invocations in a generated bash script.
function fdInvocationCount(script) {
  return (script.match(/& __p=\$!/g) || []).length +
    (script.indexOf("& __p=$!") === -1 && /[^']fd /.test(script) ? 1 : 0)
}
function relayCount(script) {
  return (script.match(/wait "\$__p"/g) || []).length
}

var HOME = "/home/tester"

// ================= settings resolution =================

eq(M.resolveSettings({}, HOME).searchDirs, [HOME], "default search dir is $HOME")
eq(M.resolveSettings({ search_dirs: ["$HOME", "/mnt/data"] }, HOME).searchDirs, [HOME, "/mnt/data"], "$HOME expands")
eq(M.resolveSettings({ ignored_dirs: ["$HOME"] }, HOME).searchDirs, [], "root listed in ignored_dirs is dropped entirely")
eq(M.resolveSettings({ search_dirs: ["/data"], ignored_dirs: ["/database"] }, HOME).searchDirs, ["/data"], "prefix collision is not a match")
eq(M.resolveSettings({ debounce_ms: 0 }, HOME).debounceMs, 0, "zero debounce allowed")
eq(M.resolveSettings({ max_display_rows: "abc" }, HOME).maxDisplayRows, M.maxDisplayRows, "garbage int falls back")
eq(M.resolveSettings({}, HOME).previewWorkers, 3, "default worker count is 3")
eq(M.resolveSettings({ preview_workers: 10 }, HOME).previewWorkers, 3, "worker count clamps to 3")
eq(M.resolveSettings({ preview_workers: 1 }, HOME).previewWorkers, 1, "one worker means serial previews")
eq(M.resolveSettings({ preview_workers: 0 }, HOME).previewWorkers, M.previewWorkers, "invalid worker count falls back")
eq(M.resolveSettings({}, HOME).pdfRenderScale, M.pdfRenderScale, "default render scale")
eq(M.resolveSettings({ pdf_render_scale: 100000 }, HOME).pdfRenderScale, 4000, "render scale clamps high")
eq(M.resolveSettings({ pdf_render_scale: 1 }, HOME).pdfRenderScale, 64, "render scale clamps low")
eq(M.resolveSettings({ pdf_render_scale: "abc" }, HOME).pdfRenderScale, M.pdfRenderScale, "garbage render scale falls back")
eq(M.resolveSettings({}, HOME).thumbnailCacheLimit, M.thumbnailCacheLimit, "default thumbnail store cap")
eq(M.resolveSettings({ thumbnail_cache_limit: 0 }, HOME).thumbnailCacheLimit, 0, "zero opts out of thumbnail persistence")
eq(M.resolveSettings({ thumbnail_cache_limit: -5 }, HOME).thumbnailCacheLimit, M.thumbnailCacheLimit, "negative cap falls back to default")
eq(M.resolveSettings({ thumbnail_cache_limit: "abc" }, HOME).thumbnailCacheLimit, M.thumbnailCacheLimit, "garbage thumbnail cap falls back")

// ================= overlapping root pruning =================

eq(M.pruneContainedRoots(["/a", "/a/b", "/a/b/c"]), ["/a"], "containment chain collapses to outermost")
eq(M.pruneContainedRoots(["/mnt/a", "/mnt/ab", "/b"]), ["/mnt/a", "/mnt/ab", "/b"],
  "text-prefix siblings are not containment")
eq(M.pruneContainedRoots(["/x", "/x", "/y"]), ["/x", "/y"], "exact repeats collapse to first occurrence")
eq(M.pruneContainedRoots(["/z", "/z/y", "/q"]), ["/z", "/q"], "ordering preserved")
eq(M.pruneContainedRoots(["/keep", "", "/keep/deep"]), ["/keep"], "empty entries dropped")
eq(M.pruneContainedRoots([]), [], "no roots stays empty")

// Nested roots in real settings resolve to the disjoint parent set.
eq(
  M.resolveSettings({
    search_dirs: ["/data", "/data/Video", "/data/Documents", "/other"]
  }, HOME).searchDirs,
  ["/data", "/other"],
  "nested search_dirs collapse to outermost roots"
)
eq(
  M.resolveSettings({
    search_dirs: ["$HOME", "$HOME/D"]
  }, HOME).searchDirs,
  [HOME],
  "a root inside \$HOME collapses into \$HOME"
)
eq(
  M.resolveSettings({
    search_dirs: ["$HOME", "$HOME/D"],
    ignored_dirs: ["$HOME/D"]
  }, HOME).searchDirs,
  [HOME],
  "ignored nested root drops before pruning; parent still scanned"
)

// ================= expandPath =================

eq(M.expandPath("$HOME", HOME), HOME, "$HOME bare")
eq(M.expandPath("$HOME/x", HOME), HOME + "/x", "$HOME/sub")
eq(M.expandPath("$HOMEfoo", HOME), "$HOMEfoo", "$HOME without separator stays literal")
eq(M.expandPath("~", HOME), HOME, "~ bare")
eq(M.expandPath("~/x/", HOME), HOME + "/x", "~ expansion strips trailing slash")

// ================= excludes =================

// Per-root form (used by the single-directory browse command): long flags only.
eq(M.fdExcludeArgs(HOME, ["x"], [HOME + "/sub"]),
  ["--exclude", "x", "--exclude", "/sub"], "browse excludes are anchored and long-form")
eq(M.fdExcludeArgs(HOME, [], [HOME]), [], "ignored root emits nothing")
eq(M.fdExcludeArgs(HOME, [], ["/elsewhere"]), [], "unrelated dir emits nothing")

// Combined form (used by multi-root scans): cross-root globs, deduped.
eq(M.combinedExcludeArgs(
    ["node_modules", "target"],
    [HOME + "/.cache", "/mnt/data/go/pkg", "/nowhere/x"],
    [HOME, "/mnt/data"]),
  ["--exclude", "node_modules", "--exclude", "target",
   "--exclude", "**/.cache", "--exclude", "**/go/pkg"],
  "combined excludes: names verbatim, dirs relative to deepest matching root")
eq(M.relativeToDeepestRoot("/a/b/c", ["/a", "/a/b"]), "b/c", "deepest root wins")
eq(M.relativeToDeepestRoot("/zzz/x", ["/a"]), "", "dir outside every root is skipped")

// ================= scan: classic mode =================

var classic = M.resolveSettings({
  search_dirs: ["/r1", "/r2"],
  ignored_dirs: ["/r2/deep/x"],
  ignored_names: ["tgt"],
}, HOME)
var s = M.scanCommand(classic)[2]

ok(s.indexOf("( { __p=() ;") === 0, "classic scan starts with guarded roots prologue")
ok(s.indexOf("[ -d '/r1' ] && __p+=('/r1')") !== -1, "root 1 guarded")
ok(s.indexOf("[ -d '/r2' ] && __p+=('/r2')") !== -1, "root 2 guarded")
ok(s.indexOf('[ ${#__p[@]} -gt 0 ] || exit 0') !== -1, "all-dead roots exit cleanly")
eq(fdInvocationCount(s), 1, "classic scan is ONE fd invocation")
eq(relayCount(s), 1, "classic scan leaf is relay-wrapped once")
ok(s.indexOf("--type file --type directory") !== -1, "mixed types selected")
ok(s.indexOf("--absolute-path . \"${__p[@]}\"") !== -1, "absolute paths, positionals from array")
ok(s.indexOf("'--exclude' 'tgt'") !== -1, "name exclude present")
ok(s.indexOf("'--exclude' '**/deep/x'") !== -1, "ignored dir becomes cross-root glob")
ok(s.indexOf("-E ") === -1 && s.indexOf("-t ") === -1, "no short flags emitted")
ok(s.trim().endsWith("| head -n 100000"), "scan capped by head")

// show_hidden injects --hidden
s = M.scanCommand(M.resolveSettings({ search_dirs: ["/r1"], show_hidden: true }, HOME))[2]
ok(s.indexOf("--hidden") !== -1 && s.indexOf("--hidden") < s.indexOf('. "${__p[@]}"'), "show_hidden adds --hidden before pattern")

// empty searchDirs -> valid no-op
eq(M.scanCommand(M.resolveSettings({ ignored_dirs: ["$HOME"] }, HOME)), ["bash", "-c", ""], "no roots -> no-op")

// ================= scan: override mode =================

var over = M.resolveSettings({
  search_dirs: ["/r1", "/r2"],
  fd_flags: ["--ignore-vcs", "--hidden", "--type", "file", "--type", "directory"],
}, HOME)
s = M.scanCommand(over)[2]
eq(fdInvocationCount(s), 1, "override scan is ONE fd invocation")
ok(s.indexOf("'--hidden'") !== -1, "override flags verbatim")
ok(s.indexOf("'--absolute-path'") !== -1, "override auto-appends --absolute-path")
ok(s.indexOf("'--exclude' 'node_modules'") !== -1, "policy excludes enforced in override mode")
ok(s.indexOf(". \"${__p[@]}\"") !== -1, "roots stay builder-owned positionals")

// ================= browse =================

var bc = M.resolveSettings({ browse_dir: "/tmp/browsethis" }, HOME)
var b = M.browseCommand(bc)[2]
eq(fdInvocationCount(b), 1, "browse is ONE fd invocation")
eq(relayCount(b), 1, "browse leaf relay-wrapped")
ok(b.indexOf("{ [ -d '/tmp/browsethis' ] || exit 0 ; }") !== -1, "missing browse dir exits cleanly")
ok(b.indexOf("--min-depth 1 --max-depth 1") !== -1, "browse is depth-1 only")
ok(b.indexOf("@@DIRS@@") !== -1, "dirs-first classify snippet present")
ok(b.indexOf("| head -n 200") !== -1, "browse capped by head")

// ================= markDirectories =================

eq(M.markDirectories([
  "/bin",                 // short absolute path survives
  "",
  "@@DIRS@", "@@END@@",   // legacy frame lines never start with "/"
  "/tmp/x/",              // single slash untouched
  "/tmp/d///",            // doubled slashes collapse to one
  "relative/path",        // non-absolute dropped
].join("\n")), ["/bin", "/tmp/x/", "/tmp/d/"], "line parser filters and normalizes")

eq(M.markDirectories("/f1\n/f2\n@@DIRS@@\n/d1/\n@@END@@\n/g\n@@DIRS@@\n\n@@END@@\n"),
  ["/f1", "/f2", "/d1/", "/g"], "legacy framed cache format parses unchanged")

// ================= search / preview builders =================

var q = M.buildSearchCommand("/tmp/list.txt", "big report", 25)
ok(q[0] === "bash" && q[1] === "-c", "search command shape")
ok(q[2].indexOf("fzf --filter 'big report' --scheme=path") !== -1, "query shell-quoted")
ok(q[2].indexOf("< '/tmp/list.txt'") !== -1, "list file on stdin")
ok(q[2].endsWith("| head -n 25"), "display limit applied")

var pv = M.buildPreviewCommand("/a b.txt", 1024)
ok(pv[2].indexOf("head -c 1024 -- '/a b.txt'") !== -1, "preview byte cap and quoting")
ok(pv[2].indexOf("-1") !== -1, "unreadable marker present")

var dp = M.buildDirPreviewCommand("/dir", 4096, false)
ok(dp[2].indexOf("-2") !== -1, "dir preview header marker")
ok(dp[2].indexOf("grep -v '^\\.'") !== -1, "dot entries filtered when hidden")

// ================= pdf preview =================

eq(M.pdfDataUrl("iVBOR\n"), "data:image/png;base64,iVBOR", "pdf data url strips whitespace")
eq(M.pdfDataUrl(""), "", "pdf data url rejects empty payload")
var oversize = new Array(Math.ceil(M.thumbPngByteCeiling / 3) * 4 + 2).join("A")
eq(M.pdfDataUrl(oversize), "", "pdf data url rejects over-ceiling payload")

var pc = M.buildPdfPreviewCommand("/my pdf.pdf", "/tmp/base", "", 0, 800)
ok(pc[2].indexOf("pdftoppm -png -f 1 -singlefile -scale-to 800 '/my pdf.pdf' \"${tmp%.png}\"") !== -1,
  "pdf render targets per-job scratch outbase")
ok(pc[2].indexOf("umask 077;") === 0, "scratch work runs under private umask")
ok(pc[2].indexOf("mktemp -d -- '/tmp/base'.XXXXXX") !== -1, "per-job private scratch dir")
ok(pc[2].indexOf('tmp="$tmpd/page.png"') !== -1, "render lands inside the private dir")
ok(pc[2].indexOf("base64 -w0 \"$tmp\"") !== -1, "payload emitted as base64 text")
ok(pc[2].indexOf("-le " + M.thumbPngByteCeiling) !== -1, "producer-side png byte ceiling enforced")
ok(pc[2].indexOf("printf '\\t-3\\t\\n'") !== -1, "oversize marker present")
ok(pc[2].indexOf("printf '\\t-1\\t\\n'") !== -1, "unreadable marker present")
ok(pc[2].indexOf("rm -rf -- \"$tmpd\";") !== -1, "private scratch dir cleaned up")
eq(M.buildPdfPreviewCommand("/my pdf.pdf", "/tmp/base", undefined, undefined, 800)[2], pc[2],
  "legacy two-arg call still accepted (persistence off)")

// Persistent store: hit fast path, staleness-keyed name, atomic save, GC.
var pcs = M.buildPdfPreviewCommand("/my pdf.pdf", "/tmp/base", "/store/pdf", 500, 800)
ok(pcs[2].indexOf("md5sum | cut -d' ' -f1") !== -1, "disk key hashed with md5sum")
ok(pcs[2].indexOf("stat -Lc %Y") !== -1, "source mtime feeds the disk key")
ok(pcs[2].indexOf("printf '%s|%s|%s\\n' '/my pdf.pdf' \"${sz:-?}\" \"${mt:-?}\"") !== -1,
  "disk key hashes raw path text with size and mtime")
ok(pcs[2].indexOf("{ [ -d \"$store\" ] || mkdir -p -- \"$store\"; } 2>/dev/null && thumb=\"$store/$key.png\"") !== -1,
  "store dir created on demand, failure degrades to render-only")
ok(pcs[2].indexOf('base64 -w0 -- "$thumb"; exit 0') !== -1,
  "hit streams stored pixels and exits before any renderer or scratch dir")
ok(pcs[2].indexOf("\"$thumb.part\" && mv -f -- \"$thumb.part\" \"$thumb\"") !== -1,
  "save publishes atomically via same-directory rename")
ok(pcs[2].indexOf("tail -n +501") !== -1, "GC prunes beyond the configured cap")
ok(pcs[2].indexOf("-le " + M.thumbPngByteCeiling) !== -1, "ceiling still enforced when persisting")
ok(pcs[2].indexOf("if [ -n \"$thumb\" ]; then") !== -1,
  "save and GC skipped entirely when the store is unavailable")

// ================= misc regressions =================

eq(M.shellQuote("it's"), "'it'\\''s'", "shellQuote escapes singles")
eq(M.formatBytes(0), "0 B", "bytes 0")
eq(M.formatBytes(2048), "2.0 KB", "kilobytes")
eq(M.parsePreviewOutput("\t123\t2026-01-01 10:00:00\nhello").size, 123, "preview size parsed")
eq(M.parsePreviewOutput("\t123\t2026-01-01 10:00:00\nhello").content, "hello", "preview content parsed")
eq(M.isDirPath("/x/"), true, "dir marker")
eq(M.isDirPath("/x"), false, "file has no marker")
eq(M.cleanPath("/x///"), "/x", "cleanPath collapses slashes")

// ================= deleteLastWord =================

eq(M.deleteLastWord("foo bar"), "foo ", "kills word, keeps separator")
eq(M.deleteLastWord("foo bar  "), "foo ", "trailing whitespace collapses with word")
eq(M.deleteLastWord("foo"), "", "single word empties")
eq(M.deleteLastWord(""), "", "empty stays empty")
eq(M.deleteLastWord("--size +5mb invo"), "--size +5mb ", "flag query loses last term")
eq(M.deleteLastWord("  "), "", "whitespace-only empties")

// ================= parseQuery: inline fd flags =================

function parse(s) { return M.parseQuery(s) }

eq(parse("invoice"), { args: [], fdPattern: "invoice", fzfQuery: "" }, "plain text -> classic path (no flags)")
eq(parse("--size +5mb invoice"), { args: ["--size", "+5mb"], fdPattern: "invoice", fzfQuery: "" },
  "value flag + single text")
eq(parse("--size=+5mb report paid 2024"), { args: ["--size=+5mb"], fdPattern: "report", fzfQuery: "paid 2024" },
  "attached value; extra text staged to fzf")
eq(parse("-e pdf ."), { args: ["-e", "pdf"], fdPattern: ".", fzfQuery: "" },
  "single-value extension + match-all pattern")
eq(parse("--ext pdf ."), { args: ["--extension", "pdf"], fdPattern: ".", fzfQuery: "" },
  "--ext alias rewrites to --extension and consumes one value")
eq(parse("--ext=pdf ."), { args: ["--extension=pdf"], fdPattern: ".", fzfQuery: "" },
  "attached --ext= form also rewrites")
eq(parse("--ext jpg --ext png report"), { args: ["--extension", "jpg", "--extension", "png"], fdPattern: "report", fzfQuery: "" },
  "repeated --ext aliases")
eq(parse("-e jpg -e png -- sunset beach"), { args: ["-e", "jpg", "-e", "png"], fdPattern: "sunset", fzfQuery: "beach" },
  "repeated extensions; bare -- stages the rest to fzf")
eq(parse("-E node_modules report"), { args: ["-E", "node_modules"], fdPattern: "report", fzfQuery: "" },
  "exclude takes one glob; text becomes pattern")
eq(parse("--size +5mb"), { args: ["--size", "+5mb"], fdPattern: "", fzfQuery: "" }, "flags-only -> no run")
eq(parse("-- -weird x"), { args: [], fdPattern: "-weird", fzfQuery: "x" }, "bare -- makes everything literal")
eq(parse("--hidden foo bar baz"), { args: ["--hidden"], fdPattern: "foo", fzfQuery: "bar baz" },
  "unknown flag passes through as boolean")
eq(parse("-S 5mb --type d report rest"), { args: ["-S", "5mb", "--type", "d"], fdPattern: "report", fzfQuery: "rest" },
  "mixed short/long value flags")
eq(parse("--changed-within 1d ."), { args: ["--changed-within", "1d"], fdPattern: ".", fzfQuery: "" },
  "match-all wildcard token")
eq(parse("-"), { args: [], fdPattern: "-", fzfQuery: "" }, "lone dash is text, not a flag")

// ================= fdCacheKey / warm-edit path =================

var keyCfg = M.resolveSettings({ search_dirs: ["/r1"] }, HOME)
eq(M.fdCacheKey(keyCfg, parse("--size +5mb big rest")),
   M.fdCacheKey(keyCfg, parse("--size +5mb big rest more words")),
   "cache key ignores staged fzf text")
ok(M.fdCacheKey(keyCfg, parse("--size +5mb big")) !== M.fdCacheKey(keyCfg, parse("--size +5mb other")),
   "cache key tracks the pattern")
ok(M.fdCacheKey(keyCfg, parse("--size +5mb big")) !== M.fdCacheKey(keyCfg, parse("--type f big")),
   "cache key tracks the flags")
ok(M.fdCacheKey(keyCfg, parse("--size +5mb big"))
   !== M.fdCacheKey(M.resolveSettings({ search_dirs: ["/other"] }, HOME), parse("--size +5mb big")),
   "cache key tracks walk-relevant settings")
eq(M.fdCacheKey(keyCfg, parse("big rest")), "", "classic queries never produce a key")
eq(M.fdCacheKey(keyCfg, parse("--size +5mb")), "", "flags-only queries never produce a key")

// ================= fuzzyFilterRows =================

var rows = ["/a/report.txt", "/b/Report Paid.pdf", "/c/rep.xlsx", "/d/paid-report.doc"]
eq(M.fuzzyFilterRows([], "x"), [], "empty input stays empty")
eq(M.fuzzyFilterRows(rows, ""), rows.slice(), "blank query passes everything through in order")
eq(M.fuzzyFilterRows(rows, "   "), rows.slice(), "whitespace query passes through")
ok(M.fuzzyFilterRows(rows, "report").indexOf("/a/report.txt") === 0,
   "contiguous anchored match ranks first; case-folded")
eq(M.fuzzyFilterRows(rows, "rep").length, 4, "subsequence matches mid-word too")
eq(M.fuzzyFilterRows(rows, "Report"), ["/b/Report Paid.pdf"], "uppercase query turns case-sensitive")
eq(M.fuzzyFilterRows(rows, "zzz"), [], "non-subsequence matches nothing")
eq(M.fuzzyFilterRows(rows, "rep paid").sort(),
   ["/b/Report Paid.pdf", "/d/paid-report.doc"].sort(),
   "space-separated terms AND independently like real fzf")
eq(M.fuzzyFilterRows(["/y/xrep xpaid.doc", "/x/rep paid.txt"], "rep paid"),
   ["/x/rep paid.txt", "/y/xrep xpaid.doc"],
   "both terms contiguous+anchored outranks scattered matches")
eq(M.fuzzyFilterRows(["/b/xreport.txt", "/a/report.txt"], "report"),
   ["/a/report.txt", "/b/xreport.txt"],
   "path-boundary anchored match outranks mid-word match")
eq(M.fuzzyFilterRows(["/b/scatter-r-e-p-o-rt.doc", "/a/report.txt"], "report"),
   ["/a/report.txt", "/b/scatter-r-e-p-o-rt.doc"],
   "multi-start alignment finds the clean run, not the greedy scattered one")

// ================= liveFdCommand =================

var liveCfg = M.resolveSettings({ search_dirs: ["/r1", "/r2"], ignored_dirs: ["/r2/deep/x"] }, HOME)
var lf = M.liveFdCommand(liveCfg, parse("--size +5mb big rest"), 5000)[2]
eq(fdInvocationCount(lf), 1, "live fd is ONE invocation")
ok(lf.indexOf("'--size' '+5mb'") !== -1, "user flags verbatim and quoted")
ok(lf.indexOf("'--absolute-path'") !== -1, "absolute path forced")
ok(lf.indexOf("'--exclude' '**/deep/x'") !== -1, "policy excludes enforced in flag mode")
ok(lf.indexOf("'big' \"${__p[@]}\"") !== -1, "pattern quoted before guarded roots")
eq(lf.indexOf("fzf"), -1, "walk carries NO fzf stage — staged text filters in memory")
ok(lf.trim().endsWith("| head -n 5000"), "baseline capped at the passed walk cap")
ok(/wait "\$__p"/.test(lf), "live leaf relay-wrapped")

lf = M.liveFdCommand(liveCfg, parse("-e txt ."), 50)[2]
ok(lf.indexOf("| fzf ") === -1, "no fzf stage without a second text token")
ok(lf.indexOf("'.' \"${__p[@]}\"") !== -1, "match-all pattern scoped to roots")

// defensive: no roots / empty args -> valid no-op
eq(M.liveFdCommand(M.resolveSettings({ ignored_dirs: ["$HOME"] }, HOME), parse("--size +5mb x"), 50),
  ["bash", "-c", ""], "no roots -> no-op")
eq(M.liveFdCommand(liveCfg, { args: [], fdPattern: "x", fzfQuery: "" }, 50), ["bash", "-c", ""], "no flags -> no-op")
ok(M.liveFdCommand(liveCfg, parse("--size +5mb"), 50)[2].indexOf("'.' \"${__p[@]}\"") !== -1,
  "empty pattern falls back to match-all")

// ================= video thumbnail command =================

var vt = M.buildVideoThumbnailCommand("/v/clip.mp4", "/tmp/thumbbase", "/store/video", 300, 1200)[2]
ok(vt.indexOf("ffmpeg") !== -1, "video cmd uses ffmpeg")
ok(vt.indexOf("-frames:v 1") !== -1, "grabs exactly one frame")
ok(/-ss 1 /.test(vt) && /-ss 0 /.test(vt), "seeks 1s, falls back to 0s for short clips")
ok(vt.indexOf("-nostdin") !== -1, "ffmpeg never touches stdin")
ok(vt.indexOf("scale=min(iw\\,1200):-2") !== -1, "aspect-preserving cap at render scale")
ok(/wait "\$__p"/.test(vt), "ffmpeg relay-wrapped")
ok(vt.indexOf("umask 077;") === 0, "video scratch work runs under private umask")
ok(vt.indexOf("mktemp -d -- '/tmp/thumbbase'.XXXXXX") !== -1, "per-job private scratch dir")
ok(vt.indexOf("-le " + M.thumbPngByteCeiling) !== -1 && vt.indexOf("printf '\\t-3\\t\\n'") !== -1,
  "producer-side png byte ceiling enforced")
ok(vt.indexOf('rm -rf -- "$tmpd"') !== -1, "private scratch dir always cleaned")
eq(M.buildVideoThumbnailCommand("/v/clip.mp4", "/tmp/thumbbase", "", 0)[2].indexOf("1200") !== -1,
  true, "render scale defaults (persistence disabled)")
ok(vt.indexOf("tail -n +301") !== -1, "video store prunes at its own cap")

// ================= integration: real execution =================
// Executes generated scripts against a throwaway tree to prove the bash
// itself behaves: dead-root isolation, policy excludes, caps, dirs-first.

;(function integration() {
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "finder-test-"))
  var live1 = path.join(tmp, "live1")
  var live2 = path.join(tmp, "live2")
  var dead = path.join(tmp, "dead")
  fs.mkdirSync(path.join(live1, "sub"), { recursive: true })
  fs.mkdirSync(path.join(live2, "node_modules", "junk"), { recursive: true })
  fs.mkdirSync(path.join(live2, ".cache"), { recursive: true })
  fs.writeFileSync(path.join(live1, "a.txt"), "a")
  fs.writeFileSync(path.join(live1, "sub", "b.txt"), "b")
  fs.writeFileSync(path.join(live2, "node_modules", "junk.js"), "j")
  fs.writeFileSync(path.join(live2, ".cache", "c.txt"), "c")

  function run(cmd) { return cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" }) }

  // dead middle root must not sink the others
  var cfg = M.resolveSettings({ search_dirs: [live1, dead, live2] }, HOME)
  var rows = M.markDirectories(run(M.scanCommand(cfg)))
  ;[path.join(live1, "sub") + "/", path.join(live1, "a.txt"), path.join(live1, "sub", "b.txt")]
    .forEach(function (p) { ok(rows.indexOf(p) !== -1, "integration: " + p + " indexed") })
  ok(!rows.join(" ").match(/node_modules|\.cache|\/dead/), "integration: policy excludes honored, dead root absent")

  // Overlapping roots (live1 contains live1/sub) must yield every path
  // exactly once: the nested root is pruned before the walk.
  cfg = M.resolveSettings({ search_dirs: [live1, live1 + "/sub", live2] }, HOME)
  eq(cfg.searchDirs.indexOf(live1 + "/sub"), -1, "integration: contained root pruned from settings")
  rows = M.markDirectories(run(M.scanCommand(cfg)))
  ok(new Set(rows).size === rows.length, "integration: overlapping roots never duplicate rows")
  ;[path.join(live1, "sub") + "/", path.join(live1, "sub", "b.txt")]
    .forEach(function (p) { ok(rows.indexOf(p) !== -1, "integration: nested content still indexed once — " + p) })

  // truncation yields a clean prefix
  cfg = M.resolveSettings({ search_dirs: [live1, live2], max_scan_results: 3 }, HOME)
  rows = M.markDirectories(run(M.scanCommand(cfg)))
  eq(rows.length, 3, "integration: head cap exact")

  // browse: dirs first, depth 1
  cfg = M.resolveSettings({ browse_dir: live1 }, HOME)
  var browsed = run(M.browseCommand(cfg)).split("\n").filter(function (l) { return l.length > 1 && l.charAt(0) === "/" })
  eq(browsed, [path.join(live1, "sub") + "/", path.join(live1, "a.txt")], "integration: browse dirs-first depth-1")

  fs.rmSync(tmp, { recursive: true, force: true })
})

// Live flag-mode integration: proves the generated fd/fzf pipeline actually
// filters on size, extensions, staged text, and fails silent-and-empty.
;(function integrationFlagMode() {
  // Fixed letter-safe base: fzf matches whole absolute paths, so random
  // temp names could supply the very characters the staged query filters on.
  var tmp = "/tmp/fdr-t-" + process.pid
  var root = path.join(tmp, "tree")
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, "sub"), { recursive: true })
  fs.writeFileSync(path.join(root, "big.txt"), Buffer.alloc(2048, "a"))
  fs.writeFileSync(path.join(root, "small.txt"), Buffer.alloc(200, "s"))
  fs.writeFileSync(path.join(root, "pic.jpg"), Buffer.alloc(2048, "j"))
  fs.writeFileSync(path.join(root, "doc.pdf"), "%PDF-1.4 fake")
  fs.writeFileSync(path.join(root, "sub", "deep.txt"), Buffer.alloc(3072, "d"))

  var cfg = M.resolveSettings({ search_dirs: [root] }, HOME)
  function runLive(query) {
    var cmd = M.liveFdCommand(cfg, parse(query), 50)
    var out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
    return out.split("\n").filter(function (l) { return l.length > 1 && l.charAt(0) === "/" })
  }

  // size filter + first text token as fd pattern
  eq(runLive("--size +1kb big"), [path.join(root, "big.txt")], "live: size + pattern")
  // match-all wildcard scoped to roots
  eq(runLive("--type f --size +1kb .").sort(),
    [path.join(root, "big.txt"), path.join(root, "pic.jpg"), path.join(root, "sub", "deep.txt")].sort(),
    "live: match-all over roots")
  // extension via variadic ended by bare --, then single text token
  eq(runLive("-e jpg -- pic"), [path.join(root, "pic.jpg")], "live: extension filter")
  // single-value extension + match-all, like fd's own CLI
  eq(runLive("-e pdf ."), [path.join(root, "doc.pdf")], "live: -e pdf . match-all")
  eq(runLive("--ext pdf ."), [path.join(root, "doc.pdf")], "live: --ext alias reaches fd as --extension")
  eq(runLive("-e jpg -e pdf .").sort(),
    [path.join(root, "pic.jpg"), path.join(root, "doc.pdf")].sort(),
    "live: repeated extensions")
  // staged text never reaches the command: the baseline keeps every walk
  // row, and the finder filters it in memory (fuzzyFilterRows unit-tested above)
  var base = runLive("--type f . big")
  eq(base.length, 5, "live: baseline returns the whole walk, staged text ignored")
  // score root-relative paths so the random tmpdir name can't interfere
  var rel = base.map(function (p) { return p.slice(root.length) })
  eq(M.fuzzyFilterRows(rel, "big"), ["/big.txt"],
     "live: staged word filters the baseline client-side")
  // unknown/broken flag -> silent empty result
  eq(runLive("--frobnicate x"), [], "live: broken flag yields silence")

  fs.rmSync(tmp, { recursive: true, force: true })
})()

// PDF preview integration: renders a hand-written minimal PDF through the
// real pdftoppm pipeline and proves the payload arrives as a decodable PNG
// data url with no scratch file left behind. Also exercises the persistent
// thumbnail store: save, cache-hit fast path, staleness re-key, oversize
// refusal never saving, GC pruning, and the opt-out. Skips silently when
// poppler is not installed.
;(function integrationPdf() {
  var probe = cp.spawnSync("pdftoppm", ["-v"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) return

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "finder-pdf-"))
  var pdf = path.join(tmp, "doc.pdf")
  fs.writeFileSync(pdf,
    "%PDF-1.4\n"
    + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n"
    + "trailer<</Root 1 0 R/Size 4>>\n%%EOF\n")

  function scratchLeft() {
    return fs.readdirSync(tmp).filter(function (f) { return f.indexOf("render") === 0 }).length
  }

  var store = path.join(tmp, "store", "pdf")
  var cmd = M.buildPdfPreviewCommand(pdf, path.join(tmp, "render"), store, 500, 200)
  var out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  var parsed = M.parsePreviewOutput(out)

  ok(parsed.size > 0, "integration: pdf header reports a size")
  ok(M.pdfDataUrl(parsed.content).indexOf("data:image/png;base64,iVBOR") === 0,
    "integration: payload is a PNG data url")
  eq(scratchLeft(), 0, "integration: private scratch dir removed after persisting render")
  eq(fs.readdirSync(store).length, 1, "integration: successful render saved exactly one stored png")
  var savedKey = fs.readdirSync(store)[0]
  ok(/^[0-9a-f]{32}\.png$/.test(savedKey), "integration: stored name is an md5 key")

  // Cache hit: with the ceiling absurdly low a fresh render would report -3;
  // only the disk fast path can still report a real payload.
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  eq(M.parsePreviewOutput(out).size, parsed.size, "integration: second run hits the disk store")
  cmd = M.buildPdfPreviewCommand(pdf, path.join(tmp, "render"), store, 500, 200, 64)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: hit path bypasses renderer and ceiling entirely")

  // Staleness: touching the source mtime must re-key and re-render.
  var later = new Date(Date.now() + 10000)
  fs.utimesSync(pdf, later, later)
  cmd = M.buildPdfPreviewCommand(pdf, path.join(tmp, "render"), store, 500, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: edited source re-renders")
  eq(fs.readdirSync(store).length, 2, "integration: edit produced a fresh key, old entry left for GC")

  // Oversize refusal: an absurdly low ceiling must produce the -3 marker,
  // never a payload, and must NOT touch the store.
  var other = path.join(tmp, "other.pdf")
  fs.copyFileSync(pdf, other)
  cmd = M.buildPdfPreviewCommand(other, path.join(tmp, "render"), store, 500, 200, 64)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  eq(M.parsePreviewOutput(out).size, -3, "integration: over-ceiling render reports too-large")
  eq(scratchLeft(), 0, "integration: scratch dir removed even on refusal")
  eq(fs.readdirSync(store).filter(function (f) { return f !== savedKey }).length, 1,
    "integration: refused render is never persisted")

  // GC: cap of 2 keeps only the two newest files (the fresh save plus one).
  cmd = M.buildPdfPreviewCommand(other, path.join(tmp, "render"), store, 2, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: capped store still serves renders")
  eq(fs.readdirSync(store).length, 2, "integration: GC pruned the store to the configured cap")

  // Unreadable path reports the -1 marker instead of a payload.
  cmd = M.buildPdfPreviewCommand(path.join(tmp, "missing.pdf"), path.join(tmp, "render"), store, 500, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  eq(M.parsePreviewOutput(out).size, -1, "integration: missing pdf reports unreadable")

  // Opt-out (limit 0): legacy behavior, no disk writes anywhere.
  var bareStore = path.join(tmp, "bare-store", "pdf")
  cmd = M.buildPdfPreviewCommand(pdf, path.join(tmp, "render"), bareStore, 0, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: opt-out still renders")
  eq(fs.existsSync(bareStore), false, "integration: opt-out creates no store directory")

  fs.rmSync(tmp, { recursive: true, force: true })
})()

// Video thumbnail integration: renders a synthetic clip through the real
// ffmpeg pipeline and proves the payload arrives as a decodable PNG data url
// with no scratch file left behind, plus persistent-store save/hit/staleness.
// Skips silently when ffmpeg is absent.
;(function integrationVideo() {
  var probe = cp.spawnSync("ffmpeg", ["-version"], { encoding: "utf8" })
  if (probe.error || probe.status !== 0) return

  function makeClip(dest, seconds) {
    var gen = cp.spawnSync("ffmpeg",
      ["-hide_banner", "-loglevel", "error",
       "-f", "lavfi", "-i", "color=c=red:s=64x64:d=" + seconds,
       "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", dest],
      { encoding: "utf8" })
    return gen.status === 0 && fs.existsSync(dest)
  }

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "finder-video-"))
  var base = path.join(tmp, "thumb")
  var vid = path.join(tmp, "clip.mp4")
  var store = path.join(tmp, "store", "video")

  if (!makeClip(vid, 3)) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return
  }
  var cmd = M.buildVideoThumbnailCommand(vid, base, store, 500, 200)
  var out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  var parsed = M.parsePreviewOutput(out)
  ok(parsed.size > 0, "integration: video header reports a size")
  ok(M.pdfDataUrl(parsed.content).indexOf("data:image/png;base64,iVBOR") === 0,
    "integration: video payload is a PNG data url")
  eq(fs.readdirSync(tmp).filter(function (f) { return f.indexOf("thumb") === 0 }).length, 0,
    "integration: video scratch dir removed")
  eq(fs.readdirSync(store).length, 1, "integration: extracted frame saved to the disk store")
  var savedSize = parsed.size

  // Disk hit: low ceiling would force -3 on a fresh extraction; only the
  // store fast path can still return pixels.
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  eq(M.parsePreviewOutput(out).size, savedSize, "integration: second video look hits the disk store")
  cmd = M.buildVideoThumbnailCommand(vid, base, store, 500, 200, 64)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: video hit bypasses ffmpeg and ceiling entirely")

  // Staleness: an mtime bump re-keys and re-extracts.
  var later = new Date(Date.now() + 10000)
  fs.utimesSync(vid, later, later)
  cmd = M.buildVideoThumbnailCommand(vid, base, store, 500, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  ok(M.parsePreviewOutput(out).size > 0, "integration: re-touched clip re-extracts")
  eq(fs.readdirSync(store).length, 2, "integration: edit produced a fresh video key")

  // Oversize refusal: an absurdly low ceiling on a FRESH key must produce
  // the -3 marker, clean up, and persist nothing.
  var bigVid = path.join(tmp, "big.mp4")
  if (makeClip(bigVid, 0.5)) {
    cmd = M.buildVideoThumbnailCommand(bigVid, base, store, 500, 200, 64)
    out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
    eq(M.parsePreviewOutput(out).size, -3, "integration: over-ceiling frame reports too-large")
    eq(fs.readdirSync(tmp).filter(function (f) { return f.indexOf("thumb") === 0 }).length, 0,
      "integration: video scratch dir removed even on refusal")
    eq(fs.readdirSync(store).length, 2, "integration: refused frame persists nothing")
  }

  // Unreadable path reports the -1 marker instead of a payload.
  cmd = M.buildVideoThumbnailCommand(path.join(tmp, "missing.mp4"), base, store, 500, 200)
  out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
  eq(M.parsePreviewOutput(out).size, -1, "integration: missing video reports unreadable")

  // Sub-second clip exercises the -ss 1 -> -ss 0 retry.
  var shortVid = path.join(tmp, "short.mp4")
  if (makeClip(shortVid, 0.4)) {
    cmd = M.buildVideoThumbnailCommand(shortVid, base, store, 500, 200)
    out = cp.execFileSync(cmd[0], [cmd[1], cmd[2]], { encoding: "utf8" })
    ok(M.parsePreviewOutput(out).size > 0, "integration: sub-second clip still yields a frame")
    ok(fs.readdirSync(store).length >= 3, "integration: retry path saves its frame too")
  }

  fs.rmSync(tmp, { recursive: true, force: true })
})()

console.log("OK — " + passed + " assertions passed")
