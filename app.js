// 工程進捗入力アプリ（画面側）
// GASの1往復は1〜2秒かかるため、スキャン結果は手元の一覧データで即表示し、送信は裏で順番に行う。

const API_URL = window.APP_CONFIG.API_URL;
const APP_VER = 4;                // 画面の版。サーバーの MIN_CLIENT_VER と合わせる。上げたら index.html の ?v= も変える
const IDLE_MS = 60 * 60 * 1000;   // 操作がないまま1時間でログアウト
const SAME_CODE_MS = 2500;        // 同じQRを続けて読んだときの無視時間
const TIMEOUT_MS = 30000;         // 1回の通信の待ち時間の上限
const RETRY = 3;                  // 通信エラー時の再送回数
const FIXED = (new URLSearchParams(location.search).get('process') || '').toUpperCase();

const S = {
  token: '', user: null, processes: [], rows: [], byPno: new Map(), today: '',
  proc: '', view: 'date', dates: [], dateIdx: 0,
  busy: false, last: null, recent: [],
  queue: [], sending: false, shown: '', listDirty: false,
};
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

// ---------- 保存（共用iPadなので最終操作時刻と一緒に持つ）----------
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

function touch() {
  if (S.token) lsSet('koutei', { token: S.token, user: S.user, proc: S.proc, at: Date.now() });
}

// ---------- 通信 ----------
function loading(on, msg) {
  S.busy = on;
  $('loading').textContent = msg || '読み込み中…';
  $('loading').classList.toggle('hidden', !on);
}

async function api(action, data) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let j;
  try {
    // Content-Type を付けない（text/plain）ことで、GASへのCORSプリフライトを避ける
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action: action, token: S.token, ver: APP_VER }, data || {})),
      signal: ctrl.signal,
    });
    j = await res.json();
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? '通信がタイムアウトしました' : '通信できません。電波を確認してください');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!j.ok) {
    // サーバーの方が新しい：最新の画面を読み込み直す（繰り返さないよう1回だけ）
    if (j.stale) {
      let tried = false;
      try { tried = sessionStorage.getItem('koutei_reload') === '1'; sessionStorage.setItem('koutei_reload', '1'); } catch (e) {}
      if (!tried) location.reload();
    }
    const err = new Error(j.error);
    err.auth = j.auth;
    if (j.auth) logout(j.error);
    throw err;
  }
  touch();
  return j;
}

let toastTimer = null;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 2500);
}

// ---------- 音 ----------
let audioCtx = null;
function tone(freq, start, dur) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.value = 0.25;
  o.start(audioCtx.currentTime + start);
  o.stop(audioCtx.currentTime + start + dur);
}
function sound(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (kind === 'ok') tone(1500, 0, 0.1);
    else if (kind === 'complete') { tone(1500, 0, 0.1); tone(2000, 0.15, 0.15); }
    else if (kind === 'warn') { tone(800, 0, 0.15); tone(800, 0.25, 0.15); tone(800, 0.5, 0.15); }
    else if (kind === 'ng') tone(300, 0, 0.6);
  } catch (e) {}
}

// ---------- 一覧データ ----------
// サーバーは1行を配列で返す：[P.No, 注番, 品番, 品名, SPEC, 数量, 色, 出荷日, 完了ビット, 前工程完了ビット, 途中の個数|0]
function unpack(a) {
  const done = {}, prevDone = {};
  S.processes.forEach((p, i) => {
    done[p.code] = p.hasCol ? !!((a[8] >> i) & 1) : null;
    prevDone[p.code] = !!((a[9] >> i) & 1);
  });
  return { pno: a[0], cno: a[1], code: a[2], name: a[3], spec: a[4], qty: a[5], color: a[6], due: a[7],
    done: done, prevDone: prevDone, count: a[10] || {} };
}

function applyInit(j) {
  S.processes = j.processes; S.today = j.today; S.reasons = j.reasons || [];
  if (j.user) S.user = j.user;
  S.rows = j.rows.map(unpack);
  S.byPno = new Map(S.rows.map(r => [r.pno, r]));
  // 再ログインをすぐ表示できるよう、一覧（製品データのみ）を端末に残す
  lsSet('koutei_rows', { at: Date.now(), today: j.today, processes: j.processes, reasons: S.reasons, rows: j.rows });
}

/** ログイン中の人が担当できる工程（暗証番号シートC列）。判定はサーバーでも行う */
function allowedProcs() { return S.processes.filter(p => p.allowed !== false); }

function countOf(r, proc) { return (r.count || {})[proc] || 0; }
function hasCol(proc) { const p = S.processes.find(x => x.code === proc); return p ? p.hasCol : true; }
function isDoneFor(r, proc) {
  const d = r.done[proc];
  if (d === null) return countOf(r, proc) >= r.qty; // 組付：履歴の数で判定
  return d;
}

// ---------- ログイン ----------
const L = { field: 'emp', emp: '', pin: '' };
function renderLogin() {
  $('vEmp').textContent = L.emp;
  $('vPin').textContent = '●'.repeat(L.pin.length);
  document.querySelectorAll('.field').forEach(f => f.classList.toggle('on', f.dataset.f === L.field));
}
document.querySelectorAll('.field').forEach(f => f.addEventListener('click', () => { L.field = f.dataset.f; renderLogin(); }));
$('keypad').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  sound(); // iOSはユーザー操作のときに音声を有効化しておく
  const k = b.dataset.k;
  if (k === 'go') return doLogin();
  if (k === 'clear') L[L.field] = '';
  else if (k === 'bs') L[L.field] = L[L.field].slice(0, -1);
  else if (L[L.field].length < 10) L[L.field] += b.textContent;
  $('loginErr').textContent = '';
  renderLogin();
});

async function doLogin() {
  if (!L.emp) { L.field = 'emp'; renderLogin(); return; }
  if (!L.pin) { L.field = 'pin'; renderLogin(); return; }
  if (S.busy) return;
  loading(true, 'ログイン中…');
  try {
    // ログインと一覧の取得を1往復で行う
    const j = await api('login', { emp: L.emp, pin: L.pin });
    S.token = j.token;
    applyInit(j);
    L.emp = ''; L.pin = ''; L.field = 'emp'; renderLogin();
    showApp();
  } catch (e) {
    $('loginErr').textContent = e.message;
    L.pin = ''; L.field = 'pin'; renderLogin();
    sound('ng');
  } finally {
    loading(false);
  }
}

function showLogin(msg) {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginErr').textContent = msg || '';
  renderLogin();
}

function logout(msg) {
  stopCamera();
  if (S.token && !msg) api('logout').catch(() => {});
  S.token = ''; S.user = null; S.last = null; S.recent = []; S.queue = [];
  lsDel('koutei');
  updatePending();
  showLogin(msg);
}
$('btnLogout').onclick = () => {
  if (S.queue.length && !confirm('まだ送信中のデータが' + S.queue.length + '件あります。ログアウトすると送信されません。よろしいですか？')) return;
  if (!S.queue.length && !confirm('ログアウトしますか？')) return;
  logout();
};

// 一定時間操作がなければログアウト（送信待ちがあるときは待つ）
setInterval(() => {
  const s = lsGet('koutei');
  if (S.token && !S.queue.length && (!s || Date.now() - s.at > IDLE_MS)) logout('操作がなかったためログアウトしました');
}, 60 * 1000);

// ---------- 本体 ----------
function showApp() {
  const allowed = allowedProcs();
  if (FIXED && allowed.some(p => p.code === FIXED)) S.proc = FIXED;
  else if (FIXED) toast('「' + procName(FIXED) + '」の権限がないため、担当工程に切り替えました');
  if (!allowed.some(p => p.code === S.proc)) S.proc = allowed[0].code;
  touch();
  buildDates();
  $('whoName').textContent = S.user.name + '（' + S.user.emp + '）';
  renderProcs(); renderRecent(); renderList();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
}

/** 一覧を裏で取り直す。画面は止めない */
async function refresh(manual) {
  $('listCount').textContent = '最新の状態を読み込み中…';
  try {
    const j = await api('init');
    const cur = S.dates[S.dateIdx];
    applyInit(j);
    // 送信待ちの分は、取り直したデータにもう一度反映しておく
    S.queue.forEach(predictApply);
    buildDates();
    const i = S.dates.indexOf(cur);
    if (i >= 0) S.dateIdx = i;
    if (manual) toast('最新の状態にしました');
  } catch (e) {
    if (!e.auth) toast('一覧の更新に失敗しました：' + e.message);
  }
  renderList();
}

function procName(code) { const p = S.processes.find(x => x.code === code); return p ? p.name : code; }

function renderProcs() {
  const allowed = allowedProcs();
  if ((FIXED && S.proc === FIXED) || allowed.length === 1) {
    $('procArea').innerHTML = '<div class="fixed">工程：' + esc(procName(S.proc)) + '</div>';
    return;
  }
  $('procArea').innerHTML = '<div class="procs">' + allowed.map(p =>
    '<button data-proc="' + p.code + '" class="' + (p.code === S.proc ? 'on' : '') + '">' + esc(p.name) + '</button>'
  ).join('') + '</div>';
}
$('procArea').addEventListener('click', e => {
  const b = e.target.closest('button[data-proc]');
  if (!b) return;
  S.proc = b.dataset.proc;
  S.last = null;
  touch();
  renderProcs(); renderList();
  $('result').className = 'card';
  $('result').innerHTML = '<div class="muted">工程を「' + esc(procName(S.proc)) + '」に切り替えました。</div>';
});

function listVisible() { return !$('tab-list').classList.contains('hidden'); }

// タブを切り替えてもカメラは止めない（再起動に時間がかかるため）。一覧表示中は読み取りを無視する
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('tab-scan').classList.toggle('hidden', b.dataset.tab !== 'scan');
  $('tab-list').classList.toggle('hidden', b.dataset.tab !== 'list');
  if (b.dataset.tab === 'list' && S.listDirty) renderList();
});

// ---------- スキャン（即時表示＋裏で送信）----------
/**
 * スキャン1件を受け付ける。手元のデータで結果を先に出し、送信は順番待ちに積む。
 * opts: { all: 全数完了, source: 'list' }
 */
function enqueue(pno, opts) {
  pno = String(pno || '').trim();
  if (!pno || !S.token) return;
  const item = { rid: uid(), pno: pno, proc: S.proc, opts: opts || {}, at: new Date() };
  predict(item);
  S.queue.push(item);
  updatePending();
  pump();
}

/** 手元のデータでの判定（サーバーの結果を待たずに表示する） */
function predict(item) {
  const r = S.byPno.get(item.pno);
  item.entry = addRecent('sending', item.pno, item.proc, '送信中…');
  if (!r) {
    item.predicted = 'unknown';
    showPendingCard(item);
    return;
  }
  item.snapshot = { done: Object.assign({}, r.done), count: Object.assign({}, r.count) };
  if (isDoneFor(r, item.proc)) {
    item.predicted = 'already';
    sound('warn');
  } else {
    predictApply(item);
    item.predicted = 'ok';
    sound(isDoneFor(r, item.proc) ? 'complete' : 'ok');
  }
  S.shown = item.rid;
  renderResult({ result: item.predicted, row: r, count: item.predicted === 'already' ? r.qty : countOf(r, item.proc),
    qty: r.qty, completed: isDoneFor(r, item.proc), skipped: item.skips, pending: true }, item);
  markListDirty();
}

/** 予測した結果を手元の一覧に反映する */
function predictApply(item) {
  const r = S.byPno.get(item.pno);
  if (!r || isDoneFor(r, item.proc)) return;
  const next = item.opts.all ? r.qty : Math.min(r.qty, countOf(r, item.proc) + 1);
  r.count = Object.assign({}, r.count, { [item.proc]: next });
  if (next >= r.qty && hasCol(item.proc)) r.done = Object.assign({}, r.done, { [item.proc]: true });

  // 飛ばされた前の工程はスキップ扱い（未着手の工程だけ。最終的な判定はサーバーが行う）
  const idx = S.processes.findIndex(p => p.code === item.proc);
  item.skips = S.processes.slice(0, idx)
    .filter(p => p.code !== 'STOCK' && !isDoneFor(r, p.code) && countOf(r, p.code) === 0)
    .map(p => p.code);
  item.skips.forEach(code => {
    r.count = Object.assign({}, r.count, { [code]: r.qty });
    if (hasCol(code)) r.done = Object.assign({}, r.done, { [code]: true });
  });
}

function skipText(codes) {
  return codes && codes.length ? 'スキップ：' + codes.map(procName).join('・') : '';
}

async function pump() {
  if (S.sending) return;
  S.sending = true;
  while (S.queue.length && S.token) {
    const item = S.queue[0];
    let res = null, error = null;
    for (let n = 0; n < RETRY; n++) {
      try {
        res = await api('scan', Object.assign({ process: item.proc, pno: item.pno, rid: item.rid }, item.opts));
        break;
      } catch (e) {
        error = e;
        if (!e.network) break;          // サーバーが断った場合は再送しない
        await sleep(1500 * (n + 1));    // 同じ送信IDで再送するので、二重には数えない
      }
    }
    if (!S.token) break; // 途中でログアウトした
    S.queue.shift();
    if (res) reconcile(item, res);
    else fail(item, error);
    updatePending();
  }
  S.sending = false;
}

/** サーバーの結果で確定させる。予測と違ったときだけ音と表示で知らせる */
function reconcile(item, j) {
  if (j.row) mergeRow(j.row, item.proc, j.count);
  const r = S.byPno.get(item.pno);
  if (r && j.counts) r.count = j.counts;
  const changed = j.result !== item.predicted;
  if (j.result === 'ok') {
    if (S.proc === item.proc) S.last = { id: j.id, pno: item.pno, proc: item.proc, qty: j.qty };
    if (changed) sound(j.completed ? 'complete' : 'ok');
    const skip = skipText(j.skipped);
    setRecent(item.entry, j.skipped && j.skipped.length ? 'warn' : 'ok',
      (j.qty > 1 ? j.count + '/' + j.qty + (j.completed ? ' 完了' : '') : '完了') + (skip ? '（' + skip + '）' : ''));
  } else if (j.result === 'already') {
    if (changed) sound('warn');
    setRecent(item.entry, 'warn', '完了済み（警告）');
  } else if (j.result === 'shipped') {
    sound('warn');
    setRecent(item.entry, 'warn', '出荷済み');
  } else {
    sound('ng');
    setRecent(item.entry, 'ng', 'マスターになし');
  }
  if (S.shown === item.rid || changed) {
    S.shown = item.rid;
    renderResult(j, item);
  }
  if (item.opts.source === 'list') toast(item.pno + '：' + item.entry.text);
  markListDirty();
}

function fail(item, e) {
  // 予測で変えた手元の状態を元に戻す
  const r = S.byPno.get(item.pno);
  if (r && item.snapshot) { r.done = item.snapshot.done; r.count = item.snapshot.count; }
  sound('ng');
  setRecent(item.entry, 'ng', '送信失敗：' + e.message);
  S.shown = item.rid;
  $('result').className = 'card ng';
  $('result').innerHTML = '<div class="rhead">送信できませんでした</div><div class="pno">' + esc(item.pno) + '</div>' +
    '<div>' + esc(e.message) + '</div><div class="muted">もう一度読み取ってください。</div>';
  markListDirty();
}

function mergeRow(row, proc, count) {
  const r = S.byPno.get(row.pno);
  if (!r) return;
  r.done = row.done;
  if (count != null) r.count = Object.assign({}, r.count, { [proc]: count });
}

function updatePending() {
  const n = S.queue.length;
  $('pending').textContent = '送信待ち ' + n + '件';
  $('pending').classList.toggle('hidden', n === 0);
}

function showPendingCard(item) {
  S.shown = item.rid;
  $('result').className = 'card';
  $('result').innerHTML = '<div class="rhead">照会中…</div><div class="pno">' + esc(item.pno) + '</div>' +
    '<div class="muted">一覧にないP.Noです。サーバーで確認しています。</div>';
}

function renderResult(j, item) {
  const el = $('result');
  const proc = esc(procName(item.proc));
  if (j.result === 'shipped' || j.result === 'notfound') {
    el.className = 'card ' + (j.result === 'shipped' ? 'warn' : 'ng');
    el.innerHTML = '<div class="rhead">' + (j.result === 'shipped' ? '出荷済みです' : 'マスターに見つかりません') + '</div>' +
      '<div class="pno">' + esc(item.pno) + '</div>' +
      '<div class="muted">' + (j.result === 'shipped' ? 'DONEシートにあります。' : 'ラベルの読み間違いか、未登録のP.Noです。') + '（警告として記録）</div>';
    return;
  }
  const r = S.byPno.get(item.pno) || j.row;
  let head, cls;
  if (j.result === 'already') { head = '⚠ ' + proc + 'は完了済みです'; cls = 'warn'; }
  else if (j.completed) { head = '✔ ' + proc + ' 完了'; cls = 'complete'; }
  else { head = proc + ' 1個カウント'; cls = 'ok'; }
  el.className = 'card ' + cls;

  const showAll = j.result === 'ok' && !j.completed && j.qty > 1;
  const canUndo = !j.pending && j.result === 'ok' && S.last && S.last.id === j.id;
  const skipped = j.result === 'ok' ? (j.skipped || []) : [];
  el.innerHTML =
    '<div class="rhead">' + head + (j.round > 1 ? '（' + j.round + '回目）' : '') + '</div>' +
    '<div class="pno">' + esc(r.pno) + '</div>' +
    '<div>' + esc(r.code) + '　' + esc(r.name) + '</div>' +
    '<div class="muted">注番 ' + esc(r.cno) + '／色 ' + esc(r.color) + '／出荷 ' + esc(r.due) + '</div>' +
    '<div class="count">' + (j.qty > 1 ? j.qty + '個中 ' + j.count + '個' : '数量 1') + '</div>' +
    (skipped.length ? '<div class="skipnote">' + esc(skipText(skipped)) + '（飛ばした工程を済にしました）</div>' : '') +
    '<div class="steps">' + S.processes.map(p =>
      '<span class="' + (skipped.indexOf(p.code) >= 0 ? 'skip ' : r.done[p.code] ? 'done ' : '') +
        (p.code === item.proc ? 'cur' : '') + '">' + esc(p.name) + '</span>'
    ).join('') + '</div>' +
    '<div class="sendstate">' + (j.pending ? '送信中…' : '記録しました') + '</div>' +
    '<div class="actions">' +
      (showAll ? '<button class="btn green" id="btnAll">全数完了（残り' + (j.qty - j.count) + '個）</button>' : '') +
      (canUndo ? '<button class="btn orange" id="btnUndo">取り消し</button>' : '') +
      '<button class="btn red" id="btnRecoat">リコート</button>' +
    '</div>';
  if (showAll) $('btnAll').onclick = () => {
    if (confirm(r.pno + ' の残り' + (j.qty - j.count) + '個を完了にしますか？')) enqueue(r.pno, { all: true });
  };
  if (canUndo) $('btnUndo').onclick = undoLast;
  $('btnRecoat').onclick = () => openRecoat(r, item.proc);
}

// ---------- リコート ----------
const RC = { row: null, proc: '', back: '', reason: '', qty: 1 };

function openRecoat(r, proc) {
  Object.assign(RC, { row: r, proc: proc, back: '', reason: '', qty: 1 });
  const idx = S.processes.findIndex(p => p.code === proc);
  // 戻し先は今の工程まで（完了は選べない）
  const backs = S.processes.slice(0, idx + 1).filter(p => p.code !== 'STOCK');
  $('rcPno').textContent = r.pno;
  $('rcName').textContent = r.code + '　' + r.name + '（' + procName(proc) + 'でリコート）';
  $('rcBack').innerHTML = backs.map(p => '<button data-v="' + p.code + '">' + esc(p.name) + '</button>').join('');
  $('rcReason').innerHTML = (S.reasons || []).map(v => '<button data-v="' + esc(v) + '">' + esc(v) + '</button>').join('');
  $('rcQtyArea').classList.toggle('hidden', r.qty <= 1);
  $('rcQtyMax').textContent = '（' + r.qty + '個中）';
  renderRecoat();
  $('recoat').classList.remove('hidden');
}

function renderRecoat() {
  document.querySelectorAll('#rcBack button').forEach(b => b.classList.toggle('on', b.dataset.v === RC.back));
  document.querySelectorAll('#rcReason button').forEach(b => b.classList.toggle('on', b.dataset.v === RC.reason));
  $('rcQty').textContent = RC.qty;
  if (RC.back) {
    const i = S.processes.findIndex(p => p.code === RC.back);
    const names = S.processes.slice(i).filter(p => p.code !== 'STOCK').map(p => p.name).join('・');
    $('rcNote').textContent = names + ' を、戻した' + RC.qty + '個分やり直しにします（チェックを外します）。';
  } else {
    $('rcNote').textContent = '';
  }
  $('rcGo').disabled = !RC.back || !RC.reason;
}

$('rcBack').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { RC.back = b.dataset.v; renderRecoat(); } });
$('rcReason').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { RC.reason = b.dataset.v; renderRecoat(); } });
$('rcMinus').onclick = () => { if (RC.qty > 1) { RC.qty--; renderRecoat(); } };
$('rcPlus').onclick = () => { if (RC.qty < RC.row.qty) { RC.qty++; renderRecoat(); } };
$('rcCancel').onclick = () => { $('recoat').classList.add('hidden'); setRecoatMode(false); };
$('rcGo').onclick = doRecoat;

// リコートモード：次に読んだ（入力した）製品は、完了として数えずにリコート画面を開く。1件で自動的に戻る
function setRecoatMode(on) {
  S.recoatMode = on;
  $('btnMode').classList.toggle('on', on);
  $('btnMode').textContent = on ? 'リコートモードをやめる' : 'リコートモードにする';
  $('modeBar').classList.toggle('hidden', !on);
}
$('btnMode').onclick = () => { sound(); setRecoatMode(!S.recoatMode); };

function recoatByPno(pno) {
  const r = S.byPno.get(pno);
  if (!r) {
    sound('ng');
    toast(pno + ' は一覧にありません（出荷済みか未登録）');
    return;
  }
  sound('ok');
  openRecoat(r, S.proc);
}

/** スキャン・手入力の受け口。リコートモードならリコート画面、そうでなければ完了として送る */
function handleCode(pno) {
  pno = String(pno || '').trim();
  if (!pno) return;
  if (S.recoatMode) recoatByPno(pno);
  else enqueue(pno);
}

function modalOpen() { return !!document.querySelector('.modal:not(.hidden)'); }

async function doRecoat() {
  if (S.busy) return;
  const req = { process: RC.proc, pno: RC.row.pno, back: RC.back, reason: RC.reason, qty: RC.qty, rid: uid() };
  $('recoat').classList.add('hidden');
  setRecoatMode(false);
  loading(true, 'リコート中…');
  try {
    // 先に送ったスキャンの記録が済んでから戻す
    for (let t = 0; S.queue.length && t < 300; t++) await sleep(200);
    const j = await api('recoat', req);
    const r = S.byPno.get(req.pno);
    if (r) { r.done = j.row.done; r.count = j.counts || {}; }
    S.last = { id: j.id, pno: req.pno, proc: req.process, kind: 'recoat' };
    sound('warn');
    const text = 'リコート→' + procName(req.back) + '（' + req.reason + (j.qty > 1 ? '・' + j.n + '個' : '') + '）';
    addRecent('warn', req.pno, req.process, text);
    if (listVisible()) toast(req.pno + '：' + text);
    S.shown = '';
    $('result').className = 'card warn';
    $('result').innerHTML = '<div class="rhead">リコートしました</div><div class="pno">' + esc(req.pno) + '</div>' +
      '<div>' + esc(text) + '</div>' +
      '<div class="steps">' + S.processes.map(p => '<span class="' + (j.row.done[p.code] ? 'done' : '') + '">' + esc(p.name) + '</span>').join('') + '</div>' +
      '<div class="actions"><button class="btn orange" id="btnUndo">取り消し</button></div>';
    $('btnUndo').onclick = undoLast;
    markListDirty();
  } catch (e) {
    toast(e.message);
    sound('ng');
  } finally {
    loading(false);
  }
}

async function undoLast() {
  if (!S.last || S.busy) return;
  if (S.queue.length) { toast('送信が終わってから取り消してください'); return; }
  const last = S.last;
  loading(true, '取り消し中…');
  try {
    const j = await api('undo', { id: last.id, rid: uid() });
    S.last = null;
    const r = S.byPno.get(last.pno);
    if (r && j.row) { r.done = j.row.done; r.count = j.counts || {}; }
    sound('ok');
    const what = last.kind === 'recoat' ? 'リコートを取り消し' : '取り消し';
    addRecent('warn', last.pno, last.proc, what);
    $('result').className = 'card warn';
    $('result').innerHTML = '<div class="rhead">' + what + 'ました</div><div class="pno">' + esc(last.pno) + '</div>' +
      (last.kind === 'recoat' ? '' : '<div>' + esc(procName(j.process)) + (j.qty > 1 ? '：' + j.qty + '個中 ' + j.count + '個' : '') + '</div>');
    markListDirty();
  } catch (e) {
    toast(e.message);
  } finally {
    loading(false);
  }
}

function addRecent(kind, pno, proc, text) {
  const t = new Date();
  const entry = { kind: kind, pno: pno, text: text, proc: procName(proc),
    time: [t.getHours(), t.getMinutes(), t.getSeconds()].map(n => String(n).padStart(2, '0')).join(':') };
  S.recent.unshift(entry);
  S.recent = S.recent.slice(0, 20);
  renderRecent();
  return entry;
}
function setRecent(entry, kind, text) {
  entry.kind = kind; entry.text = text;
  renderRecent();
}
function renderRecent() {
  $('recent').innerHTML = S.recent.map(r =>
    '<li class="' + r.kind + '"><span class="t">' + r.time + '</span><span>' + esc(r.proc) + '　' + esc(r.pno) + '　' + esc(r.text) + '</span></li>'
  ).join('') || '<li class="muted">まだありません</li>';
}

$('btnEnter').onclick = () => { handleCode($('pnoInput').value); $('pnoInput').value = ''; };
$('pnoInput').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  handleCode(e.target.value);
  e.target.value = '';
});

// カメラ：開いたまま連続で読む。同じQRは一定時間無視する
let cam = null, lastCode = '', lastAt = 0;
async function startCamera() {
  sound();
  $('camMsg').textContent = '起動中…';
  try {
    cam = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
    await cam.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
      onDecode,
      () => {}
    );
    $('camMsg').textContent = 'QRコードを枠に入れてください';
    $('btnCamera').classList.add('hidden');
    $('btnStop').classList.remove('hidden');
  } catch (e) {
    cam = null;
    $('camMsg').textContent = 'カメラを起動できません：' + (e && e.message ? e.message : e);
  }
}
function onDecode(text) {
  if (listVisible() || modalOpen()) return;
  const now = Date.now();
  if (text === lastCode && now - lastAt < SAME_CODE_MS) return;
  lastCode = text; lastAt = now;
  handleCode(text);
}
async function stopCamera() {
  if (!cam) return;
  const c = cam;
  cam = null;
  try { await c.stop(); c.clear(); } catch (e) {}
  $('btnCamera').classList.remove('hidden');
  $('btnStop').classList.add('hidden');
  $('camMsg').textContent = '';
}
$('btnCamera').onclick = startCamera;
$('btnStop').onclick = stopCamera;

// ---------- 一覧 ----------
// 出荷日は「MM-dd」で年がないため、今日から±6か月の範囲で年を補って並べる
function dueKey(s) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s || '');
  if (!m) return null;
  const tm = Number(S.today.split('-')[0]);
  const mon = Number(m[1]);
  let y = 0;
  if (mon - tm > 6) y = -1; else if (tm - mon > 6) y = 1;
  return y * 10000 + mon * 100 + Number(m[2]);
}
function buildDates() {
  const set = new Set(S.rows.map(r => r.due).filter(d => dueKey(d) !== null));
  S.dates = [...set].sort((a, b) => dueKey(a) - dueKey(b));
  const t = dueKey(S.today);
  const i = S.dates.findIndex(d => dueKey(d) >= t);
  S.dateIdx = i >= 0 ? i : Math.max(0, S.dates.length - 1);
}
$('datePrev').onclick = () => { if (S.dateIdx > 0) { S.dateIdx--; renderList(); } };
$('dateNext').onclick = () => { if (S.dateIdx < S.dates.length - 1) { S.dateIdx++; renderList(); } };
$('viewSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  S.view = b.dataset.view;
  document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('on', x === b));
  renderList();
});
let searchTimer = null;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 200); });
$('btnReload').onclick = () => refresh(true);

function statusCell(r) {
  if (isDoneFor(r, S.proc)) return '<td class="st done">済</td>';
  const c = countOf(r, S.proc);
  if (c > 0) return '<td class="st part">' + c + '/' + r.qty + '</td>';
  return '<td class="st todo">未</td>';
}

// 一覧が見えていないときは描き直さず、表示したときにまとめて描く
function markListDirty() {
  if (listVisible()) renderList();
  else S.listDirty = true;
}

const MAX_ROWS = 300;
let shownRows = [];
function renderList() {
  S.listDirty = false;
  $('dateBar').classList.toggle('hidden', S.view !== 'date');
  $('dateLabel').textContent = S.dates[S.dateIdx] || '--';

  const q = $('search').value.trim().toLowerCase();
  let rows = S.rows;
  if (S.view === 'date') {
    const d = S.dates[S.dateIdx];
    rows = rows.filter(r => r.due === d);
  } else {
    rows = rows.filter(r => !isDoneFor(r, S.proc));
    if (S.view === 'here') rows = rows.filter(r => r.prevDone[S.proc]);
    rows = rows.slice().sort((a, b) => (dueKey(a.due) ?? 1e9) - (dueKey(b.due) ?? 1e9));
  }
  if (q) rows = rows.filter(r => [r.code, r.cno, r.name, r.pno].some(x => String(x).toLowerCase().includes(q)));

  shownRows = rows.slice(0, MAX_ROWS);
  $('listCount').textContent = procName(S.proc) + '：' + rows.length + '件（行をタップすると完了・リコートができます）';
  $('listBody').innerHTML = shownRows.map((r, i) =>
    '<tr data-i="' + i + '">' +
    '<td>' + esc(r.pno) + '</td>' +
    '<td class="colCno">' + esc(r.cno) + '</td>' +
    '<td>' + esc(r.code) + '</td>' +
    '<td>' + esc(r.name) + (r.spec ? '<div class="muted">' + esc(r.spec) + '</div>' : '') + '</td>' +
    '<td class="colSpec">' + esc(r.color) + '</td>' +
    '<td>' + r.qty + '</td>' +
    '<td>' + esc(r.due) + '</td>' +
    statusCell(r) +
    '</tr>'
  ).join('') + (rows.length > MAX_ROWS ? '<tr><td colspan="8" class="muted">先頭' + MAX_ROWS + '件を表示中。検索で絞り込んでください。</td></tr>' : '');
}

// ラベルが剥がれたときなどの手動入力
// 行をタップすると「完了にする／リコート」を選べる。完了済みの行はリコートだけ
let menuRow = null;
$('listBody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = shownRows[Number(tr.dataset.i)];
  if (!r) return;
  menuRow = r;
  const done = isDoneFor(r, S.proc);
  const rest = r.qty - countOf(r, S.proc);
  $('rmPno').textContent = r.pno;
  $('rmName').textContent = r.code + '　' + r.name;
  $('rmState').textContent = procName(S.proc) + '：' + (done ? '完了済み' : r.qty > 1 ? r.qty + '個中 ' + countOf(r, S.proc) + '個' : '未完了');
  $('rmDone').classList.toggle('hidden', done);
  $('rmDone').textContent = '完了にする' + (r.qty > 1 ? '（残り' + rest + '個すべて）' : '');
  $('rowMenu').classList.remove('hidden');
});
$('rmDone').onclick = () => {
  $('rowMenu').classList.add('hidden');
  enqueue(menuRow.pno, { all: true, source: 'list' });
};
$('rmRecoat').onclick = () => {
  $('rowMenu').classList.add('hidden');
  openRecoat(menuRow, S.proc);
};
$('rmCancel').onclick = () => $('rowMenu').classList.add('hidden');

// ---------- 起動 ----------
// ログインが残っていれば、端末に残した一覧ですぐ表示し、裏で最新を取り直す
(function boot() {
  const s = lsGet('koutei');
  const cached = lsGet('koutei_rows');
  if (s && s.token && Date.now() - s.at < IDLE_MS && cached && cached.rows) {
    S.token = s.token; S.user = s.user; S.proc = s.proc || '';
    S.processes = cached.processes; S.today = cached.today; S.reasons = cached.reasons || [];
    S.rows = cached.rows.map(unpack);
    S.byPno = new Map(S.rows.map(r => [r.pno, r]));
    showApp();
    refresh(false);
    return;
  }
  lsDel('koutei');
  S.token = '';
  showLogin();
})();
