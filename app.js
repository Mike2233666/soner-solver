/*
 * app.js — 界面逻辑（规则 v2：命中只显示单格，整艘命中才击沉）
 *          含：存档续玩、导入导出、记分板、自动演示
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var STORAGE_KEY = 'sonar_v2_save';
  var STRATEGY = 'align';

  var state = {
    game: null,
    mode: 'game',
    hidden: null,      // 自动对局：真实布局 [{cells, hits, sunk}]
    pendingCell: null,
    selecting: false,
    selected: [],
    autoTimer: null,
    analysis: null,
    error: '',
    log: [],
    stats: { shots: 0, agreed: 0, hits: 0 },
    ghost: null,       // 自动对局：求解器同局面的完整用弹数
    ghostBusy: false,
    ghostToken: 0,
    savedAt: null,
    restored: false
  };

  function cellName(n, cell) {
    return '第 ' + (Math.floor(cell / n) + 1) + ' 行 第 ' + (cell % n + 1) + ' 列';
  }

  function parseLengths(text) {
    var parts = String(text).split(/[\s,，、;；]+/).filter(Boolean);
    if (!parts.length) throw new Error('请填写潜艇长度，例如 4,3,3,2');
    var out = parts.map(Number);
    for (var i = 0; i < out.length; i++) {
      if (!Number.isInteger(out[i]) || out[i] < 1) throw new Error('潜艇长度必须是正整数');
    }
    return out;
  }

  var HEAT_STOPS = [
    [0.00, [16, 38, 62]],
    [0.42, [8, 145, 178]],
    [0.72, [245, 158, 11]],
    [1.00, [239, 68, 68]]
  ];

  function heatRGB(p, maxP) {
    var t = maxP > 0 ? Math.min(1, p / maxP) : 0;
    t = Math.pow(t, 0.8);
    var i = 0;
    while (i < HEAT_STOPS.length - 2 && t > HEAT_STOPS[i + 1][0]) i++;
    var a = HEAT_STOPS[i], b = HEAT_STOPS[i + 1];
    var u = (t - a[0]) / (b[0] - a[0]);
    if (!isFinite(u)) u = 0;
    u = Math.max(0, Math.min(1, u));
    return [
      Math.round(a[1][0] + (b[1][0] - a[1][0]) * u),
      Math.round(a[1][1] + (b[1][1] - a[1][1]) * u),
      Math.round(a[1][2] + (b[1][2] - a[1][2]) * u)
    ];
  }

  function heat(p, maxP) {
    var c = heatRGB(p, maxP);
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  function isLight(p, maxP) {
    var c = heatRGB(p, maxP);
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 138;
  }

  function pushLog(kind, text) {
    state.log.push({ kind: kind, text: text, no: state.game ? state.game.shots.length : 0 });
    if (state.log.length > 80) state.log.shift();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- 存档 ---------------- */

  function serialize() {
    if (!state.game) return null;
    return {
      version: 2,
      rule: 'sink-all-cells',
      n: state.game.n,
      lengths: state.game.lengths.slice(),
      noTouch: state.game.noTouch,
      mode: state.mode,
      shots: JSON.parse(JSON.stringify(state.game.shots)),
      sunk: JSON.parse(JSON.stringify(state.game.sunk)),
      hidden: state.hidden ? JSON.parse(JSON.stringify(state.hidden)) : null,
      stats: JSON.parse(JSON.stringify(state.stats)),
      log: state.log.slice(-40),
      ghost: state.ghost,
      savedAt: new Date().toISOString()
    };
  }

  function saveNow() {
    var data = serialize();
    if (!data) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      state.savedAt = data.savedAt;
    } catch (e) { /* 隐私模式等忽略 */ }
  }

  function applyData(data) {
    if (!data || data.version !== 2 || !data.n || !data.lengths) throw new Error('存档格式不认识');
    state.game = new SonarCore.Game(data.n, data.lengths, { noTouch: data.noTouch !== false });
    state.game.shots = data.shots || [];
    state.game.sunk = data.sunk || [];
    state.mode = data.mode === 'record' ? 'record' : 'game';
    state.hidden = data.hidden || null;
    state.stats = data.stats || { shots: 0, agreed: 0, hits: 0 };
    state.log = data.log || [];
    state.ghost = data.ghost == null ? null : data.ghost;
    state.ghostBusy = false;
    state.ghostToken = (state.ghostToken || 0) + 1;
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    state.error = '';
    $('nInput').value = data.n;
    $('lengthsInput').value = data.lengths.slice().sort(function (a, b) { return b - a; }).join(',');
    $('noTouch').checked = data.noTouch !== false;
    $('mode').value = state.mode;
    $('autoBtn').style.display = state.mode === 'game' ? '' : 'none';
    state.restored = true;
    refresh();
  }

  function loadSaved() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return false;
    try {
      applyData(JSON.parse(raw));
      state.restored = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function exportJSON() {
    var data = serialize();
    if (!data) return;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'sonar-' + data.n + '-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        applyData(JSON.parse(String(reader.result)));
        state.restored = true;
        saveNow();
        showToast('已导入存档');
      } catch (e) {
        showError('导入失败：' + (e.message || e));
      }
    };
    reader.readAsText(file);
  }

  /* ---------------- 自动演示 / 幽灵对局 ---------------- */

  function stopAuto() {
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    $('autoBtn').textContent = '自动演示';
  }

  function allSunk() {
    return !!(state.hidden && state.hidden.every(function (s) { return s.sunk; }));
  }

  function autoStep() {
    if (!state.autoTimer) return;
    if (!state.analysis || state.analysis.done || !state.hidden || allSunk()) { stopAuto(); return; }
    shootGame(state.analysis.best.cell);
    if (!state.autoTimer) return;
    state.autoTimer = setTimeout(autoStep, 260);
  }

  function toggleAuto() {
    if (state.autoTimer) { stopAuto(); return; }
    if (state.mode !== 'game') return;
    if (!state.analysis || state.analysis.done) return;
    state.autoTimer = setTimeout(autoStep, 260);
    $('autoBtn').textContent = '停止演示';
  }

  /* 用求解器在同一局面上从头打一遍，得到“推荐路线”的用弹数。
     分片计算，避免一次性占用主线程导致点击卡顿。 */
  function computeGhost() {
    if (state.ghost != null || state.ghostBusy) return;
    if (!state.hidden || state.mode !== 'game') return;
    state.ghostBusy = true;
    var token = (state.ghostToken || 0) + 1;
    state.ghostToken = token;
    var n = state.game.n;
    var sim = {
      sunkFlags: state.hidden.map(function () { return false; }),
      hits: state.hidden.map(function () { return 0; }),
      game: new SonarCore.Game(n, state.game.lengths, { noTouch: state.game.noTouch }),
      bombs: 0
    };

    function step() {
      if (state.ghostToken !== token) { state.ghostBusy = false; return; }
      try {
        if (sim.bombs > 400) throw new Error('too many bombs');
        var a = SonarCore.analyze(sim.game, { samples: 3000, timeMs: 120, strategy: STRATEGY });
        if (a.done) {
          state.ghost = sim.bombs;
          state.ghostBusy = false;
          saveNow();
          renderScore();
          renderBanner();
          return;
        }
        sim.bombs++;
        var cell = a.best.cell;
        var idx = -1;
        for (var i = 0; i < state.hidden.length; i++) {
          if (sim.sunkFlags[i]) continue;
          if (state.hidden[i].cells.indexOf(cell) >= 0) { idx = i; break; }
        }
        if (idx >= 0) {
          sim.game.shots.push({ cell: cell, result: 'hit' });
          sim.hits[idx]++;
          if (sim.hits[idx] === state.hidden[idx].cells.length && !sim.sunkFlags[idx]) {
            sim.sunkFlags[idx] = true;
            sim.game.sunk.push({ cells: state.hidden[idx].cells.slice() });
            if (sim.sunkFlags.every(Boolean)) {
              state.ghost = sim.bombs;
              state.ghostBusy = false;
              saveNow();
              renderScore();
              renderBanner();
              return;
            }
          }
        } else {
          sim.game.shots.push({ cell: cell, result: 'miss' });
        }
        setTimeout(step, 16);
      } catch (e) {
        state.ghost = null;
        state.ghostBusy = false;
      }
    }
    setTimeout(step, 40);
  }

  /* ---------------- 分析 ---------------- */

  function analyzeNow() {
    if (!state.game) return;
    try {
      state.analysis = SonarCore.analyze(state.game, {
        samples: 6000, timeMs: 260, strategy: STRATEGY
      });
      state.error = '';
    } catch (e) {
      state.analysis = null;
      state.error = e.message || String(e);
    }
  }

  function refresh() {
    analyzeNow();
    saveNow();
    render();
  }

  /* ---------------- 新对局 ---------------- */

  function newGame() {
    stopAuto();
    var n = parseInt($('nInput').value, 10);
    if (!Number.isInteger(n) || n < 2 || n > 30) { showError('棋盘 n 必须在 2..30 之间'); return; }
    var lengths;
    try { lengths = parseLengths($('lengthsInput').value); }
    catch (e) { showError(e.message); return; }
    var sum = lengths.reduce(function (a, b) { return a + b; }, 0);
    if (sum > n * n) { showError('潜艇总面积超过棋盘'); return; }
    for (var i = 0; i < lengths.length; i++) {
      if (lengths[i] > n) { showError('潜艇长度不能超过 n'); return; }
    }

    var noTouch = $('noTouch').checked;
    state.mode = $('mode').value;
    state.game = new SonarCore.Game(n, lengths, { noTouch: noTouch });
    state.hidden = null;
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    state.log = [];
    state.error = '';
    state.stats = { shots: 0, agreed: 0, hits: 0 };
    state.ghost = null;
    state.ghostBusy = false;
    state.ghostToken = (state.ghostToken || 0) + 1;
    state.restored = false;

    if (state.mode === 'game') {
      try {
        var board = SonarCore.randomBoard(n, lengths, noTouch);
        state.hidden = board.map(function (cells) {
          return { cells: cells.slice(), hits: 0, sunk: false };
        });
        $('autoBtn').style.display = '';
      } catch (e) { showError(e.message); return; }
    } else {
      $('autoBtn').style.display = 'none';
    }
    refresh();
    computeGhost();
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    renderBoard();
    renderActionBar();
    renderRec();
    renderFleet();
    renderScore();
    renderLog();
    renderBanner();
  }

  function renderBoard() {
    var board = $('board');
    if (!state.game) {
      board.innerHTML = '';
      $('colLabels').innerHTML = '';
      $('rowLabels').innerHTML = '';
      return;
    }
    var n = state.game.n;
    var a = state.analysis;
    var maxP = 0;
    if (a) for (var i = 0; i < a.pOcc.length; i++) if (a.pOcc[i] > maxP) maxP = a.pOcc[i];
    $('boardFrame').style.setProperty('--n', n);
    var colHtml = '', rowHtml = '';
    for (var lb = 1; lb <= n; lb++) {
      colHtml += '<div class="lbl">' + lb + '</div>';
      rowHtml += '<div class="lbl">' + lb + '</div>';
    }
    $('colLabels').innerHTML = colHtml;
    $('rowLabels').innerHTML = rowHtml;

    var html = '';
    for (var cell = 0; cell < n * n; cell++) {
      var r = Math.floor(cell / n), c = cell % n;
      var cls = 'cell';
      var text = '';
      var style = '';
      var title = '第 ' + (r + 1) + ' 行 第 ' + (c + 1) + ' 列';
      if (a) {
        if (a.known[cell]) { cls += ' known'; text = '■'; title += ' · 已击沉潜艇'; }
        else if (a.hit[cell]) { cls += ' hit'; text = '●'; title += ' · 命中（这艘还没击沉）'; }
        else if (a.shot[cell]) { cls += ' miss'; text = '×'; title += ' · 未命中'; }
        else if (a.water[cell]) { cls += ' cleared'; text = '·'; title += ' · 已排除'; }
        else {
          var p = a.pOcc[cell];
          style = 'background:' + heat(p, maxP) + ';color:' + (isLight(p, maxP) ? '#062033' : '#f8fafc') + ';';
          if (p > 0.004) text = Math.round(p * 100) + '%';
          title += ' · 有潜艇概率 ' + (p * 100).toFixed(1) + '%';
        }
        if (a.best && a.best.cell === cell) cls += ' best';
      }
      if (state.pendingCell === cell) cls += ' pending';
      if (state.selected.indexOf(cell) >= 0) cls += ' selected';
      html += '<div class="' + cls + '" data-cell="' + cell + '" style="' + style + '" title="' + title + '">' + text + '</div>';
    }
    board.innerHTML = html;
    var w = board.clientWidth;
    if (w > 0) board.style.fontSize = Math.max(8, Math.min(15, w / n * 0.30)) + 'px';
  }

  function renderActionBar() {
    var bar = $('actionBar');
    if (!state.game) { bar.innerHTML = ''; return; }
    if (state.mode === 'game' && allSunk()) {
      bar.innerHTML = '<span class="hint">本局已结束。点「新对局」再来一局。</span>';
      return;
    }
    if (state.mode === 'game') {
      bar.innerHTML = '<span class="hint">点击任意未炸格子投弹 · 命中只显示这一格，整艘炸满才算击沉</span>';
      return;
    }
    if (state.selecting) {
      var info = selectionInfo(state.selected);
      bar.innerHTML =
        '<span class="pending-label">点选这艘已击沉的潜艇的全部格子（' + state.selected.length + ' 格）</span>' +
        '<button id="confirmShip" class="primary"' + (info ? '' : ' disabled') + '>' +
        (info ? '确认击沉（长 ' + info.len + '）' : '确认击沉') + '</button>' +
        '<button id="cancelShip" class="ghost">取消</button>' +
        '<span class="spacer"></span>' +
        '<span class="hint">可选长度：' + (state.analysis ? state.analysis.remainingLengths.join(' / ') : '') + '</span>';
      $('confirmShip').onclick = function () {
        var inf = selectionInfo(state.selected);
        if (inf) markSunk(inf.cells);
      };
      $('cancelShip').onclick = function () {
        state.selecting = false;
        state.selected = [];
        render();
      };
      return;
    }
    if (state.pendingCell != null) {
      bar.innerHTML =
        '<span class="pending-label">已选 ' + cellName(state.game.n, state.pendingCell) + '：</span>' +
        '<button id="markMiss" class="ghost">未命中</button>' +
        '<button id="markHit" class="primary">命中</button>' +
        '<button id="cancelPending" class="ghost">取消</button>' +
        '<span class="spacer"></span>' +
        '<button id="markSunkBtn">标记击沉</button>';
      $('markMiss').onclick = function () { addRecordedShot(state.pendingCell, 'miss'); };
      $('markHit').onclick = function () { addRecordedShot(state.pendingCell, 'hit'); };
      $('cancelPending').onclick = function () { state.pendingCell = null; render(); };
      $('markSunkBtn').onclick = function () {
        state.selecting = true;
        state.selected = [];
        render();
      };
      return;
    }
    bar.innerHTML =
      '<span class="hint">真实游戏里炸完一格后，点棋盘上对应的格子，选「命中」或「未命中」。</span>' +
      '<span class="spacer"></span><button id="markSunkOnly">标记已击沉的潜艇</button>';
    $('markSunkOnly').onclick = function () {
      state.selecting = true;
      state.selected = [];
      render();
    };
  }

  function renderRec() {
    var el = $('recCard');
    if (!state.game) { el.innerHTML = ''; return; }
    var a = state.analysis;
    if (state.error) {
      el.innerHTML = '<div class="card-title">推荐下一发</div><div class="error">' + escapeHtml(state.error) + '</div>';
      return;
    }
    if (!a) { el.innerHTML = ''; return; }
    if (a.done) {
      el.innerHTML =
        '<div class="card-title">推荐下一发</div>' +
        '<div class="done-text">全部潜艇已击沉 🎉</div>' +
        '<div class="method">共用 ' + state.game.shots.length + ' 发炸弹</div>';
      return;
    }
    var pct = a.best.pOcc * 100;
    var alts = (a.top || []).slice(1).map(function (t) {
      return '(' + t.r + ',' + t.c + ') ' + (t.pOcc * 100).toFixed(1) + '%';
    }).join('　');
    el.innerHTML =
      '<div class="card-title">推荐下一发</div>' +
      '<div class="coord">第 ' + a.best.r + ' 行 <small>·</small> 第 ' + a.best.c + ' 列</div>' +
      '<div class="prob-text">该格有潜艇的概率 <b>' + pct.toFixed(1) + '%</b></div>' +
      '<div class="prob-track"><div class="prob-fill" style="width:' + Math.min(100, pct * 2.2).toFixed(1) + '%"></div></div>' +
      (alts ? '<div class="alts">备选：' + alts + '</div>' : '') +
      '<button id="useBest" class="primary wide">' + (state.mode === 'game' ? '就炸这里' : '选为投弹点') + '</button>' +
      '<div class="method">' + methodText(a) + '</div>';
    $('useBest').onclick = function () {
      if (state.mode === 'game') shootGame(a.best.cell);
      else { state.pendingCell = a.best.cell; state.selecting = false; state.selected = []; render(); }
    };
  }

  function methodText(a) {
    if (a.method === 'done') return '';
    var m = a.method === 'exact' ? '精确枚举' : '采样 ' + a.samples + ' 个一致布局';
    return m + ' · ' + a.elapsedMs.toFixed(0) + ' ms';
  }

  function renderFleet() {
    var el = $('fleetCard');
    if (!state.game) { el.innerHTML = ''; return; }
    var lengths = state.game.lengths.slice().sort(function (a, b) { return b - a; });
    var sunkCount = {};
    if (state.analysis) {
      state.analysis.sunkShips.forEach(function (s) {
        var len = s.len || (s.cells ? s.cells.length : 0);
        sunkCount[len] = (sunkCount[len] || 0) + 1;
      });
    }
    var chips = '';
    var used = {};
    for (var i = 0; i < lengths.length; i++) {
      var L = lengths[i];
      used[L] = used[L] || 0;
      var isSunk = used[L] < (sunkCount[L] || 0);
      if (isSunk) used[L]++;
      chips += '<span class="chip' + (isSunk ? ' found' : '') + '">长 ' + L + (isSunk ? ' ✓' : '') + '</span>';
    }
    var a = state.analysis;
    var stats = '';
    if (a) {
      var area = lengths.reduce(function (x, y) { return x + y; }, 0);
      var hits = 0;
      for (var c = 0; c < a.hit.length; c++) if (a.hit[c]) hits++;
      stats =
        '<div>炸弹 <b>' + state.game.shots.length + '</b> 发 · 击中 <b>' + hits + ' / ' + area + '</b> 格</div>' +
        '<div>已击沉 <b>' + a.sunkShips.length + ' / ' + lengths.length + '</b> 艘 · 剩余长度 <b>' +
        (a.remainingLengths.length ? a.remainingLengths.join(', ') : '无') + '</b></div>' +
        '<div>命中但未击沉：<b>' + a.unsunkHits.length + '</b> 格</div>';
    }
    el.innerHTML = '<div class="card-title">潜艇</div><div class="chips">' + chips + '</div><div class="stats">' + stats + '</div>';
  }

  function renderScore() {
    var el = $('scoreCard');
    if (!el) return;
    if (!state.game) { el.innerHTML = ''; return; }
    var lengths = state.game.lengths;
    var area = lengths.reduce(function (a, b) { return a + b; }, 0);
    var shots = state.game.shots.length;
    var misses = 0;
    state.game.shots.forEach(function (s) { if (s.result === 'miss') misses++; });
    var agreePct = state.stats.shots ? Math.round(state.stats.agreed / state.stats.shots * 100) : 0;
    var ghostLine = '';
    if (state.mode === 'game') {
      if (state.ghost == null) {
        ghostLine = '<div>求解器从头打这局：<b>计算中…</b></div>';
      } else if (!allSunk()) {
        ghostLine = '<div>求解器从头打这局：<b>' + state.ghost + '</b> 发（打完后可对比）</div>';
      } else {
        var diff = shots - state.ghost;
        var cls = diff > 0 ? 'worse' : (diff < 0 ? 'better' : '');
        ghostLine = '<div>求解器从头打这局：<b>' + state.ghost + '</b> 发 ' +
          '<span class="delta ' + cls + '">（你' + (diff > 0 ? '多用 ' + diff : (diff < 0 ? '少用 ' + (-diff) : '持平')) + '）</span></div>';
      }
    }
    el.innerHTML =
      '<div class="card-title">记分板</div>' +
      '<div class="stats">' +
      '<div>实际炸弹：<b>' + shots + '</b> 发（下限 ' + area + '）</div>' +
      '<div>打空：<b>' + misses + '</b> 发 · 命中率 <b>' +
      (shots ? Math.round((shots - misses) / shots * 100) : 0) + '%</b></div>' +
      '<div>听推荐的比例：<b>' + agreePct + '%</b>（' + state.stats.agreed + ' / ' + state.stats.shots + '）</div>' +
      ghostLine +
      '<div class="saved">' + (state.savedAt ? '已自动保存 ' + state.savedAt.slice(11, 19) : '未保存') + '</div>' +
      '</div>';
  }

  function renderLog() {
    var rows = '';
    for (var i = state.log.length - 1; i >= 0; i--) {
      var e = state.log[i];
      rows += '<div class="log-row"><span class="no">#' + e.no + '</span><span class="res ' + e.kind + '">' +
        escapeHtml(e.text) + '</span></div>';
    }
    if (!rows) rows = '<div class="log-empty">还没有投弹记录。</div>';
    $('logCard').innerHTML = '<div class="card-title">记录</div><div class="log">' + rows + '</div>';
  }

  function renderBanner() {
    var b = $('banner');
    if (state.mode === 'game' && allSunk()) {
      b.className = 'banner show';
      var extra = '';
      if (state.ghost != null) {
        var diff = state.game.shots.length - state.ghost;
        extra = '　推荐路线只需 ' + state.ghost + ' 发（你' + (diff > 0 ? '多用 ' + diff : '少用 ' + (-diff)) + ' 发）。';
      }
      b.textContent = '🎉 全部潜艇击沉！共用 ' + state.game.shots.length + ' 发炸弹。' + extra;
    } else if (state.mode === 'record' && state.analysis && state.analysis.done) {
      b.className = 'banner show';
      b.textContent = '✅ 从记录推断：所有潜艇都已被击沉。';
    } else if (state.restored) {
      b.className = 'banner show';
      b.textContent = '↩️ 已恢复上次的进度（' + state.game.shots.length + ' 发）。点「新对局」重新开始。';
    } else {
      b.className = 'banner';
      b.textContent = '';
    }
  }

  function showError(msg) {
    state.error = msg;
    var b = $('banner');
    b.className = 'banner show';
    b.textContent = '⚠️ ' + msg;
  }

  function showToast(msg) {
    var b = $('banner');
    b.className = 'banner show';
    b.textContent = '💾 ' + msg;
  }

  /* ---------------- 行动 ---------------- */

  function shootGame(cell) {
    if (state.mode !== 'game' || !state.hidden) return;
    var a = state.analysis;
    if (a && (a.shot[cell] || a.known[cell] || a.water[cell])) return;
    state.stats.shots++;
    if (a && a.best && a.best.cell === cell) state.stats.agreed++;
    var idx = -1;
    for (var i = 0; i < state.hidden.length; i++) {
      if (state.hidden[i].sunk) continue;
      if (state.hidden[i].cells.indexOf(cell) >= 0) { idx = i; break; }
    }
    if (idx >= 0) {
      state.game.shots.push({ cell: cell, result: 'hit' });
      state.hidden[idx].hits++;
      var sunkNow = state.hidden[idx].hits === state.hidden[idx].cells.length;
      if (sunkNow) {
        state.hidden[idx].sunk = true;
        state.game.sunk.push({ cells: state.hidden[idx].cells.slice() });
      }
      pushLog(sunkNow ? 'ship' : 'hit',
        '命中 ' + cellName(state.game.n, cell) +
        (sunkNow ? ' · 该艘（长 ' + state.hidden[idx].cells.length + '）已击沉' : ''));
    } else {
      state.game.shots.push({ cell: cell, result: 'miss' });
      pushLog('miss', '未命中 ' + cellName(state.game.n, cell));
    }
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    refresh();
    if (allSunk()) stopAuto();
  }

  function addRecordedShot(cell, result) {
    var a = state.analysis;
    state.stats.shots++;
    if (a && a.best && a.best.cell === cell) state.stats.agreed++;
    state.game.shots.push({ cell: cell, result: result });
    pushLog(result === 'hit' ? 'hit' : 'miss',
      (result === 'hit' ? '命中 ' : '未命中 ') + cellName(state.game.n, cell));
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    refresh();
  }

  function markSunk(cells) {
    var sorted = cells.slice().sort(function (a, b) { return a - b; });
    var hitSet = {};
    state.game.shots.forEach(function (s) { if (s.result === 'hit') hitSet[s.cell] = true; });
    var added = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (!hitSet[sorted[i]]) { state.game.shots.push({ cell: sorted[i], result: 'hit' }); added++; }
    }
    state.game.sunk.push({ cells: sorted });
    pushLog('ship', '标记击沉：长 ' + sorted.length + (added ? '（补记 ' + added + ' 个命中格）' : ''));
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    refresh();
  }

  function selectionInfo(cells) {
    if (!cells || cells.length === 0) return null;
    var n = state.game.n;
    var sorted = cells.slice().sort(function (a, b) { return a - b; });
    for (var i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) return null;
    var rows = {}, cols = {};
    for (var j = 0; j < sorted.length; j++) {
      rows[Math.floor(sorted[j] / n)] = 1;
      cols[sorted[j] % n] = 1;
    }
    if (Object.keys(rows).length === 1) {
      for (var k = 1; k < sorted.length; k++) if (sorted[k] !== sorted[k - 1] + 1) return null;
    } else if (Object.keys(cols).length === 1) {
      for (var m = 1; m < sorted.length; m++) if (sorted[m] !== sorted[m - 1] + n) return null;
    } else {
      return null;
    }
    var remaining;
    try { remaining = SonarCore.derive(state.game).remaining; }
    catch (e) { return null; }
    if (remaining.indexOf(sorted.length) < 0) return null;
    return { cells: sorted, len: sorted.length };
  }

  function undo() {
    stopAuto();
    if (!state.game) return;
    var popped = state.game.shots.pop();
    if (!popped && !state.game.sunk.length) return;
    if (state.stats.shots > 0) state.stats.shots--;
    if (state.mode === 'game') {
      rebuildSunk();
    } else if (popped) {
      // 记录模式：撤销的那一发如果属于某条已标记的潜艇，标记也一起撤掉
      for (var i = state.game.sunk.length - 1; i >= 0; i--) {
        if (state.game.sunk[i].cells.indexOf(popped.cell) >= 0) {
          state.game.sunk.splice(i, 1);
          break;
        }
      }
    }
    state.pendingCell = null;
    state.selecting = false;
    state.selected = [];
    if (state.log.length) state.log.pop();
    refresh();
  }

  function rebuildSunk() {
    if (state.mode === 'game' && state.hidden) {
      state.hidden.forEach(function (s) { s.hits = 0; s.sunk = false; });
      state.game.sunk = [];
      state.game.shots.forEach(function (sh) {
        if (sh.result !== 'hit') return;
        for (var i = 0; i < state.hidden.length; i++) {
          if (state.hidden[i].sunk) continue;
          if (state.hidden[i].cells.indexOf(sh.cell) >= 0) {
            state.hidden[i].hits++;
            if (state.hidden[i].hits === state.hidden[i].cells.length) {
              state.hidden[i].sunk = true;
              state.game.sunk.push({ cells: state.hidden[i].cells.slice() });
            }
            break;
          }
        }
      });
    }
  }

  /* ---------------- 事件 ---------------- */

  $('board').addEventListener('click', function (e) {
    var target = e.target.closest('.cell');
    if (!target || !state.game) return;
    var cell = parseInt(target.getAttribute('data-cell'), 10);
    if (Number.isNaN(cell)) return;

    if (state.selecting) {
      if (state.selected.indexOf(cell) >= 0) {
        state.selected = state.selected.filter(function (c) { return c !== cell; });
      } else {
        state.selected.push(cell);
      }
      render();
      return;
    }
    if (state.mode === 'game') {
      shootGame(cell);
    } else {
      var a = state.analysis;
      if (a && (a.shot[cell] || a.known[cell])) return;
      state.pendingCell = cell;
      state.selected = [];
      render();
    }
  });

  $('newBtn').onclick = newGame;
  $('undoBtn').onclick = undo;
  $('autoBtn').onclick = toggleAuto;
  $('mode').onchange = function () { newGame(); };
  $('noTouch').onchange = function () { newGame(); };
  $('nInput').onchange = function () { newGame(); };
  $('lengthsInput').onchange = function () { newGame(); };
  $('exportBtn').onclick = function () { exportJSON(); showToast('已导出存档文件'); };
  $('importInput').onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  };

  window.addEventListener('resize', function () { if (state.game) renderBoard(); });

  /* 启动：优先恢复存档 */
  if (!loadSaved()) newGame();
  else computeGhost();
})();
