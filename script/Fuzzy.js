// Client-side fuzzy matching over walk baselines: scoring, fzf-style AND
// filtering with a bounded top-N selector, and warm-refilter eligibility.
// Dependency-free.

// Smart-case subsequence score for one term: contiguity and boundary bonuses;
// the greedy chain is retried from each early occurrence of the term's
// initial char so anchored matches beat scattered ones. -1 when unmatched.
function fuzzyScore(line, query) {
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

function isWordChar(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
    || c === "_"
}

// fzf --filter-style: terms AND together, ties keep input order, blank query
// passes all. Bounded top-N selector keeps output identical to full sort+slice
// without the scored array (runs per keystroke over six-figure baselines).
function fuzzyFilterRows(rows, query, limit) {
  var list = Array.isArray(rows) ? rows : []
  var capped = typeof limit === "number" && isFinite(limit) && limit > 0
  var terms = String(query == null ? "" : query).trim().split(/\s+/).filter(function (t) { return t })
  if (terms.length === 0) return capped ? list.slice(0, limit) : list.slice()
  var best = []
  var minAt = -1
  for (var i = 0; i < list.length; i++) {
    var total = 0
    var miss = false
    for (var t = 0; t < terms.length; t++) {
      var s = fuzzyScore(String(list[i]), terms[t])
      if (s < 0) { miss = true; break }
      total += s
    }
    if (miss) continue
    if (!capped || best.length < limit) {
      best.push({ row: list[i], score: total, i: i })
      // Track the eviction candidate: lowest score, highest index — exactly
      // the entry a full stable sort would place last inside the cap.
      if (capped && (minAt < 0 || total <= best[minAt].score)) minAt = best.length - 1
    } else if (total > best[minAt].score) {
      // Later indexes lose ties by construction, so equal scores never
      // displace an incumbent.
      best[minAt] = { row: list[i], score: total, i: i }
      minAt = 0
      for (var k = 1; k < best.length; k++) {
        var bScore = best[k].score
        if (bScore < best[minAt].score || (bScore === best[minAt].score && best[k].i > best[minAt].i)) minAt = k
      }
    }
  }
  best.sort(function (a, b) { return b.score - a.score || a.i - b.i })
  var out = []
  for (var j = 0; j < best.length; j++) out.push(best[j].row)
  return out
}

// Warm-refilter universe: only while typing EXTENDS the previous staged text
// is the old match set complete (narrowing needs no baseline pass); widening,
// an incomplete cache or a blank predecessor refuse. Empty stays usable.
function warmCandidates(matches, prevStaged, nextStaged, complete) {
  if (!complete || !Array.isArray(matches)) return null
  var prev = String(prevStaged == null ? "" : prevStaged)
  if (!prev) return null
  var next = String(nextStaged == null ? "" : nextStaged)
  if (next.indexOf(prev) !== 0) return null
  return matches
}

if (typeof module !== "undefined") {
  module.exports = {
    fuzzyScore: fuzzyScore,
    isWordChar: isWordChar,
    fuzzyFilterRows: fuzzyFilterRows,
    warmCandidates: warmCandidates
  }
}
