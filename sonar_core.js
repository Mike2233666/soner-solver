/*
 * sonar_core.js — 声纳搜潜求解核心（浏览器 / Node 通用）
 *
 * 规则（v2）：
 *   n×n 棋盘；潜艇长度是一个数列（可重复），横放或竖放、宽 1；
 *   潜艇之间不能重叠，默认也不能八邻接（一艘潜艇周围 8 格不会有别的潜艇）；
 *   炸到潜艇只显示“这一格命中”，不会显示整艘；
 *   一艘潜艇的所有格子都被炸中，它才算被击沉（这时才会被抓出来）。
 *   目标：用最少的炸弹把全部潜艇击沉。
 *
 * 求解：
 *   维护“与当前所有反馈一致的布局”的均匀分布；
 *   统计每格 pOcc = 该格属于某艘未击沉潜艇的概率；
 *   击中一格是纯收益、打空是纯浪费 → 选点让命中率尽量高：
 *     · 有“待收尾”的命中格 → 优先贴着它补枪（潜艇是连续的）；
 *     · 全图搜索阶段 → 只在稀疏的斜格网（按最短潜艇长度取模）上炸，
 *       保证每艘潜艇必然被扫到一次，避免相邻格重复浪费。
 */
(function (global) {
  'use strict';

  var H = 0;
  var V = 1;
  var placementCache = new Map();

  function now() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function makePlacements(n, len) {
    var out = [];
    var r, c, i;
    for (r = 0; r < n; r++) {
      for (c = 0; c + len <= n; c++) {
        var hcells = new Array(len);
        for (i = 0; i < len; i++) hcells[i] = r * n + c + i;
        out.push({ len: len, r: r, c: c, dir: H, cells: hcells });
      }
    }
    for (r = 0; r + len <= n; r++) {
      for (c = 0; c < n; c++) {
        var vcells = new Array(len);
        for (i = 0; i < len; i++) vcells[i] = (r + i) * n + c;
        out.push({ len: len, r: r, c: c, dir: V, cells: vcells });
      }
    }
    return out;
  }

  function placements(n, len) {
    var key = n + ':' + len;
    var list = placementCache.get(key);
    if (!list) {
      list = makePlacements(n, len);
      placementCache.set(key, list);
    }
    return list;
  }

  function neighborhood(n, cells) {
    var own = new Set(cells);
    var out = new Set();
    for (var idx = 0; idx < cells.length; idx++) {
      var cell = cells[idx];
      var r = Math.floor(cell / n);
      var c = cell % n;
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          var rr = r + dr;
          var cc = c + dc;
          if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
          var q = rr * n + cc;
          if (!own.has(q)) out.add(q);
        }
      }
    }
    return Array.from(out);
  }

  function normalizeShipCells(n, cells) {
    if (!Array.isArray(cells) || cells.length === 0) throw new Error('潜艇格子不能为空');
    var seen = new Set();
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!Number.isInteger(c) || c < 0 || c >= n * n) throw new Error('潜艇格子超出棋盘');
      if (seen.has(c)) throw new Error('潜艇格子重复');
      seen.add(c);
    }
    var arr = Array.from(seen).sort(function (a, b) { return a - b; });
    var rows = new Set();
    var cols = new Set();
    for (var j = 0; j < arr.length; j++) {
      rows.add(Math.floor(arr[j] / n));
      cols.add(arr[j] % n);
    }
    if (rows.size === 1) {
      for (var k = 1; k < arr.length; k++) if (arr[k] !== arr[k - 1] + 1) throw new Error('潜艇格子必须连续');
    } else if (cols.size === 1) {
      for (var m = 1; m < arr.length; m++) if (arr[m] !== arr[m - 1] + n) throw new Error('潜艇格子必须连续');
    } else {
      throw new Error('潜艇必须是同一行或同一列的连续格子');
    }
    return arr;
  }

  function shipsTouch(n, a, b) {
    for (var i = 0; i < a.length; i++) {
      var ar = Math.floor(a[i] / n);
      var ac = a[i] % n;
      for (var j = 0; j < b.length; j++) {
        var br = Math.floor(b[j] / n);
        var bc = b[j] % n;
        if (Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1) return true;
      }
    }
    return false;
  }

  class Game {
    constructor(n, lengths, options) {
      options = options || {};
      this.n = n;
      this.lengths = lengths.slice().map(Number).sort(function (a, b) { return b - a; });
      this.noTouch = options.noTouch !== false;
      this.shots = [];   // {cell, result:'hit'|'miss'}
      this.sunk = [];    // {cells:[...]} 已确认击沉的潜艇
      this.createdAt = Date.now();
    }

    clone() {
      var g = new Game(this.n, this.lengths, { noTouch: this.noTouch });
      g.shots = JSON.parse(JSON.stringify(this.shots));
      g.sunk = JSON.parse(JSON.stringify(this.sunk));
      return g;
    }

    toJSON() {
      return {
        n: this.n,
        lengths: this.lengths.slice(),
        noTouch: this.noTouch,
        shots: JSON.parse(JSON.stringify(this.shots)),
        sunk: JSON.parse(JSON.stringify(this.sunk))
      };
    }

    static fromJSON(obj) {
      var g = new Game(obj.n, obj.lengths, { noTouch: obj.noTouch });
      g.shots = JSON.parse(JSON.stringify(obj.shots || []));
      g.sunk = JSON.parse(JSON.stringify(obj.sunk || []));
      return g;
    }
  }

  function derive(game) {
    var n = game.n;
    var N = n * n;
    if (!Number.isInteger(n) || n < 2) throw new Error('棋盘边长 n 至少为 2');
    var lengths = game.lengths;
    if (!Array.isArray(lengths) || lengths.length === 0) throw new Error('请至少给出一艘潜艇的长度');
    var totalArea = 0;
    for (var i = 0; i < lengths.length; i++) {
      var len = lengths[i];
      if (!Number.isInteger(len) || len < 1 || len > n) throw new Error('潜艇长度必须在 1..' + n + ' 之间');
      totalArea += len;
    }
    if (totalArea > N) throw new Error('潜艇总面积超过棋盘');

    var water = new Uint8Array(N);
    var hit = new Uint8Array(N);
    var known = new Uint8Array(N);
    var shot = new Uint8Array(N);

    for (var s = 0; s < game.shots.length; s++) {
      var sh = game.shots[s];
      var cell = sh.cell;
      if (!Number.isInteger(cell) || cell < 0 || cell >= N) throw new Error('投弹坐标超出棋盘');
      if (shot[cell]) throw new Error('该格已经投过弹了');
      shot[cell] = 1;
      if (sh.result === 'miss') water[cell] = 1;
      else if (sh.result === 'hit') hit[cell] = 1;
      else throw new Error('未知的投弹结果');
    }

    // 已击沉的潜艇：验证 + 标记
    var sunkShips = [];
    for (var u = 0; u < game.sunk.length; u++) {
      var cells = normalizeShipCells(n, game.sunk[u].cells);
      for (var v = 0; v < cells.length; v++) {
        var cc = cells[v];
        if (water[cc]) throw new Error('已击沉的潜艇与“未命中”记录矛盾');
        if (known[cc]) throw new Error('两艘已击沉潜艇的格子重叠了');
        known[cc] = 1;
      }
      sunkShips.push({ cells: cells, len: cells.length });
    }
    for (var a = 0; a < sunkShips.length; a++) {
      for (var b = 0; b < sunkShips[a].cells.length; b++) {
        // 已确认的潜艇，其格子视为“已命中”（v1 里是显示整艘，格子同样已知）
        hit[sunkShips[a].cells[b]] = 1;
      }
      for (var d2 = a + 1; d2 < sunkShips.length; d2++) {
        if (shipsTouch(n, sunkShips[a].cells, sunkShips[d2].cells)) {
          throw new Error('两艘已击沉的潜艇相邻（规则要求八角格内不能有其它潜艇）');
        }
      }
    }
    if (game.noTouch) {
      for (var f = 0; f < sunkShips.length; f++) {
        var nb = neighborhood(n, sunkShips[f].cells);
        for (var t = 0; t < nb.length; t++) water[nb[t]] = 1;
      }
    }

    // 剩余长度
    var remaining = lengths.slice().sort(function (x, y) { return y - x; });
    for (var g = 0; g < sunkShips.length; g++) {
      var idx = remaining.indexOf(sunkShips[g].len);
      if (idx < 0) throw new Error('已击沉潜艇的长度 ' + sunkShips[g].len + ' 不在给出的长度数列里');
      remaining.splice(idx, 1);
    }

    var unsunkHits = [];
    for (var h = 0; h < N; h++) {
      if (hit[h] && !known[h]) unsunkHits.push(h);
    }
    if (remaining.length === 0 && unsunkHits.length > 0) {
      throw new Error('潜艇已全部击沉，但仍有不属于它们的命中格');
    }

    // 候选位置：不能压在已排除区、已被已知潜艇占的格上
    var candidates = new Map();
    for (var r2 = 0; r2 < remaining.length; r2++) {
      var l2 = remaining[r2];
      if (candidates.has(l2)) continue;
      var list = [];
      var base = placements(n, l2);
      for (var pi = 0; pi < base.length; pi++) {
        var pl = base[pi];
        var okPlace = true;
        for (var ci = 0; ci < pl.cells.length; ci++) {
          var cellp = pl.cells[ci];
          if (water[cellp] || known[cellp]) { okPlace = false; break; }
        }
        if (!okPlace) continue;
        list.push({
          cells: pl.cells,
          cover: game.noTouch ? pl.cells.concat(neighborhood(n, pl.cells)) : pl.cells,
          r: pl.r, c: pl.c, dir: pl.dir
        });
      }
      if (list.length === 0) throw new Error('当前反馈下没有可放置长度 ' + l2 + ' 的位置，记录可能有矛盾');
      candidates.set(l2, list);
    }

    return {
      n: n,
      N: N,
      noTouch: game.noTouch,
      water: water,
      hit: hit,
      known: known,
      shot: shot,
      sunkShips: sunkShips,
      unsunkHits: unsunkHits,
      remaining: remaining,
      candidates: candidates
    };
  }

  var TOO_MANY = { tooMany: true };

  /* ---------- 精确枚举 ---------- */
  function exactCounts(d, nodeCap) {
    var k = d.remaining.length;
    var N = d.N;
    if (k === 0) {
      return { total: 1, countsOcc: new Float64Array(N), configs: [{}], nodes: 0 };
    }
    var lists = d.remaining.map(function (len) { return d.candidates.get(len); });
    for (var i = 0; i < lists.length; i++) if (!lists[i] || !lists[i].length) return null;
    var order = lists.map(function (l, idx) { return idx; });
    order.sort(function (a, b) { return lists[a].length - lists[b].length; });

    var used = new Int32Array(N);
    var hitIndex = new Map();
    d.unsunkHits.forEach(function (c, idx) { hitIndex.set(c, idx); });
    var hitCovered = new Int32Array(d.unsunkHits.length);
    var countsOcc = new Float64Array(N);
    var total = 0;
    var nodes = 0;
    var chosen = new Array(k);

    function addMarks(item, sign) {
      var cov = item.cover;
      for (var i2 = 0; i2 < cov.length; i2++) used[cov[i2]] += sign;
      var cells = item.cells;
      for (var j2 = 0; j2 < cells.length; j2++) {
        var hi = hitIndex.get(cells[j2]);
        if (hi !== undefined) hitCovered[hi] += sign;
      }
    }

    function dfs(depth) {
      nodes++;
      if (nodes > nodeCap) throw TOO_MANY;
      if (depth === k) {
        for (var i3 = 0; i3 < hitCovered.length; i3++) if (hitCovered[i3] === 0) return;
        total++;
        for (var s3 = 0; s3 < chosen.length; s3++) {
          var cells3 = chosen[s3].cells;
          for (var d3 = 0; d3 < cells3.length; d3++) countsOcc[cells3[d3]]++;
        }
        return;
      }
      var list = lists[order[depth]];
      for (var pi = 0; pi < list.length; pi++) {
        var item = list[pi];
        var ok = true;
        for (var ci = 0; ci < item.cells.length; ci++) {
          if (used[item.cells[ci]]) { ok = false; break; }
        }
        if (!ok) continue;
        chosen[depth] = item;
        addMarks(item, 1);
        dfs(depth + 1);
        addMarks(item, -1);
      }
    }

    try {
      dfs(0);
    } catch (err) {
      if (err === TOO_MANY) return null;
      throw err;
    }
    if (total === 0) return null;
    return { total: total, countsOcc: countsOcc, nodes: nodes };
  }

  /* ---------- 拒绝采样 ---------- */
  function sampleCounts(d, options) {
    options = options || {};
    var N = d.N;
    var k = d.remaining.length;
    if (k === 0) return { total: 1, countsOcc: new Float64Array(N), sunkSets: null, attempts: 0 };

    var lists = d.remaining.map(function (len) { return d.candidates.get(len); });
    for (var i = 0; i < lists.length; i++) if (!lists[i].length) return null;

    var hitMask = new Uint8Array(N);
    for (var h = 0; h < d.unsunkHits.length; h++) hitMask[d.unsunkHits[h]] = 1;

    var stamp = new Int32Array(N);
    var hitStamp = new Int32Array(N);
    var countsOcc = new Float64Array(N);
    var epoch = 0;
    var total = 0;
    var attempts = 0;
    var target = options.samples || 6000;
    var timeMs = options.timeMs || 260;
    var maxAttempts = options.maxAttempts || 400000;
    var t0 = now();
    var picks = new Array(k);
    var sunkTally = options.trackSunk ? new Map() : null;

    while (total < target && attempts < maxAttempts) {
      if ((attempts & 255) === 0 && now() - t0 > timeMs) break;
      attempts++;
      epoch++;
      var ok = true;
      for (var s = 0; s < k; s++) {
        var list = lists[s];
        var item = list[(Math.random() * list.length) | 0];
        var cells = item.cells;
        for (var c = 0; c < cells.length; c++) {
          if (stamp[cells[c]] === epoch) { ok = false; break; }
        }
        if (!ok) break;
        var cov = item.cover;
        for (var m = 0; m < cov.length; m++) stamp[cov[m]] = epoch;
        for (var n2 = 0; n2 < cells.length; n2++) {
          if (hitMask[cells[n2]]) hitStamp[cells[n2]] = epoch;
        }
        picks[s] = item;
      }
      if (!ok) continue;
      var allHits = true;
      for (var o = 0; o < d.unsunkHits.length; o++) {
        if (hitStamp[d.unsunkHits[o]] !== epoch) { allHits = false; break; }
      }
      if (!allHits) continue;
      total++;
      var sig = null;
      if (sunkTally) sig = [];
      for (var p = 0; p < k; p++) {
        var it = picks[p];
        for (var r = 0; r < it.cells.length; r++) countsOcc[it.cells[r]]++;
        if (sunkTally) {
          var full = true;
          for (var q = 0; q < it.cells.length; q++) {
            if (!hitMask[it.cells[q]]) { full = false; break; }
          }
          if (full) sig.push(it.cells.join(','));
        }
      }
      if (sunkTally) {
        sig.sort();
        var key = sig.join('|');
        sunkTally.set(key, (sunkTally.get(key) || 0) + 1);
      }
    }
    if (total === 0) return null;
    return {
      total: total,
      countsOcc: countsOcc,
      sunkSets: sunkTally,
      attainable: attempts,
      attempts: attempts
    };
  }

  /* ---------- 推断“已经全部命中”的潜艇 ---------- */
  function inferSunk(d, res, minShare) {
    if (!res.sunkSets || res.sunkSets.size === 0) return [];
    minShare = minShare || 0.995;
    var bestKey = null;
    var bestCount = 0;
    res.sunkSets.forEach(function (count, key) {
      if (count > bestCount) { bestCount = count; bestKey = key; }
    });
    if (!bestKey) return [];
    if (bestCount / res.total < minShare) return [];
    if (bestKey === '') return [];
    var cellsList = bestKey.split('|').map(function (txt) {
      return txt.split(',').map(Number);
    });
    // 长度必须能在剩余长度里逐个扣掉
    var pool = d.remaining.slice();
    for (var i = 0; i < cellsList.length; i++) {
      var idx = pool.indexOf(cellsList[i].length);
      if (idx < 0) return [];
      pool.splice(idx, 1);
    }
    return cellsList.map(function (cells) { return { cells: cells }; });
  }

  /* ---------- 选点 ---------- */
  function adjacentToHit(d, cell) {
    var n = d.n;
    var r = Math.floor(cell / n);
    var c = cell % n;
    var dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var i = 0; i < dirs.length; i++) {
      var rr = r + dirs[i][0];
      var cc = c + dirs[i][1];
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
      var q = rr * n + cc;
      if (d.hit[q] && !d.known[q]) return true;
    }
    return false;
  }

  function collinearHit(d, cell) {
    var n = d.n;
    var r = Math.floor(cell / n);
    var c = cell % n;
    var horiz = false;
    var vert = false;
    if (c > 0 && d.hit[cell - 1] && !d.known[cell - 1]) horiz = true;
    if (c < n - 1 && d.hit[cell + 1] && !d.known[cell + 1]) horiz = true;
    if (r > 0 && d.hit[cell - n] && !d.known[cell - n]) vert = true;
    if (r < n - 1 && d.hit[cell + n] && !d.known[cell + n]) vert = true;
    return horiz || vert;
  }

  function chooseShot(d, pOcc, strategy) {
    var n = d.n;
    var N = d.N;
    var cand = [];
    for (var cell = 0; cell < N; cell++) {
      if (d.shot[cell] || d.water[cell] || d.known[cell]) continue;
      if (pOcc[cell] <= 1e-12) continue;
      cand.push(cell);
    }
    if (!cand.length) return null;

    var center = (n - 1) / 2;
    function pickFrom(pool) {
      var best = null;
      for (var i = 0; i < pool.length; i++) {
        var c2 = pool[i];
        var p2 = pOcc[c2];
        var dist = Math.abs(Math.floor(c2 / n) - center) + Math.abs((c2 % n) - center);
        if (!best || p2 > best.p + 1e-12 ||
            (Math.abs(p2 - best.p) <= 1e-12 && dist < best.dist)) {
          best = { cell: c2, p: p2, dist: dist };
        }
      }
      return best;
    }

    if (strategy === 'greedy') return pickFrom(cand);

    // 收尾阶段：贴着已知命中格补枪
    var frontier = cand.filter(function (c) { return adjacentToHit(d, c); });
    if (frontier.length) {
      if (strategy === 'align' || strategy === 'smart' || strategy === 'hybrid') {
        var aligned = frontier.filter(function (c) { return collinearHit(d, c); });
        if (aligned.length) return pickFrom(aligned);
      }
      return pickFrom(frontier);
    }

    // 搜索阶段：只在稀疏斜格网上炸（按最短潜艇长度取模）
    var lmin = Math.min.apply(null, d.remaining);
    var useParity = strategy === 'parity' || strategy === 'smart' ||
      (strategy === 'hybrid' && lmin >= 3);
    if (useParity && lmin > 1) {
      var mass = new Float64Array(lmin);
      cand.forEach(function (c) {
        mass[(Math.floor(c / n) + (c % n)) % lmin] += pOcc[c];
      });
      var bestRes = 0;
      for (var r = 1; r < lmin; r++) if (mass[r] > mass[bestRes]) bestRes = r;
      var filtered = cand.filter(function (c) {
        return ((Math.floor(c / n) + (c % n)) % lmin) === bestRes;
      });
      if (filtered.length) return pickFrom(filtered);
    }
    return pickFrom(cand);
  }

  function analyze(game, options) {
    options = options || {};
    var t0 = now();
    var strategy = options.strategy || 'align';
    var sunkList = game.sunk.map(function (s) { return { cells: s.cells.slice() }; });
    var inferredCells = [];

    var d = derive(cloneWithSunk(game, sunkList));
    if (d.remaining.length === 0) {
      return finishedResult(d, sunkList, t0);
    }

    var res = countsFor(d, options);
    if (!res) {
      // 采样失败：可能矛盾，也可能是极端紧的局面
      throw new Error('找不到任何符合当前反馈的潜艇布局，记录可能有矛盾，请撤销后检查');
    }

    // 推断已经整艘命中却没被报告的潜艇（例如手动记录时忘了标记）
    if (sunkList.length < sunkList.length + 1 && res.sunkSets) {
      var inferred = inferSunk(d, res, options.sunkThreshold || 0.995);
      if (inferred.length) {
        var trial = sunkList.concat(inferred);
        try {
          var d2 = derive(cloneWithSunk(game, trial));
          var res2 = countsFor(d2, options);
          if (res2) {
            sunkList = trial;
            d = d2;
            res = res2;
            inferredCells = inferred.map(function (s) { return s.cells; });
          }
        } catch (e) { /* 推断不成立，忽略 */ }
      }
    }

    if (d.remaining.length === 0) {
      var out = finishedResult(d, sunkList, t0);
      out.inferredSunk = inferredCells;
      return out;
    }

    var total = res.total;
    var N = d.N;
    var pOcc = new Float64Array(N);
    for (var c1 = 0; c1 < N; c1++) if (res.countsOcc[c1]) pOcc[c1] = res.countsOcc[c1] / total;

    var pick = chooseShot(d, pOcc, strategy);
    var top = [];
    if (pick) {
      var ranked = [];
      for (var c2 = 0; c2 < N; c2++) {
        if (d.shot[c2] || d.water[c2] || d.known[c2]) continue;
        if (pOcc[c2] <= 1e-12) continue;
        ranked.push({ cell: c2, p: pOcc[c2] });
      }
      ranked.sort(function (a, b) { return b.p - a.p; });
      for (var t1 = 0; t1 < Math.min(4, ranked.length); t1++) {
        top.push({
          r: Math.floor(ranked[t1].cell / d.n) + 1,
          c: ranked[t1].cell % d.n + 1,
          pOcc: ranked[t1].p
        });
      }
    }

    return {
      ok: true,
      done: pick === null,
      ruleVersion: 2,
      noTouch: d.noTouch,
      n: d.n,
      remainingLengths: d.remaining.slice(),
      sunkShips: sunkList,
      inferredSunk: inferredCells,
      unsunkHits: d.unsunkHits.slice(),
      pOcc: pOcc,
      best: pick ? {
        cell: pick.cell,
        r: Math.floor(pick.cell / d.n) + 1,
        c: pick.cell % d.n + 1,
        pOcc: pick.p
      } : null,
      top: top,
      method: res.method || 'sample',
      samples: total,
      elapsedMs: now() - t0,
      water: d.water,
      hit: d.hit,
      known: d.known,
      shot: d.shot
    };
  }

  function cloneWithSunk(game, sunkList) {
    var g = new Game(game.n, game.lengths, { noTouch: game.noTouch });
    g.shots = game.shots;
    g.sunk = sunkList;
    return g;
  }

  function countsFor(d, options) {
    var k = d.remaining.length;
    var lists = d.remaining.map(function (len) { return d.candidates.get(len); });
    var product = 1;
    for (var i = 0; i < lists.length; i++) {
      product *= lists[i].length;
      if (product > 1e15) break;
    }
    var res = null;
    if (k <= 3 || product <= 60000) {
      res = exactCounts(d, options.nodeCap || 240000);
      if (res) {
        res.method = 'exact';
        res.sunkSets = null;
        return res;
      }
    }
    res = sampleCounts(d, {
      samples: options.samples || 6000,
      timeMs: options.timeMs || 260,
      trackSunk: true
    });
    if (res) res.method = 'sample';
    return res;
  }

  function finishedResult(d, sunkList, t0) {
    return {
      ok: true,
      done: true,
      ruleVersion: 2,
      noTouch: d.noTouch,
      n: d.n,
      remainingLengths: [],
      sunkShips: sunkList,
      inferredSunk: [],
      unsunkHits: [],
      pOcc: new Float64Array(d.N),
      best: null,
      top: [],
      method: 'done',
      samples: 0,
      elapsedMs: now() - t0,
      water: d.water,
      hit: d.hit,
      known: d.known,
      shot: d.shot
    };
  }

  function randomBoard(n, lengths, noTouch) {
    var lists = lengths.map(function (len) {
      return placements(n, len).map(function (pl) {
        return { cells: pl.cells, cover: noTouch ? pl.cells.concat(neighborhood(n, pl.cells)) : pl.cells };
      });
    });
    for (var attempt = 0; attempt < 60000; attempt++) {
      var used = new Uint8Array(n * n);
      var picks = [];
      var ok = true;
      for (var s = 0; s < lists.length; s++) {
        var list = lists[s];
        var item = list[(Math.random() * list.length) | 0];
        for (var c = 0; c < item.cells.length; c++) {
          if (used[item.cells[c]]) { ok = false; break; }
        }
        if (!ok) break;
        for (var m = 0; m < item.cover.length; m++) used[item.cover[m]] = 1;
        picks.push(item.cells.slice());
      }
      if (ok) return picks;
    }
    throw new Error('随机布局生成失败：潜艇太多或棋盘太小');
  }

  var api = {
    Game: Game,
    derive: derive,
    analyze: analyze,
    randomBoard: randomBoard,
    placements: placements,
    neighborhood: neighborhood,
    normalizeShipCells: normalizeShipCells,
    shipsTouch: shipsTouch,
    adjacentToHit: adjacentToHit
  };

  global.SonarCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
