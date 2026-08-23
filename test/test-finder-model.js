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

// ================= misc regressions =================

eq(M.shellQuote("it's"), "'it'\\''s'", "shellQuote escapes singles")
eq(M.formatBytes(0), "0 B", "bytes 0")
eq(M.formatBytes(2048), "2.0 KB", "kilobytes")
eq(M.parsePreviewOutput("\t123\t2026-01-01 10:00:00\nhello").size, 123, "preview size parsed")
eq(M.parsePreviewOutput("\t123\t2026-01-01 10:00:00\nhello").content, "hello", "preview content parsed")
eq(M.isDirPath("/x/"), true, "dir marker")
eq(M.isDirPath("/x"), false, "file has no marker")
eq(M.cleanPath("/x///"), "/x", "cleanPath collapses slashes")

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

  // truncation yields a clean prefix
  cfg = M.resolveSettings({ search_dirs: [live1, live2], max_scan_results: 3 }, HOME)
  rows = M.markDirectories(run(M.scanCommand(cfg)))
  eq(rows.length, 3, "integration: head cap exact")

  // browse: dirs first, depth 1
  cfg = M.resolveSettings({ browse_dir: live1 }, HOME)
  var browsed = run(M.browseCommand(cfg)).split("\n").filter(function (l) { return l.length > 1 && l.charAt(0) === "/" })
  eq(browsed, [path.join(live1, "sub") + "/", path.join(live1, "a.txt")], "integration: browse dirs-first depth-1")

  fs.rmSync(tmp, { recursive: true, force: true })
})()

console.log("OK — " + passed + " assertions passed")
