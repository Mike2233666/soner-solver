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

    // 每个“命中但未击沉”的格子都必须能被某个候选位置覆盖，否则记录本身就矛盾。
    // 最常见的来源是把坐标记错了：例如把已排除格（未命中格／已击沉潜艇的八角邻格）
    // 或概率为 0 的格子记成了命中。给出具体行列，避免只报一句“找不到布局”。
    if (unsunkHits.length) {
      var coverable = new Uint8Array(N);
      candidates.forEach(function (list2) {
        for (var li = 0; li < list2.length; li++) {
          var cs = list2[li].cells;
          for (var cj = 0; cj < cs.length; cj++) coverable[cs[cj]] = 1;
        }
      });
      for (var uh = 0; uh < unsunkHits.length; uh++) {
        var hc = unsunkHits[uh];
        if (coverable[hc]) continue;
        var hr = Math.floor(hc / n) + 1;
        var hcc = hc % n + 1;
        throw new Error('第 ' + hr + ' 行第 ' + hcc + ' 列记为“命中”，但按当前记录这里不可能有潜艇' +
          (water[hc] ? '（它已经被排除：是未命中格，或是已击沉潜艇的八角邻格）' : '（剩下的潜艇没有任何摆放会覆盖这一格）') +
          '。八成是坐标点错了，请撤销这一发后核对');
      }
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
      clusters: hitClusters(n, unsunkHits, game.noTouch),
      remaining: remaining,
      candidates: candidates
    };
  }

  var TOO_MANY = { tooMany: true };

  /* ---------- 命中簇 ----------
   * 规则 v2 不许潜艇八邻接 ⇒ 两个八邻相接的命中格不可能分属两艘潜艇，
   * 所以一串连在一起的命中必须是同一艘船盖住的（而且它们得落在同一条直线上）。
   * 这条约束比“每格都能被某艘船单独覆盖”强得多，紧局面能不能算出来全靠它：
   * 例如竖着连炸 5 格，就只剩“长度 ≥5 的船贴着这一列摆”这一条路。 */
  function hitClusters(n, unsunkHits, noTouch) {
    var hitMask = new Uint8Array(n * n);
    for (var i = 0; i < unsunkHits.length; i++) hitMask[unsunkHits[i]] = 1;
    var seen = new Uint8Array(n * n);
    var clusters = [];
    for (var j = 0; j < unsunkHits.length; j++) {
      var start = unsunkHits[j];
      if (seen[start]) continue;
      seen[start] = 1;
      var group = [];
      var stack = [start];
      while (stack.length) {
        var cell = stack.pop();
        group.push(cell);
        if (!noTouch) continue; // 潜艇可以相邻时，相邻两格命中也可能分属两艘船
        var r0 = Math.floor(cell / n), c0 = cell % n;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            var rr = r0 + dr, cc = c0 + dc;
            if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
            var nb = rr * n + cc;
            if (hitMask[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
          }
        }
      }
      group.sort(function (a, b) { return a - b; });
      clusters.push(group);
    }
    clusters.sort(function (a, b) { return b.length - a.length; });
    return clusters;
  }

  /* ---------- 精确枚举 ---------- */
  /* 返回：
   *   null                      —— 某个长度没有任何候选位置（记录矛盾，交给上层判断）
   *   { capped: true }           —— 节点预算烧完，没算完（不代表无解）
   *   { capped: false, total, countsOcc, nodes } —— 算完了；total 可能是 0（真的是矛盾）
   *
   * 两个加速点：
   * 1) 候选位置最少（最受限）的长度先放，DFS 剪枝效率高得多；
   *      实测 10×10 [5,4,4,3,2,2]、13 个未标击沉的命中格：按长度顺序 50 万+ 节点，
   *      按“最受限优先”只要 3.3 万节点。
   * 2) 同样长度的潜艇只有“候选下标递增”这一种排列参与枚举，
   *      避免把同一套布局按 2! 种船序重复数一遍（概率不变，节点数减半）。
   */
  function exactCounts(d, nodeCap, trackSunk) {
    var k = d.remaining.length;
    var N = d.N;
    if (k === 0) {
      return { capped: false, total: 1, countsOcc: new Float64Array(N), nodes: 0, sunkSets: null };
    }
    var lists = d.remaining.map(function (len) { return d.candidates.get(len); });
    for (var i = 0; i < lists.length; i++) if (!lists[i] || !lists[i].length) return null;
    var order = lists.map(function (l, idx) { return idx; });
    // 候选少的先放；候选数相同的按长度降序，保证“同长度”相邻（便于下面的去重）
    order.sort(function (a, b) {
      return (lists[a].length - lists[b].length) || (d.remaining[b] - d.remaining[a]);
    });

    var used = new Int32Array(N);
    var hitIndex = new Map();
    d.unsunkHits.forEach(function (c, idx) { hitIndex.set(c, idx); });
    var hitMask = new Uint8Array(N);
    for (var hm = 0; hm < d.unsunkHits.length; hm++) hitMask[d.unsunkHits[hm]] = 1;
    var hitCovered = new Int32Array(d.unsunkHits.length);
    var countsOcc = new Float64Array(N);
    var total = 0;
    var nodes = 0;
    var chosen = new Array(k);
    var pickedIdx = new Array(k);
    // 精确枚举同样统计“哪些船在所有命中格上已经炸满”，供上层自动推断击沉
    var sunkTally = trackSunk ? new Map() : null;

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
        if (sunkTally) {
          var sig = [];
          for (var s4 = 0; s4 < chosen.length; s4++) {
            var cells4 = chosen[s4].cells;
            var full = true;
            for (var f4 = 0; f4 < cells4.length; f4++) if (!hitMask[cells4[f4]]) { full = false; break; }
            if (full) sig.push(cells4.join(','));
          }
          sig.sort();
          var key = sig.join('|');
          sunkTally.set(key, (sunkTally.get(key) || 0) + 1);
        }
        return;
      }
      var listIdx = order[depth];
      var list = lists[listIdx];
      // 与前一个位置是同一长度时，只允许更大的候选下标（同长度船互为排列，算一次即可）
      var first = 0;
      if (depth > 0 && d.remaining[order[depth - 1]] === d.remaining[listIdx]) {
        first = pickedIdx[depth - 1] + 1;
      }
      for (var pi = first; pi < list.length; pi++) {
        var item = list[pi];
        var ok = true;
        for (var ci = 0; ci < item.cells.length; ci++) {
          if (used[item.cells[ci]]) { ok = false; break; }
        }
        if (!ok) continue;
        chosen[depth] = item;
        pickedIdx[depth] = pi;
        addMarks(item, 1);
        dfs(depth + 1);
        addMarks(item, -1);
      }
    }

    try {
      dfs(0);
    } catch (err) {
      if (err === TOO_MANY) return { capped: true, nodes: nodes };
      throw err;
    }
    return { capped: false, total: total, countsOcc: countsOcc, nodes: nodes, sunkSets: sunkTally };
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

  /* 记录矛盾时的提示：能定位到具体那一串命中格就定位，定位不出来再给通用说法。 */
  function contradictionError(d, info) {
    var ci = info && info.cluster;
    if (ci !== undefined && ci !== null && ci >= 0 && d.clusters && d.clusters[ci]) {
      var group = d.clusters[ci];
      var n = d.n;
      var rr = Math.floor(group[0] / n) + 1;
      var cc = group[0] % n + 1;
      var lens = d.remaining.slice().sort(function (a, b) { return b - a; }).join(',');
      return new Error('找不到任何符合当前记录的潜艇布局：从第 ' + rr + ' 行第 ' + cc + ' 列起连着 ' +
        group.length + ' 格的这一串命中，剩下的潜艇（长度 ' + lens +
        '）没有任何摆放能一次盖住它（潜艇是一整条，八邻接的命中格只能属于同一艘船）。八成是坐标点错了，请撤销最后一发后核对');
    }
    return new Error('找不到任何符合当前记录的潜艇布局：记录之间互相矛盾（坐标记错也会这样），请撤销最后一发后核对');
  }

  function analyze(game, options) {
    options = options || {};
    options.deadline = options.deadline || (now() + (options.timeBudgetMs || 700));
    var t0 = now();
    var strategy = options.strategy || 'align';
    var sunkList = game.sunk.map(function (s) { return { cells: s.cells.slice() }; });
    var inferredCells = [];

    var d = derive(cloneWithSunk(game, sunkList));
    if (d.remaining.length === 0) {
      return finishedResult(d, sunkList, t0);
    }

    var res = countsFor(d, options);
    if (res && res.contradiction) {
      // 矛盾已经确认，但也许还能说清楚是哪一串命中出了问题（精确枚举只会说“没有布局”）
      if (res.cluster === undefined) {
        var cp = clusterSearch(d, {
          samples: 1,
          walkNodes: options.anyNodeCap || 400000,
          timeMs: 500,
          trackSunk: false
        });
        if (cp && cp.total === 0 && !cp.truncated && cp.deadCluster >= 0) {
          res = { contradiction: true, cluster: cp.deadCluster };
        }
      }
      throw contradictionError(d, res);
    }
    if (res && res.capped) res = null;
    if (!res) {
      // 最后再确认一次：是真的没有布局（矛盾），还是纯粹算不完。
      // 命中簇引擎能明确回答“某一串命中没有任何船能盖住”，那就是坐标记错了。
      var probe = clusterSearch(d, { samples: 1, walkNodes: options.anyNodeCap || 400000, timeMs: 500, trackSunk: false });
      if (probe && probe.deadCluster >= 0 && probe.total === 0 && !probe.truncated) {
        throw contradictionError(d, { contradiction: true, cluster: probe.deadCluster });
      }
      throw new Error('这个局面实在太大，暂时算不出概率（这不是记录矛盾）：先随便再炸一格缩小范围，或者把棋盘/潜艇配置改小一点再试');
    }

    // 推断已经整艘命中却没被报告的潜艇（例如手动记录时忘了标记）
    if (sunkList.length < sunkList.length + 1 && res.sunkSets && !res.approx) {
      var inferred = inferSunk(d, res, options.sunkThreshold || 0.995);
      if (inferred.length) {
        var trial = sunkList.concat(inferred);
        try {
          var d2 = derive(cloneWithSunk(game, trial));
          var res2 = countsFor(d2, options);
          if (res2 && !res2.contradiction && !res2.capped) {
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

  /* ---------- 命中簇引擎 ----------
   * 拒绝采样是「整盘随机摆一遍再校验」，命中格一串一串时几乎抽不中：
   * 例如竖着连炸 5 格，只有长度 ≥5 的潜艇正好贴在那一列才算数，接受率低到 1e-4 以下。
   * 这里换个顺序解题：先把每一串命中格盖上（一串必须由同一艘船盖住），再摆剩下的船。
   * - 命中簇用 MRV 顺序处理：先盖最难凑的那一串，且只考虑“一次盖住整簇”的位置；
   * - 剩下的船随机摆放（回溯 + 剪枝），摆满一套记一次；
   * 命中簇分支数通常只有个位数，所以既快又几乎不会空手而归。
   * 命中簇分支之间按枚举完整与否是精确的；簇分支内部是随机采样，分布近似均匀，
   * 但只有在“精确枚举算不完”的局面才会走到这里。
   * 另外它还负责回答一个重要问题：某一串命中到底有没有船能盖住 ——
   * 没有的话就是记录真的矛盾（能指出是哪一串），而不是“算不出来”。 */
  function clusterSearch(d, options) {
    options = options || {};
    var N = d.N;
    var clusters = d.clusters || [];
    var k = d.remaining.length;
    var lengths = d.remaining.slice();
    var lists = lengths.map(function (len) { return d.candidates.get(len); });
    for (var i = 0; i < lists.length; i++) if (!lists[i] || !lists[i].length) {
      return { total: 0, countsOcc: new Float64Array(N), deadCluster: 0, nodes: 0 };
    }

    // (长度, 簇) → 能一次盖住整簇的候选下标；按需缓存
    var coverIdx = new Map();
    function covering(len, ci) {
      var key = len + ':' + ci;
      var got = coverIdx.get(key);
      if (got) return got;
      var group = clusters[ci];
      var out = [];
      var list = d.candidates.get(len) || [];
      for (var p = 0; p < list.length; p++) {
        var cells = list[p].cells;
        var all = true;
        for (var g = 0; g < group.length; g++) {
          if (cells.indexOf(group[g]) < 0) { all = false; break; }
        }
        if (all) out.push(p);
      }
      coverIdx.set(key, out);
      return out;
    }

    var hitMask = new Uint8Array(N);
    for (var hm = 0; hm < d.unsunkHits.length; hm++) hitMask[d.unsunkHits[hm]] = 1;

    var used = new Int32Array(N);
    var covered = new Uint8Array(clusters.length);
    var uncoveredCount = clusters.length;
    var countsOcc = new Float64Array(N);
    var sunkTally = options.trackSunk ? new Map() : null;
    var slotCells = new Array(k);
    var total = 0;
    var nodes = 0;
    var deadCluster = -1;
    var truncated = false;
    var slotPickIdx = new Array(k);
    for (var sq = 0; sq < k; sq++) slotPickIdx[sq] = -1;
    var target = options.maxLayouts || options.samples || 6000;
    var nodeCap = options.walkNodes || 400000;
    var timeMs = options.timeMs || 400;
    var t0 = now();

    function overlaps(item) {
      var cells = item.cells;
      for (var q = 0; q < cells.length; q++) if (used[cells[q]]) return true;
      return false;
    }
    function mark(item, sign) {
      var cov = item.cover;
      for (var q = 0; q < cov.length; q++) used[cov[q]] += sign;
    }
    function clusterInside(item, ci) {
      var group = clusters[ci], cells = item.cells;
      for (var g = 0; g < group.length; g++) if (cells.indexOf(group[g]) < 0) return false;
      return true;
    }
    function alive() {
      nodes++;
      if (nodes > nodeCap) { truncated = true; return false; }
      if ((nodes & 15) === 0 && now() - t0 > timeMs) { truncated = true; return false; }
      if (total >= target) { truncated = true; return false; } // 到上限就停（不再抽样，纯保护）
      return true;
    }

    // 同长度的船互为排列：只保留“下标递增”这一种分配，
    // 同一套布局就不会被重复数 k! 次（均匀性不变，节点数少一大截）。
    function canonical(slotS, pi) {
      for (var q = 0; q < k; q++) {
        if (q === slotS || slotPickIdx[q] < 0) continue;
        if (lengths[q] !== lengths[slotS]) continue;
        if (q < slotS ? slotPickIdx[q] >= pi : slotPickIdx[q] <= pi) return false;
      }
      return true;
    }

    function recordLeaf() {
      total++;
      for (var s = 0; s < k; s++) {
        var cs = slotCells[s];
        if (!cs) continue;
        for (var q = 0; q < cs.length; q++) countsOcc[cs[q]]++;
      }
      if (sunkTally) {
        var sig = [];
        for (var s2 = 0; s2 < k; s2++) {
          var cs2 = slotCells[s2];
          if (!cs2) continue;
          var full = true;
          for (var f2 = 0; f2 < cs2.length; f2++) if (!hitMask[cs2[f2]]) { full = false; break; }
          if (full) sig.push(cs2.join(','));
        }
        sig.sort();
        var key = sig.join('|');
        sunkTally.set(key, (sunkTally.get(key) || 0) + 1);
      }
    }

    // 命中簇都盖住了：剩下的船按顺序穷举（不是抽样），摆满一套记一次 —— 这样计数是精确的
    function placeRest() {
      if (!alive()) return;
      var slot = -1;
      for (var s = 0; s < k; s++) if (!slotCells[s]) { slot = s; break; }
      if (slot < 0) { recordLeaf(); return; }
      var list = lists[slot];
      for (var pi = 0; pi < list.length; pi++) {
        if (nodes > nodeCap) { truncated = true; return; }
        if ((pi & 63) === 0 && now() - t0 > timeMs) { truncated = true; return; }
        var item = list[pi];
        if (overlaps(item)) continue;
        if (!canonical(slot, pi)) continue;
        mark(item, 1);
        slotCells[slot] = item.cells;
        slotPickIdx[slot] = pi;
        placeRest();
        slotPickIdx[slot] = -1;
        slotCells[slot] = null;
        mark(item, -1);
      }
    }

    // 逐个盖住命中簇：把所有“哪艘船 × 哪个位置”都试一遍（只排序，不剪分支）。
    // 注意：这里不能只试“选项最少的那艘”——那只是启发式，会把好不容易能凑成的分支跳过，
    // 从而把“这套记录没问题”误判成矛盾。选项少的先试，但全都要试到。
    function coverClusters() {
      if (!alive()) return;
      if (uncoveredCount === 0) { placeRest(); return; }
      var ci = -1;
      for (var c = 0; c < clusters.length; c++) if (!covered[c]) { ci = c; break; }

      var choices = []; // 每项：[slot, 候选下标]
      for (var s = 0; s < k; s++) {
        if (slotCells[s]) continue;
        var cand = covering(lengths[s], ci);
        for (var o = 0; o < cand.length; o++) {
          if (overlaps(lists[s][cand[o]])) continue;
          if (!canonical(s, cand[o])) continue;
          choices.push([s, cand[o]]);
        }
      }
      if (!choices.length) {
        // 剩下的船没有任何摆放能盖住这一簇 → 这条分支没戏（全部分支都没戏才是真矛盾）
        if (deadCluster < 0) deadCluster = ci;
        return;
      }
      // 选项少的先试（启发式只影响顺序，不影响结果）
      choices.sort(function (a, b) { return (a[1] - b[1]) || (a[0] - b[0]); });
      for (var step = 0; step < choices.length; step++) {
        if (nodes > nodeCap) { truncated = true; return; }
        if ((step & 63) === 0 && now() - t0 > timeMs) { truncated = true; return; }
        var pick = choices[step];
        var slotS = pick[0];
        var item = lists[slotS][pick[1]];
        mark(item, 1);
        slotCells[slotS] = item.cells;
        slotPickIdx[slotS] = pick[1];
        var newly = null;
        for (var c2 = 0; c2 < clusters.length; c2++) {
          if (covered[c2]) continue;
          if (clusterInside(item, c2)) {
            covered[c2] = 1;
            uncoveredCount--;
            (newly || (newly = [])).push(c2);
          }
        }
        coverClusters();
        if (newly) {
          for (var n2 = 0; n2 < newly.length; n2++) { covered[newly[n2]] = 0; uncoveredCount++; }
        }
        slotPickIdx[slotS] = -1;
        slotCells[slotS] = null;
        mark(item, -1);
      }
    }

    coverClusters();
    return {
      total: total,
      countsOcc: countsOcc,
      sunkSets: sunkTally,
      nodes: nodes,
      truncated: truncated,
      deadCluster: (!truncated && total === 0) ? deadCluster : -1
    };
  }

  function countsFor(d, options) {
    // 界面里每记录一次都会算一遍，所以留一个总时间预算：宁可样本少一点，也别卡住操作。
    var deadline = options.deadline || (now() + (options.timeBudgetMs || 700));
    function left() { return deadline - now(); }
    var k = d.remaining.length;
    var lists = d.remaining.map(function (len) { return d.candidates.get(len); });
    var product = 1;
    for (var i = 0; i < lists.length; i++) {
      if (!lists[i] || !lists[i].length) return { contradiction: true };
      product *= lists[i].length;
      if (product > 1e15) break;
    }
    // 1) 先按小预算试精确枚举：DFS 剪枝很强，product 很大也常常几万节点就算完，
    //    所以不再用 product 判断“要不要算”，只用来决定给多大预算。
    var tight = (k <= 3 || product <= 60000);
    var quick = exactCounts(d, options.nodeCap || (tight ? 240000 : 80000), true);
    if (quick === null) return { contradiction: true };
    if (!quick.capped) {
      if (quick.total > 0) {
        quick.method = 'exact';
        return quick;
      }
      // 枚举跑完了却一套布局都没有 → 记录确实矛盾
      return { contradiction: true };
    }

    // 2) 空间很大、命中又成串时，拒绝采样几乎抽不中（一竖串 5 格就只有“长 5 的船贴着那列”
    //    这一条路，接受率 < 1e-4），所以这种情况先走命中簇引擎。
    var biggestCluster = (d.clusters && d.clusters.length) ? d.clusters[0].length : 0;
    var preferCluster = product > 1e6 && biggestCluster >= 2;
    var clustered = null;
    function tryCluster() {
      clustered = clusterSearch(d, {
        maxLayouts: options.clusterSamples || 20000000,
        timeMs: options.clusterTimeMs || Math.max(80, Math.min(350, left())),
        walkNodes: options.walkNodes || 300000,
        trackSunk: true
      });
      if (clustered && !clustered.truncated) {
        if (clustered.total > 0) {
          clustered.method = 'cluster';
          return clustered;
        }
        if (clustered.deadCluster >= 0) return { contradiction: true, cluster: clustered.deadCluster };
      }
      return null; // 没跑完（截断）→ 这次的结果不算数
    }
    if (preferCluster) {
      var viaCluster = tryCluster();
      if (viaCluster) return viaCluster;
    }

    // 3) 均匀拒绝采样（宽松局面下最常用的路径，样本严格均匀）
    var res = sampleCounts(d, {
      samples: options.samples || 6000,
      timeMs: options.timeMs || Math.max(60, Math.min(320, left())),
      trackSunk: true
    });
    // 样本够多就直接用（严格均匀）；太少就是噪声，宁可再试精确路径
    var enoughSamples = options.minSamples || 200;
    if (res && res.total >= enoughSamples) { res.method = 'sample'; return res; }

    // 4) 样本不够 / 一套都没抽到 → 命中簇优先的精确枚举（结果精确，且顺带能给击沉推断）
    if (!preferCluster) {
      var viaCluster2 = tryCluster();
      if (viaCluster2 && viaCluster2.contradiction) return viaCluster2;
      if (viaCluster2) return viaCluster2;
    }
    if (res && res.total >= 40) { res.method = 'sample'; return res; }

    // 5) 再赌一次精确枚举（有点紧的局面靠剪枝其实跑得完）
    if (left() >= 120) {
      var deep = exactCounts(d, options.deepNodeCap || 900000, true);
      if (deep === null) return { contradiction: true };
      if (!deep.capped) {
        if (deep.total > 0) {
          deep.method = 'exact';
          return deep;
        }
        return { contradiction: true };
      }
    }

    // 6) 精确枚举都没跑完、样本又太少：拿命中簇枚举的半成品当近似结果。
    //    它比“算不出来”有用得多——至少能指出大概哪片区域更可能有船，
    //    界面会标明“近似”，不会是精确概率。
    if (clustered && clustered.total > 0) {
      clustered.method = 'cluster-approx';
      clustered.approx = true;
      return clustered;
    }
    if (res && res.total > 0) { res.method = 'sample'; res.approx = true; return res; }
    return null; // 实在算不出来，也不能断言是矛盾（上层会再确认一遍）
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
    adjacentToHit: adjacentToHit,
    countsFor: countsFor,
    clusterSearch: clusterSearch,
    exactCounts: exactCounts,
    hitClusters: hitClusters
  };

  global.SonarCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
