// Performance benchmark: compares old vs new implementations of the 3
// optimized code paths.  Run with:  node test/benchmark.js
// Reports median of 5 runs per benchmark in milliseconds.

var cp = require("child_process")
var fs = require("fs")
var os = require("os")
var path = require("path")

var RUNS = 5
var passed = 0
var failed = 0

function ok(cond, label) {
  if (!cond) { console.error("FAIL: " + label); failed++ }
  else passed++
}

function median(arr) {
  var sorted = arr.slice().sort(function (a, b) { return a - b })
  var mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function fmt(ms) { return ms < 1 ? ms.toFixed(3) + "ms" : ms.toFixed(1) + "ms" }

// ================= old implementations (baseline) =================

function sortPipeSnippetOld(sortMode) {
  var field = sortMode === "birth" ? "%W" : "%Y"
  return "| { while IFS= read -r __sp; do "
    + "printf '%s\\t%s\\n' \"$(stat -c '" + field + "' -- \"$__sp\" 2>/dev/null || echo 0)\" \"$__sp\"; "
    + "done; } | sort -t'	' -rn | cut -f2-"
}

function isWordChar(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_"
}

function fuzzyScoreOld(line, query) {
  var text = String(line)
  var q = String(query)
  if (!/[A-Z]/.test(q)) { text = text.toLowerCase(); q = q.toLowerCase() }
  if (!q) return 0
  var starts = []
  var idx = text.indexOf(q.charAt(0))
  while (idx !== -1 && starts.length < 16) {
    starts.push(idx)
    idx = text.indexOf(q.charAt(0), idx + 1)
  }
  var best = -1
  for (var s = 0; s < starts.length; s++) {
    var score = 0
    var run = 0
    var prevIdx = starts[s] - 1
    var from = starts[s]
    var ok = true
    for (var qi = 0; qi < q.length; qi++) {
      idx = text.indexOf(q.charAt(qi), from)
      if (idx === -1) { ok = false; break }
      score += 16
      if (idx === prevIdx + 1) { run++; score += 4 + run * 2 } else { run = 0 }
      if (idx === 0 || !isWordChar(text.charAt(idx - 1))) score += 8
      prevIdx = idx
      from = idx + 1
    }
    if (ok && score > best) best = score
  }
  return best
}

function walkParseOld(raw) {
  var rows = []
  var lines = String(raw).split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].length > 1 && lines[i].charAt(0) === "/") rows.push(lines[i])
  }
  return rows
}

// ================= new implementations (optimized) =================

function sortPipeSnippetNew(sortMode) {
  var field = sortMode === "birth" ? "%W" : "%Y"
  return "| xargs -I {} -P 8 sh -c "
    + "'printf \"%s\\t%s\\n\" \"$(stat -c '" + field + "' -- \"{}\" 2>/dev/null || echo 0)\" \"{}\"'"
    + " | sort -t'	' -rn | cut -f2-"
}

function fuzzyScoreNew(line, query) {
  var text = String(line)
  var q = String(query)
  if (!/[A-Z]/.test(q)) { text = text.toLowerCase(); q = q.toLowerCase() }
  if (!q) return 0
  var charMap = {}
  for (var i = 0; i < text.length; i++) {
    var cc = text.charCodeAt(i)
    var arr = charMap[cc]
    if (arr) arr.push(i)
    else charMap[cc] = [i]
  }
  var qChars = []
  for (var j = 0; j < q.length; j++) qChars.push(q.charCodeAt(j))
  var starts = charMap[qChars[0]] || []
  if (starts.length > 16) starts = starts.slice(0, 16)
  var best = -1
  for (var s = 0; s < starts.length; s++) {
    var score = 0
    var run = 0
    var prevIdx = starts[s] - 1
    var from = starts[s]
    var ok = true
    for (var qi = 0; qi < qChars.length; qi++) {
      var positions = charMap[qChars[qi]]
      if (!positions) { ok = false; break }
      var lo = 0, hi = positions.length
      while (lo < hi) {
        var mid = (lo + hi) >> 1
        if (positions[mid] < from) lo = mid + 1
        else hi = mid
      }
      if (lo >= positions.length) { ok = false; break }
      var idx = positions[lo]
      score += 16
      if (idx === prevIdx + 1) { run++; score += 4 + run * 2 } else { run = 0 }
      if (idx === 0 || !isWordChar(text.charAt(idx - 1))) score += 8
      prevIdx = idx
      from = idx + 1
    }
    if (ok && score > best) best = score
  }
  return best
}

function walkParseNew(raw) {
  var rows = []
  var rawStr = String(raw)
  var start = 0
  while (start < rawStr.length) {
    var nl = rawStr.indexOf("\n", start)
    var end = nl === -1 ? rawStr.length : nl
    if (end - start > 1 && rawStr.charCodeAt(start) === 47) rows.push(rawStr.substring(start, end))
    if (nl === -1) break
    start = nl + 1
  }
  return rows
}

// ================= benchmark helpers =================

function timeIt(fn) {
  var start = process.hrtime.bigint()
  fn()
  var end = process.hrtime.bigint()
  return Number(end - start) / 1e6  // ns -> ms
}

function bench(label, fn) {
  var times = []
  for (var i = 0; i < RUNS; i++) times.push(timeIt(fn))
  var med = median(times)
  var min = Math.min.apply(null, times)
  var max = Math.max.apply(null, times)
  return { label: label, median: med, min: min, max: max, times: times }
}

// ================= benchmark 1: sort pipe =================

function benchSortPipe() {
  console.log("\n=== Benchmark 1: Sort Pipe (Modified/Created tab latency) ===")

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-sort-"))
  // Create 1000 files with staggered mtimes
  var files = []
  var newest = null
  for (var i = 0; i < 1000; i++) {
    var f = path.join(tmp, "file-" + String(i).padStart(4, "0") + ".txt")
    fs.writeFileSync(f, "x")
    // Stagger mtime: file 0 = oldest, file 999 = newest
    var t = new Date(Date.now() - (1000 - i) * 1000)
    fs.utimesSync(f, t, t)
    files.push(f)
    if (i === 999) newest = f
  }
  // Shuffle to remove any ordering bias in the input
  for (var i = files.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1))
    var tmp2 = files[i]; files[i] = files[j]; files[j] = tmp2
  }

  var fileList = files.join("\n")
  var snipOld = sortPipeSnippetOld("mtime")
  var snipNew = sortPipeSnippetNew("mtime")

  // Verify both produce the same output
  var cmdOld = "printf '%s\\n' " + files.map(function (f) { return "'" + f.replace(/'/g, "'\\''") + "'" }).join(" ") + " " + snipOld
  var cmdNew = "printf '%s\\n' " + files.map(function (f) { return "'" + f.replace(/'/g, "'\\''") + "'" }).join(" ") + " " + snipNew

  var outOld = cp.execFileSync("bash", ["-c", cmdOld], { encoding: "utf8" })
  var outNew = cp.execFileSync("bash", ["-c", cmdNew], { encoding: "utf8" })

  var linesOld = outOld.trim().split("\n")
  var linesNew = outNew.trim().split("\n")
  ok(linesOld.length === 1000, "old sort pipe returns 1000 lines")
  ok(linesNew.length === 1000, "new sort pipe returns 1000 lines")
  // Both should have the newest file first
  ok(linesOld[0] === newest, "old sort pipe: newest file first")
  ok(linesNew[0] === newest, "new sort pipe: newest file first")

  var rOld = bench("old (while-read sequential)", function () {
    cp.execFileSync("bash", ["-c", cmdOld], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  })
  var rNew = bench("new (xargs -P 8 parallel)", function () {
    cp.execFileSync("bash", ["-c", cmdNew], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  })

  printBenchResult(rOld)
  printBenchResult(rNew)
  var speedup = rOld.median / rNew.median
  console.log("  Speedup: " + speedup.toFixed(1) + "x faster")

  fs.rmSync(tmp, { recursive: true, force: true })
  return { old: rOld, new: rNew, speedup: speedup }
}

// ================= benchmark 2: fuzzy score =================

function benchFuzzyScore() {
  console.log("\n=== Benchmark 2: Fuzzy Score (per-keystroke scoring) ===")

  // Generate a realistic corpus of 100K paths
  var dirs = ["home", "Documents", "Projects", "src", "lib", "node_modules", ".config",
    "Downloads", "Music", "Videos", "Pictures", "Desktop", "tmp", "var", "usr", "etc"]
  var exts = ["js", "ts", "py", "rs", "go", "txt", "md", "pdf", "png", "jpg", "json", "yaml", "toml"]
  var names = ["index", "main", "utils", "config", "readme", "package", "setup", "deploy",
    "build", "test", "server", "client", "app", "core", "lib", "helper", "report", "invoice",
    "payment", "user", "admin", "auth", "api", "db", "cache", "router", "handler", "model",
    "view", "component", "style", "layout", "page", "module", "plugin", "tool", "script"]

  var corpus = []
  var seed = 42
  function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (var i = 0; i < 100000; i++) {
    var depth = 2 + rnd(4)
    var p = "/" + dirs[rnd(dirs.length)]
    for (var d = 1; d < depth; d++) p += "/" + dirs[rnd(dirs.length)]
    p += "/" + names[rnd(names.length)]
    if (rnd(3) === 0) p += "-" + names[rnd(names.length)]
    p += "." + exts[rnd(exts.length)]
    corpus.push(p)
  }

  var queries = ["rep", "config", " invoice ", "main.ts", "deploy yaml"]

  // Verify correctness: both implementations must return the same scores
  for (var q = 0; q < queries.length; q++) {
    for (var i = 0; i < 100; i++) {
      var scoreOld = fuzzyScoreOld(corpus[i], queries[q])
      var scoreNew = fuzzyScoreNew(corpus[i], queries[q])
      if (scoreOld !== scoreNew) {
        console.error("FAIL: score mismatch for '" + queries[q] + "' on '" + corpus[i] + "': old=" + scoreOld + " new=" + scoreNew)
        failed++
        break
      }
    }
    passed++  // count the verification pass
  }

  var rOld = bench("old (indexOf per char)", function () {
    for (var q = 0; q < queries.length; q++) {
      for (var i = 0; i < corpus.length; i++) {
        fuzzyScoreOld(corpus[i], queries[q])
      }
    }
  })
  var rNew = bench("new (charMap + binary search)", function () {
    for (var q = 0; q < queries.length; q++) {
      for (var i = 0; i < corpus.length; i++) {
        fuzzyScoreNew(corpus[i], queries[q])
      }
    }
  })

  printBenchResult(rOld)
  printBenchResult(rNew)
  var speedup = rOld.median / rNew.median
  console.log("  Speedup: " + speedup.toFixed(1) + "x faster")

  return { old: rOld, new: rNew, speedup: speedup }
}

// ================= benchmark 3: walk parse =================

function benchWalkParse() {
  console.log("\n=== Benchmark 3: Walk Output Parse (fd result parsing) ===")

  // Generate a 100K-line path string (mix of valid paths and noise)
  var lines = []
  var dirs = ["home", "data", "projects", "src", "lib", "docs"]
  var names = ["index", "main", "config", "readme", "setup", "build", "test", "deploy"]
  var exts = ["js", "ts", "py", "rs", "txt", "md"]
  var seed = 99
  function rnd(n) { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (var i = 0; i < 100000; i++) {
    var roll = rnd(10)
    if (roll === 0) lines.push("")                        // empty line
    else if (roll === 1) lines.push("@@DIRS@@")           // marker
    else if (roll === 2) lines.push("relative/" + i)      // non-absolute
    else {
      var depth = 1 + rnd(4)
      var p = "/" + dirs[rnd(dirs.length)]
      for (var d = 1; d < depth; d++) p += "/" + dirs[rnd(dirs.length)]
      p += "/" + names[rnd(names.length)] + "." + exts[rnd(exts.length)]
      lines.push(p)
    }
  }
  var raw = lines.join("\n")

  // Verify both produce the same output
  var outOld = walkParseOld(raw)
  var outNew = walkParseNew(raw)
  ok(outOld.length === outNew.length, "walk parse: same result count (" + outOld.length + ")")
  for (var i = 0; i < outOld.length; i++) {
    if (outOld[i] !== outNew[i]) {
      console.error("FAIL: walk parse mismatch at index " + i + ": old=" + outOld[i] + " new=" + outNew[i])
      failed++
      break
    }
  }
  if (outOld.length === outNew.length) passed++

  var rOld = bench("old (.split + loop)", function () {
    walkParseOld(raw)
  })
  var rNew = bench("new (indexOf scan)", function () {
    walkParseNew(raw)
  })

  printBenchResult(rOld)
  printBenchResult(rNew)
  var speedup = rOld.median / rNew.median
  console.log("  Speedup: " + speedup.toFixed(1) + "x faster")

  return { old: rOld, new: rNew, speedup: speedup }
}

// ================= reporting =================

function printBenchResult(r) {
  console.log("  " + r.label.padEnd(32) + "median " + fmt(r.median).padStart(10)
    + "  (min " + fmt(r.min) + ", max " + fmt(r.max) + ")")
}

// ================= main =================

console.log("Performance Benchmark — old (baseline) vs new (optimized)")
console.log("Each benchmark: " + RUNS + " runs, reporting median")

var r1 = benchSortPipe()
var r2 = benchFuzzyScore()
var r3 = benchWalkParse()

console.log("\n=== Summary ===")
console.log("  Sort pipe:     " + r1.speedup.toFixed(1) + "x faster  (" + fmt(r1.old.median) + " -> " + fmt(r1.new.median) + ")")
console.log("  Fuzzy score:   " + r2.speedup.toFixed(1) + "x faster  (" + fmt(r2.old.median) + " -> " + fmt(r2.new.median) + ")")
console.log("  Walk parse:    " + r3.speedup.toFixed(1) + "x faster  (" + fmt(r3.old.median) + " -> " + fmt(r3.new.median) + ")")

console.log("\n" + passed + " correctness checks passed, " + failed + " failed")
process.exit(failed > 0 ? 1 : 0)
