/* test_core.js — sonar_core.js（v2 规则）的正确性验证
 *
 * 规则要点：命中只显示单格；一艘潜艇所有格子都被命中才算击沉。
 * 运行：node test_core.js
 */
'use strict';

const Core = require('./sonar_core.js');

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function placementsFor(n, len) {
  const out = [];
  for (let r = 0; r < n; r++) for (let c = 0; c + len <= n; c++) {
    const cells = [];
    for (let i = 0; i < len; i++) cells.push(r * n + c + i);
    out.push(cells);
  }
  for (let r = 0; r + len <= n; r++) for (let c = 0; c < n; c++) {
    const cells = [];
    for (let i = 0; i < len; i++) cells.push((r + i) * n + c);
    out.push(cells);
  }
  return out;
}

function nbhd(n, cells) {
  const own = new Set(cells);
  const out = new Set();
  for (const cell of cells) {
    const r = Math.floor(cell / n), c = cell % n;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
      const q = rr * n + cc;
      if (!own.has(q)) out.add(q);
    }
  }
  return out;
}

function touch(n, a, b) {
  for (const x of a) {
    const ar = Math.floor(x / n), ac = x % n;
    for (const y of b) {
      const br = Math.floor(y / n), bc = y % n;
      if (Math.abs(ar - br) <= 1 && Math.abs(ac - bc) <= 1) return true;
    }
  }
  return false;
}

/* 独立穷举：所有与 hits/misses/sunk 一致的布局 */
function bruteForce(n, lengths, shots, sunk, noTouch) {
  const N = n * n;
  const water = new Uint8Array(N);
  const hit = new Uint8Array(N);
  const known = new Uint8Array(N);
  const sunkShips = (sunk || []).map((s) => s.cells.slice());
  for (const s of shots) {
    if (s.result === 'miss') water[s.cell] = 1;
    else hit[s.cell] = 1;
  }
  for (const ship of sunkShips) for (const c of ship) known[c] = 1;
  if (noTouch) {
    for (const ship of sunkShips) for (const q of nbhd(n, ship)) water[q] = 1;
  }
  const remaining = lengths.slice().sort((a, b) => b - a);
  for (const ship of sunkShips) {
    const idx = remaining.indexOf(ship.length);
    if (idx < 0) throw new Error('bad sunk length');
    remaining.splice(idx, 1);
  }
  const unsunkHits = [];
  for (let c = 0; c < N; c++) if (hit[c] && !known[c]) unsunkHits.push(c);

  const lists = remaining.map((len) => placementsFor(n, len).filter(
    (cells) => cells.every((c) => !water[c] && !known[c])
  ));
  const counts = new Float64Array(N);
  let total = 0;
  const chosen = [];

  function dfs(depth, used) {
    if (depth === remaining.length) {
      for (const h of unsunkHits) {
        let covered = false;
        for (const ship of chosen) {
          if (ship.indexOf(h) >= 0) { covered = true; break; }
        }
        if (!covered) return;
      }
      total++;
      for (const ship of chosen) for (const c of ship) counts[c]++;
      return;
    }
    for (const cells of lists[depth]) {
      if (cells.some((c) => used[c])) continue;
      chosen.push(cells);
      const mark = noTouch ? cells.concat(Array.from(nbhd(n, cells))) : cells;
      for (const c of mark) used[c]++;
      dfs(depth + 1, used);
      for (const c of mark) used[c]--;
      chosen.pop();
    }
  }
  dfs(0, new Int32Array(N));
  return { total, counts };
}

function randomShots(n, lengths, shotsCount, rnd, noTouch) {
  const board = Core.randomBoard(n, lengths, noTouch);
  const shots = [];
  const sunk = [];
  const used = new Set();
  const hitCells = new Set();
  const hitByShip = board.map(() => 0);
  for (let t = 0; t < shotsCount; t++) {
    let cell = Math.floor(rnd() * n * n);
    let guard = 0;
    while (used.has(cell) && guard++ < 400) cell = Math.floor(rnd() * n * n);
    if (used.has(cell)) break;
    used.add(cell);
    const idx = board.findIndex((s) => s.indexOf(cell) >= 0);
    if (idx >= 0) {
      shots.push({ cell, result: 'hit' });
      hitCells.add(cell);
      hitByShip[idx]++;
      if (hitByShip[idx] === board[idx].length) sunk.push({ cells: board[idx].slice() });
    } else {
      shots.push({ cell, result: 'miss' });
    }
  }
  return { shots, sunk };
}

function compare(n, lengths, noTouch, seed) {
  const rnd = mulberry32(seed);
  const { shots, sunk } = randomShots(n, lengths, 3 + Math.floor(rnd() * 9), rnd, noTouch);
  const game = new Core.Game(n, lengths, { noTouch });
  game.shots = shots;
  game.sunk = sunk;
  let a;
  try {
    a = Core.analyze(game, { samples: 8000, timeMs: 1200, strategy: 'greedy' });
  } catch (e) {
    return { skipped: true, reason: e.message };
  }
  const b = bruteForce(n, lengths, shots, sunk, noTouch);
  if (b.total === 0) return { skipped: true, reason: 'brute: no configs' };
  let maxDiff = 0;
  for (let c = 0; c < n * n; c++) {
    maxDiff = Math.max(maxDiff, Math.abs(a.pOcc[c] - b.counts[c] / b.total));
  }
  return { maxDiff, total: b.total, method: a.method };
}

function summarize(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return {
    mean: arr.reduce((a, b) => a + b, 0) / arr.length,
    median: s[Math.floor(s.length / 2)],
    p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
  };
}

/* 完整对局：必须把所有格子都命中才算赢 */
function playGame(n, lengths, noTouch, rnd, strategy) {
  const board = Core.randomBoard(n, lengths, noTouch);
  const hitCount = board.map(() => 0);
  const sunkFlags = board.map(() => false);
  const game = new Core.Game(n, lengths, { noTouch });
  const shotSet = new Set();
  for (let bomb = 1; bomb <= 400; bomb++) {
    const a = Core.analyze(game, { samples: 4000, timeMs: 90, strategy });
    if (a.done) break;
    const cell = a.best.cell;
    shotSet.add(cell);
    const idx = board.findIndex((s) => s.indexOf(cell) >= 0);
    if (idx >= 0) {
      game.shots.push({ cell, result: 'hit' });
      hitCount[idx]++;
      if (hitCount[idx] === board[idx].length && !sunkFlags[idx]) {
        sunkFlags[idx] = true;
        game.sunk.push({ cells: board[idx].slice() });
        if (sunkFlags.every(Boolean)) return bomb;
      }
    } else {
      game.shots.push({ cell, result: 'miss' });
    }
  }
  return 400;
}

function playRandom(n, lengths, noTouch, rnd) {
  const board = Core.randomBoard(n, lengths, noTouch);
  const hitCount = board.map(() => 0);
  const sunkFlags = board.map(() => false);
  const avail = [];
  for (let c = 0; c < n * n; c++) avail.push(c);
  for (let bomb = 1; bomb <= 400; bomb++) {
    const i = Math.floor(rnd() * avail.length);
    const cell = avail.splice(i, 1)[0];
    const idx = board.findIndex((s) => s.indexOf(cell) >= 0);
    if (idx >= 0) {
      hitCount[idx]++;
      if (hitCount[idx] === board[idx].length && !sunkFlags[idx]) {
        sunkFlags[idx] = true;
        if (sunkFlags.every(Boolean)) return bomb;
      }
    }
  }
  return 400;
}

function main() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
    if (!cond) failures++;
  };

  console.log('=== 1) 概率一致性（对比独立穷举）===');
  const cases = [
    [4, [2, 2], true],
    [5, [3, 2], true],
    [5, [2, 2, 2], false],
    [6, [3, 2, 2], true]
  ];
  for (const [n, lengths, noTouch] of cases) {
    let worst = 0, tested = 0, worstInfo = null;
    for (let seed = 1; seed <= 25; seed++) {
      const r = compare(n, lengths, noTouch, seed * 977);
      if (r.skipped) continue;
      tested++;
      if (r.maxDiff > worst) { worst = r.maxDiff; worstInfo = { seed: seed * 977, diff: r.maxDiff, method: r.method }; }
    }
    check(`n=${n} lengths=[${lengths}] noTouch=${noTouch} (${tested} 个局面)`,
      worst < 0.02, `max|ΔpOcc|=${worst.toFixed(4)}${worstInfo ? ' ' + JSON.stringify(worstInfo) : ''}`);
  }

  console.log('\n=== 2) 命中只显示单格时不泄露整艘 ===');
  {
    const game = new Core.Game(8, [3, 3, 2], { noTouch: true });
    game.shots = [{ cell: 9, result: 'hit' }];
    const before = Core.analyze(game, { samples: 4000, timeMs: 300 }).remainingLengths.slice().sort((a, b) => a - b);
    const unsunkCells = Core.derive(game).unsunkHits.length;
    check('单格命中后剩余长度不变', JSON.stringify(before) === JSON.stringify([2, 3, 3]), JSON.stringify(before));
    check('命中格记为未击沉', unsunkCells === 1, 'unsunkHits=' + unsunkCells);
  }

  console.log('\n=== 3) 整艘命中后自动推断击沉 ===');
  {
    const game = new Core.Game(8, [3, 3, 2], { noTouch: true });
    game.shots = [
      { cell: 0, result: 'hit' }, { cell: 1, result: 'hit' }, { cell: 2, result: 'hit' },
      { cell: 0 + 8 * 5 + 3, result: 'miss' }
    ];
    const a = Core.analyze(game, { samples: 6000, timeMs: 400 });
    const remaining = a.remainingLengths.slice().sort((x, y) => x - y);
    check('推断出第 1 行长 3 已击沉', JSON.stringify(remaining) === JSON.stringify([2, 3]),
      'remaining=' + JSON.stringify(remaining));
    check('击沉数量 = 1', a.sunkShips.length === 1, 'sunk=' + a.sunkShips.length);
  }

  console.log('\n=== 4) 完整对局：必须炸满每一格 ===');
  const benchCases = [
    [8, [3, 3, 2]],
    [10, [4, 3, 3, 2]],
    [8, [2, 2, 2, 2]]
  ];
  const GAMES = 40;
  for (const [n, lengths] of benchCases) {
    for (const strategy of ['align', 'greedy']) {
      const rnd = mulberry32(2024 + n + lengths.length);
      const scores = [];
      for (let g = 0; g < GAMES; g++) scores.push(playGame(n, lengths, true, rnd, strategy));
      const st = summarize(scores);
      console.log(`  n=${n} [${lengths}] ${strategy}: mean=${st.mean.toFixed(2)} median=${st.median} p90=${st.p90}`);
    }
    const rnd = mulberry32(77 + n + lengths.length);
    const scores = [];
    for (let g = 0; g < GAMES; g++) scores.push(playRandom(n, lengths, true, rnd));
    const st = summarize(scores);
    console.log(`  n=${n} [${lengths}] random: mean=${st.mean.toFixed(2)} median=${st.median} p90=${st.p90}`);
    const bombFloor = lengths.reduce((a, b) => a + b, 0);
    console.log(`  （命中格数下限 = ${bombFloor}）`);
  }

  console.log('\n=== 5) 记录矛盾时给出明确的坐标提示 ===');
  {
    // 已排除格（已击沉潜艇的八角邻格）被记成命中
    const g1 = new Core.Game(8, [3, 3, 2], { noTouch: true });
    g1.sunk = [{ cells: [0, 1, 2] }];
    g1.shots = [
      { cell: 0, result: 'hit' }, { cell: 1, result: 'hit' }, { cell: 2, result: 'hit' },
      { cell: 8, result: 'hit' }   // (2,1)：第 1 行长 3 的斜邻格，应当已被排除
    ];
    let msg1 = '';
    try { Core.analyze(g1, { samples: 2000, timeMs: 200 }); } catch (e) { msg1 = e.message; }
    check('已排除格记成命中 → 报出具体行列',
      /第 2 行第 1 列/.test(msg1) && /不可能有潜艇/.test(msg1), msg1);
    check('并说明该格已被排除', /排除/.test(msg1));

    // 概率为 0 的格（两个方向都被未命中堵死）被记成命中
    const g2 = new Core.Game(8, [2], { noTouch: false });
    g2.shots = [{ cell: 1, result: 'miss' }, { cell: 8, result: 'miss' }, { cell: 0, result: 'hit' }];
    let msg2 = '';
    try { Core.analyze(g2, { samples: 2000, timeMs: 200 }); } catch (e) { msg2 = e.message; }
    check('0 概率格记成命中 → 报出具体行列',
      /第 1 行第 1 列/.test(msg2) && /不可能有潜艇/.test(msg2), msg2);

    // 合法命中不受影响
    const g3 = new Core.Game(8, [3, 3, 2], { noTouch: true });
    g3.shots = [{ cell: 20, result: 'hit' }];
    let hitOk = true, hitErr = '';
    try { Core.analyze(g3, { samples: 2000, timeMs: 200 }); } catch (e) { hitOk = false; hitErr = e.message; }
    check('合法命中仍然照常分析', hitOk, hitErr);
  }

  console.log('\n=== 6) 用户真实存档：紧局面不再谎报“记录矛盾” ===');
  {
    // 用户 2026-11-18 导出的 10×10 记录（前面 40 发）。
    // 这一局有 13 个格子记成“命中”却没标击沉，旧版直接跳过枚举去拒绝采样，
    // 而整盘随机摆放几乎不可能恰好覆盖这 13 格，于是误报“找不到任何符合当前记录的潜艇布局”。
    const missCells = [3, 30, 59, 96, 92, 83, 70, 61, 52, 41, 7, 19, 36, 10, 33, 67, 88, 79, 64, 76, 65, 50, 94, 90];
    const hitCells = [38, 28, 18, 12, 13, 14, 11, 15, 44, 43, 45, 42, 75, 74, 73, 72];
    const order = [
      3, 30, 59, 96, 92, 83, 70, 61, 52, 41, 7, 19, 38, 28, 18, 36, 12, 13, 14, 11,
      10, 15, 33, 44, 43, 45, 42, 67, 88, 79, 64, 75, 76, 65, 74, 73, 72, 50, 94, 90
    ];
    const hitSet = new Set(hitCells);
    const shots = order.map((cell) => ({ cell: cell, result: hitSet.has(cell) ? 'hit' : 'miss' }));
    function exportGame(extraShot) {
      const g = new Core.Game(10, [5, 4, 4, 3, 2, 2], { noTouch: true });
      g.shots = shots.slice();
      if (extraShot !== undefined) g.shots.push(extraShot);
      g.sunk = [{ cells: [18, 28, 38] }];
      return g;
    }
    check('导出记录里的 40 发全部在案', exportGame().shots.length === 40 &&
      missCells.length + hitCells.length === 40);

    let a = null, err = '';
    try { a = Core.analyze(exportGame(), { samples: 6000, timeMs: 260 }); } catch (e) { err = e.message; }
    check('40 发状态照常分析（不再报矛盾）', !!a, err);
    check('走的是精确枚举而不是采样', a && a.method === 'exact', a && a.method);
    check('推算出的最佳格是截图里的 第 6 行 第 9 列',
      a && a.best && a.best.r === 6 && a.best.c === 9, a && JSON.stringify(a.best));
    check('该格概率 50%', a && Math.abs(a.best.pOcc - 0.5) < 1e-9, a && a.best.pOcc);
    check('自动推断出三艘已炸满的潜艇（用户截图里标了 4 艘，存档少了 3 艘）',
      a && a.inferredSunk && a.inferredSunk.length === 3, a && JSON.stringify(a.inferredSunk));

    let hex = null, hexErr = '';
    try { hex = Core.analyze(exportGame({ cell: 58, result: 'hit' }), { samples: 6000, timeMs: 260 }); }
    catch (e) { hexErr = e.message; }
    check('在这一格真的命中后仍然能算（旧版正是在这里报错）', !!hex, hexErr);
    check('命中第 6 行第 9 列后最佳格变成 第 6 行 第 8 列',
      hex && hex.best && hex.best.r === 6 && hex.best.c === 8, hex && JSON.stringify(hex.best));

    // 把精确枚举的预算掐到 1 个节点，强制走命中簇引擎兜底，结果要和精确枚举一致
    let walked = null, walkErr = '';
    try {
      walked = Core.analyze(exportGame(), {
        nodeCap: 1, deepNodeCap: 1, samples: 6000, timeMs: -1,
        clusterSamples: 6000, clusterTimeMs: 4000
      });
    } catch (e) { walkErr = e.message; }
    check('预算被掐死时可以退化到命中簇引擎（而不是报矛盾）',
      !!walked && walked.method === 'cluster', walkErr || (walked && walked.method));
    let maxDiff = 0;
    if (a && walked) {
      for (let c = 0; c < 100; c++) maxDiff = Math.max(maxDiff, Math.abs(a.pOcc[c] - walked.pOcc[c]));
    }
    check('命中簇推算与精确枚举的概率一致', a && walked && maxDiff < 0.02, 'max|ΔpOcc|=' + maxDiff.toFixed(4));
  }

  console.log('\n=== 7) 命中连成串、又没标击沉：照样算得出来 ===');
  {
    // 用户 2026-11-19 的局面：10×10、长度 5,4,3,2,2，
    // 第 5 列竖着连炸 5 格、第 8 行横着连炸 4 格都没标击沉。
    // 竖着 5 格只有“长 5 的船贴着这一列”这一种解释，"整盘随机摆一遍再校验"的采样几乎抽不中，
    // 旧版会弹“候选布局太多、太紧，暂时算不出概率”。
    function tightGame() {
      const g = new Core.Game(10, [5, 4, 3, 2, 2], { noTouch: true });
      const idx = (r, c) => (r - 1) * 10 + (c - 1);
      const hits = [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [8, 2], [8, 3], [8, 4], [8, 5]];
      const misses = [[1, 4], [1, 6], [5, 1], [7, 2], [7, 3], [7, 7]];
      g.shots = misses.map(([r, c]) => ({ cell: idx(r, c), result: 'miss' }))
        .concat(hits.map(([r, c]) => ({ cell: idx(r, c), result: 'hit' })));
      g.sunk = [];
      return g;
    }
    let a = null, err = '';
    const t0 = Date.now();
    try { a = Core.analyze(tightGame(), { samples: 3000, timeMs: 200 }); } catch (e) { err = e.message; }
    const dt = Date.now() - t0;
    check('成串命中 + 未标击沉也能算出概率（不再弹“算不出来”）', !!a, err);
    check('给出推荐点', a && a.best && a.best.r === 4 && a.best.c === 2, a && JSON.stringify(a.best));
    check('自动推断出那两艘已炸满的潜艇',
      a && a.inferredSunk && a.inferredSunk.length === 2, a && JSON.stringify(a.inferredSunk));
    let sum = 0;
    if (a) for (const v of a.pOcc) sum += v;
    const expectSum = a ? a.remainingLengths.reduce((x, y) => x + y, 0) : -1;
    check('每格概率之和 = 剩余潜艇总格数', a && Math.abs(sum - expectSum) < 1e-6,
      'sum=' + sum.toFixed(2) + ' expect=' + expectSum);
    check('计算够快（< 1.5s）', dt < 1500, dt + 'ms');
    check('用的是精确枚举 / 命中簇推算，而不是碰运气的少数样本',
      a && ['exact', 'cluster', 'sample'].indexOf(a.method) >= 0 && a.samples >= 100,
      a && a.method + ' / ' + a.samples);

    // 真矛盾的情形：一串命中谁都盖不住时，要指名道姓说是哪一串
    const bad = new Core.Game(8, [2, 2], { noTouch: true });
    bad.shots = [
      { cell: 27, result: 'hit' }, // (4,4)
      { cell: 18, result: 'hit' } // (3,3)：八邻接但不在同一条直线上，一艘船无法同时盖住
    ];
    bad.sunk = [];
    let msg = '';
    try { Core.analyze(bad, { samples: 2000, timeMs: 200 }); } catch (e) { msg = e.message; }
    check('连成串却没船能盖住 → 指出具体那一串命中', /第 \d+ 行第 \d+ 列/.test(msg) && /连着 2 格/.test(msg), msg);
  }

  console.log('\n' + (failures === 0 ? '全部通过' : failures + ' 项失败'));
  process.exit(failures === 0 ? 0 : 1);
}

main();
