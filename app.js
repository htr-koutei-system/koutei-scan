// 工程進捗入力アプリ（画面側）
// GASの1往復は1〜2秒かかるため、スキャン結果は手元の一覧データで即表示し、送信は裏で順番に行う。

const API_URL = window.APP_CONFIG.API_URL;
const APP_VER = 10;                // 画面の版。サーバーの MIN_CLIENT_VER 以上にする。上げたら index.html の ?v= も変える
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
  // 通ったら再読み込みの印を消す（次に版が上がったときも自動で読み込み直せるように）
  if (!j.stale) { try { sessionStorage.removeItem('koutei_reload'); } catch (e) {} }
  if (!j.ok) {
    // サーバーの方が新しい：最新の画面を読み込み直す（繰り返さないよう1回だけ）
    if (j.stale) {
      let tried = false;
      try { tried = sessionStorage.getItem('koutei_reload') === '1'; sessionStorage.setItem('koutei_reload', '1'); } catch (e) {}
      if (!tried) {
        // 送信待ちはサーバーに断られて記録されていない。読み込み直す前に、読み直すP.Noを知らせる
        if (S.queue.length) {
          alert('アプリが更新されました。次の' + S.queue.length + '件は記録されていないので、画面が切り替わったら読み直してください。\n\n' +
            S.queue.map(q => procName(q.proc) + '　' + q.pno).join('\n'));
        }
        location.reload();
      }
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
// 登録は「チャリン」（コイン）、工程の完了は「チャリーン」（レジ）。警告・エラーは電子音
let audioCtx = null;
function tone(freq, start, dur) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.value = 0.25;
  o.start(audioCtx.currentTime + start);
  o.stop(audioCtx.currentTime + start + dur);
}
/** 鳴った直後から小さくなっていく音（金属・ベルの響き） */
function ring(freq, start, dur, type, vol) {
  const t = audioCtx.currentTime + start;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
/** 「チャ」の部分：高い音だけを残した短いノイズ */
function clink(start, dur, vol) {
  const t = audioCtx.currentTime + start;
  const len = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource(), hp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  src.buffer = buf;
  hp.type = 'highpass';
  hp.frequency.value = 4000;
  g.gain.value = vol;
  src.connect(hp); hp.connect(g); g.connect(audioCtx.destination);
  src.start(t);
}
function sound(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (kind === 'ok') {
      // チャリン：コインの2音
      ring(1976, 0, 0.09, 'square', 0.08);
      ring(2637, 0.08, 0.45, 'square', 0.08);
    } else if (kind === 'complete') {
      // チャリーン：レジの「チャ」＋ベルの響き
      clink(0, 0.06, 0.35);
      ring(2093, 0.03, 1.0, 'sine', 0.22);
      ring(2637, 0.06, 1.0, 'sine', 0.16);
      ring(3136, 0.09, 1.1, 'sine', 0.13);
      ring(4186, 0.12, 0.8, 'sine', 0.08);
    }
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
    done: done, prevDone: prevDone, count: a[10] || {}, brand: a[11] || '', model: a[12] || '' };
}

/** 一覧の「ブランド/車種」列（K列BRAND / L列MODEL。FRPは2FのJ列 / K列） */
function brandModel(r) {
  return [r.brand, r.model].filter(Boolean).join('/');
}

function applyInit(j) {
  S.processes = j.processes; S.today = j.today; S.reasons = j.reasons || [];
  if (j.user) S.user = j.user;
  setRows(j.rows, j.frpRows);
  // 再ログインをすぐ表示できるよう、一覧（製品データのみ）を端末に残す
  lsSet('koutei_rows', { at: Date.now(), today: j.today, processes: j.processes, reasons: S.reasons, rows: j.rows, frpRows: j.frpRows });
}

// 一覧は2種類：マスター（水研〜完了）と、FRP実績の2Fシート（FRP）
function setRows(rows, frpRows) {
  S.rows = rows.map(unpack);
  S.byPno = new Map(S.rows.map(r => [r.pno, r]));
  S.frpRows = (frpRows || []).map(unpack);
  S.frpByPno = new Map(S.frpRows.map(r => [r.pno, r]));
}
function isFrp(proc) { return proc === 'FRP'; }
function rowsFor(proc) { return isFrp(proc) ? S.frpRows : S.rows; }
function rowOf(proc, pno) { return (isFrp(proc) ? S.frpByPno : S.byPno).get(pno); }

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
  $('curProc').textContent = '工程：' + procName(S.proc);
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
  const cur = S.dates[S.dateIdx];
  S.proc = b.dataset.proc;
  S.last = null;
  touch();
  // FRPとそれ以外では一覧の元が違うので、出荷日の並びを作り直す（同じ日付があればそのまま）
  buildDates();
  const i = S.dates.indexOf(cur);
  if (i >= 0) S.dateIdx = i;
  if (isFrp(S.proc)) setRecoatMode(false);
  renderProcs(); renderList();
  $('result').className = 'card';
  $('result').innerHTML = '<div class="muted">工程を「' + esc(procName(S.proc)) + '」に切り替えました。</div>';
});

function listVisible() { return !$('tab-list').classList.contains('hidden'); }
function isPhone() { return window.innerWidth <= 760; }

// ---------- 画面上部を隠す（スマホで読み取り結果を見やすくする）----------
// 工程のボタンを隠し、今の工程名だけを上に出す。端末ごとに覚えておく
function setFolded(on) {
  document.querySelector('header').classList.toggle('folded', on);
  $('btnFold').textContent = on ? '▼ 工程' : '▲ 工程';
  lsSet('koutei_fold', on);
}
$('btnFold').onclick = () => setFolded(!document.querySelector('header').classList.contains('folded'));
setFolded(lsGet('koutei_fold') === true);

// スマホ用：カメラのすぐ下に最新の結果を1行で出す。結果カードが変わるたびに、その見出しとP.Noを写す
new MutationObserver(() => {
  const res = $('result');
  const head = res.querySelector('.rhead');
  if (!head) return;
  const pno = res.querySelector('.pno');
  const extra = res.querySelector('.missnote, .skipnote, .count');
  const mini = $('mini');
  mini.className = 'mini ' + ['ok', 'complete', 'warn', 'ng'].filter(c => res.classList.contains(c)).join(' ');
  mini.innerHTML = esc(head.textContent) +
    '<span class="sub">' + esc(pno ? pno.textContent : '') + (extra ? '　' + esc(extra.textContent) : '') + '</span>';
}).observe($('result'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

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
  const r = rowOf(item.proc, item.pno);
  item.entry = addRecent('sending', item.pno, item.proc, '送信中…');
  if (!r) {
    item.predicted = 'unknown';
    showPendingCard(item);
    return;
  }
  item.snapshot = { done: Object.assign({}, r.done), count: Object.assign({}, r.count) };
  if (item.proc === 'MASK' && !needsMask(r)) {
    item.predicted = 'nomask';
    sound('warn');
  } else if (isDoneFor(r, item.proc)) {
    item.predicted = 'already';
    sound('warn');
  } else {
    predictApply(item);
    item.predicted = 'ok';
    sound(item.missing.length ? 'warn' : isDoneFor(r, item.proc) ? 'complete' : 'ok');
  }
  S.shown = item.rid;
  renderResult({ result: item.predicted, row: r, count: item.predicted === 'already' ? r.qty : countOf(r, item.proc),
    qty: r.qty, completed: isDoneFor(r, item.proc), skipped: item.skips, missing: item.missing, pending: true }, item);
  markListDirty();
}

/** マスキングが要る品か：COLORに「+」（2色）がある品だけ。例 070 → 不要、070+KH3 → 必要 */
function needsMask(r) {
  return /[+＋]/.test(String(r.color || ''));
}

/** 予測した結果を手元の一覧に反映する */
function predictApply(item) {
  const r = rowOf(item.proc, item.pno);
  if (!r || isDoneFor(r, item.proc)) return;
  // FRPは1回読めば完了（数量は数えない）。前の工程が無いのでスキップも無い
  item.skips = [];
  item.missing = [];
  if (isFrp(item.proc)) {
    r.count = Object.assign({}, r.count, { FRP: r.qty });
    r.done = Object.assign({}, r.done, { FRP: true });
    return;
  }
  const next = item.opts.all ? r.qty : Math.min(r.qty, countOf(r, item.proc) + 1);
  r.count = Object.assign({}, r.count, { [item.proc]: next });
  if (next >= r.qty && hasCol(item.proc)) r.done = Object.assign({}, r.done, { [item.proc]: true });

  // 飛ばされた前の工程はスキップ扱い（未着手の工程だけ。最終的な判定はサーバーが行う）
  const idx = S.processes.findIndex(p => p.code === item.proc);
  const maskIdx = S.processes.findIndex(p => p.code === 'MASK');
  // +ありの品のマスキングは必須なので飛ばさず、済んでいなければ警告する
  if (needsMask(r) && idx > maskIdx && !isDoneFor(r, 'MASK')) item.missing = ['MASK'];
  item.skips = S.processes.slice(0, idx)
    .filter(p => p.code !== 'STOCK' && !isFrp(p.code) && !(p.code === 'MASK' && needsMask(r)) &&
      !isDoneFor(r, p.code) && countOf(r, p.code) === 0)
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
    const token = S.token;
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
    // 途中でログアウトした（別の人がログインし直した場合も）。今の人の送信待ちには触らない
    if (S.token !== token) break;
    S.queue.shift();
    if (res) reconcile(item, res);
    else fail(item, error);
    updatePending();
  }
  S.sending = false;
  if (S.queue.length && S.token) pump(); // 入れ替わった人の送信待ちを続けて送る
}

/** サーバーの結果で確定させる。予測と違ったときだけ音と表示で知らせる */
function reconcile(item, j) {
  const r = rowOf(item.proc, item.pno);
  // 完了として記録されなかったときは、手元で先に付けた「仮の完了」を元に戻す
  if (j.result !== 'ok' && r && item.snapshot) { r.done = item.snapshot.done; r.count = item.snapshot.count; }
  if (j.row) mergeRow(j.row, item.proc, j.result === 'ok' ? j.count : null);
  if (r && j.counts) r.count = j.counts;
  const changed = j.result !== item.predicted;
  if (j.result === 'ok') {
    if (S.proc === item.proc) S.last = { id: j.id, pno: item.pno, proc: item.proc, qty: j.qty };
    const missing = j.missing && j.missing.length;
    if (changed) sound(missing ? 'warn' : j.completed ? 'complete' : 'ok');
    else if (missing && !(item.missing && item.missing.length)) sound('warn');
    const skip = skipText(j.skipped);
    setRecent(item.entry, (j.skipped && j.skipped.length) || missing ? 'warn' : 'ok',
      (j.qty > 1 ? j.count + '/' + j.qty + (j.completed ? ' 完了' : '') : '完了') + (skip ? '（' + skip + '）' : '') +
      (missing ? '（マスキング未完了）' : ''));
  } else if (j.result === 'nomask') {
    if (changed) sound('warn');
    setRecent(item.entry, 'warn', 'マスキング対象外（+なし）');
  } else if (j.result === 'already') {
    if (changed) sound('warn');
    setRecent(item.entry, 'warn', '完了済み（警告）');
  } else if (j.result === 'shipped') {
    sound('warn');
    setRecent(item.entry, 'warn', '出荷済み');
  } else if (j.result === 'notfrp') {
    sound('warn');
    setRecent(item.entry, 'warn', 'FRPの一覧にない');
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
  const r = rowOf(item.proc, item.pno);
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
  const r = rowOf(proc, row.pno);
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
  if (j.result === 'shipped' || j.result === 'notfound' || j.result === 'notfrp' || j.result === 'nomask') {
    const msg = {
      shipped: ['出荷済みです', 'DONEシートにあります。'],
      notfound: ['マスターに見つかりません', 'ラベルの読み間違いか、未登録のP.Noです。'],
      notfrp: ['FRPの対象外です', 'FRP実績（2Fシート）にないP.Noです。工程の選び間違いに注意してください。'],
      nomask: ['マスキングの対象外です', 'COLORに「+」がない品（1色）はマスキング不要です。工程の選び間違いに注意してください。'],
    }[j.result];
    el.className = 'card ' + (j.result === 'notfound' ? 'ng' : 'warn');
    el.innerHTML = '<div class="rhead">' + msg[0] + '</div>' +
      '<div class="pno">' + esc(item.pno) + '</div>' +
      '<div class="muted">' + msg[1] + '（警告として記録）</div>';
    return;
  }
  const r = rowOf(item.proc, item.pno) || j.row;
  let head, cls;
  if (j.result === 'already') { head = '⚠ ' + proc + 'は完了済みです'; cls = 'warn'; }
  else if (j.completed) { head = '✔ ' + proc + ' 完了'; cls = 'complete'; }
  else { head = proc + ' 1個カウント'; cls = 'ok'; }
  el.className = 'card ' + cls;

  const showAll = j.result === 'ok' && !j.completed && j.qty > 1;
  const canUndo = !j.pending && j.result === 'ok' && S.last && S.last.id === j.id;
  const skipped = j.result === 'ok' ? (j.skipped || []) : [];
  // FRPの行は2Fシートから来ていて他の工程の状態を持たないので、工程の表示はマスターの行に重ねる
  const master = isFrp(item.proc) ? S.byPno.get(item.pno) : null;
  const stepDone = master ? Object.assign({}, master.done, { FRP: r.done.FRP }) : r.done;
  el.innerHTML =
    '<div class="rhead">' + head + (j.round > 1 ? '（' + j.round + '回目）' : '') + '</div>' +
    '<div class="pno">' + esc(r.pno) + '</div>' +
    '<div>' + esc(r.code) + '　' + esc(r.name) + '</div>' +
    '<div class="muted">注番 ' + esc(r.cno) + '／色 ' + esc(r.color) + '／出荷 ' + esc(r.due) + '</div>' +
    '<div class="count">' + (j.qty > 1 ? j.qty + '個中 ' + j.count + '個' : '数量 1') + '</div>' +
    (skipped.length ? '<div class="skipnote">' + esc(skipText(skipped)) + '（飛ばした工程を済にしました）</div>' : '') +
    (j.result === 'ok' && j.missing && j.missing.length ? '<div class="missnote">⚠ マスキングが未完了です（COLORに「+」があるのでマスキングが必要な品）</div>' : '') +
    '<div class="steps">' + S.processes.map(p =>
      '<span class="' + (skipped.indexOf(p.code) >= 0 ? 'skip ' : stepDone[p.code] ? 'done ' : '') +
        (p.code === item.proc ? 'cur' : '') + '">' + esc(p.name) + '</span>'
    ).join('') + '</div>' +
    '<div class="sendstate">' + (j.pending ? '送信中…' : '記録しました') + '</div>' +
    '<div class="actions">' +
      (showAll ? '<button class="btn green" id="btnAll">全数完了（残り' + (j.qty - j.count) + '個）</button>' : '') +
      (canUndo ? '<button class="btn orange" id="btnUndo">取り消し</button>' : '') +
      (isFrp(item.proc) ? '' : '<button class="btn red" id="btnRecoat">リコート</button>') +
    '</div>';
  if (showAll) $('btnAll').onclick = () => {
    if (confirm(r.pno + ' の残り' + (j.qty - j.count) + '個を完了にしますか？')) enqueue(r.pno, { all: true });
  };
  if (canUndo) $('btnUndo').onclick = undoLast;
  if (!isFrp(item.proc)) $('btnRecoat').onclick = () => openRecoat(r, item.proc);
}

// ---------- リコート ----------
const RC = { row: null, proc: '', back: '', reason: '', qty: 1 };

function openRecoat(r, proc) {
  Object.assign(RC, { row: r, proc: proc, back: '', reason: '', qty: 1 });
  const idx = S.processes.findIndex(p => p.code === proc);
  // 戻し先は今の工程まで（完了・FRPは選べない）
  const backs = S.processes.slice(0, idx + 1).filter(p => p.code !== 'STOCK' && !isFrp(p.code));
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
$('btnMode').onclick = () => {
  sound();
  if (isFrp(S.proc) && !S.recoatMode) { toast('FRPではリコートできません'); return; }
  setRecoatMode(!S.recoatMode);
};

function recoatByPno(pno) {
  const r = rowOf(S.proc, pno);
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
    const r = rowOf(req.process, req.pno);
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
    const r = rowOf(last.proc, last.pno);
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
      // スマホでは映像を横長（4:3）にして高さを抑え、すぐ下の読み取り結果が画面に入るようにする
      Object.assign({ fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
        isPhone() ? { aspectRatio: 4 / 3 } : {}),
      onDecode,
      () => {}
    );
    $('camMsg').textContent = 'QRコードを枠に入れてください';
    // スマホではカメラが画面の上に来るまでスクロールする（上部の見出しの下にぴったり付ける）
    if (isPhone()) {
      const top = $('reader').getBoundingClientRect().top + window.scrollY - document.querySelector('header').offsetHeight - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
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
  const set = new Set(listRows(S.proc).map(r => r.due).filter(d => dueKey(d) !== null));
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

// 品によって無いことがある工程。次がこの工程で未着手なら「組付/検査」のように次の候補も並べる
// （マスキングはCOLORの「+」で要・不要が決まるので候補にしない）
const OPTIONAL = ['ASSY'];

/** その工程の一覧に出す行。マスキングはCOLORに「+」がある品だけ */
function listRows(proc) {
  const rows = rowsFor(proc);
  return proc === 'MASK' ? rows.filter(needsMask) : rows;
}

/**
 * 製品が今いる工程。済になっている一番後ろの工程（水研〜完了）の次。
 * 返り値 { label: 表示, order: 並べ替え用の順番, code: 今いる工程（候補が2つなら先の方） }
 */
function locationOf(r) {
  if (isFrp(S.proc)) return { label: 'FRP', order: 0, code: 'FRP' };
  // 水研〜完了。マスキングの要らない品（COLORに+なし）はマスキングを飛ばす
  const back = S.processes.filter(p => !isFrp(p.code) && !(p.code === 'MASK' && !needsMask(r)));
  let last = -1;
  back.forEach((p, i) => { if (isDoneFor(r, p.code)) last = i; });
  if (last === back.length - 1) return { label: '完了', order: 99, code: '' };
  if (last < 0) {
    // 後半が未着手：FRP品でFRPが済んでいなければFRP、前半（AG列）が済んでいれば水研、それ以外は前工程
    const f = S.frpByPno && S.frpByPno.get(r.pno);
    if (f && !f.done.FRP) return { label: 'FRP', order: 0, code: 'FRP' };
    if (!r.prevDone['W.POLI']) return { label: '前工程', order: -1, code: '' };
  }
  const next = back[last + 1];
  const c = countOf(r, next.code);
  let label = next.name;
  if (OPTIONAL.indexOf(next.code) >= 0 && c === 0 && back[last + 2]) label += '/' + back[last + 2].name;
  if (c > 0) label += ' ' + c + '/' + r.qty;
  return { label: label, order: S.processes.indexOf(next) + 1, code: next.code };
}

/** 状態の列：選んだ工程が済なら「済」、そうでなければ今いる工程名（選んだ工程にいれば赤で目立たせる） */
function statusCell(r) {
  if (isDoneFor(r, S.proc)) return '<td class="st done">済</td>';
  const loc = locationOf(r);
  const here = loc.code === S.proc || loc.label.split(/[/ ]/).indexOf(procName(S.proc)) >= 0;
  return '<td class="st ' + (here ? 'todo' : 'where') + '">' + esc(loc.label) + '</td>';
}

// ---------- 並べ替え（列の見出しをタップ：昇順 → 降順 → 元の順） ----------
S.sort = { key: '', dir: 1 };
const SORT_KEYS = {
  pno: r => r.pno, brand: brandModel, name: r => r.name, color: r => r.color,
  qty: r => Number(r.qty) || 0,
  due: r => dueKey(r.due) ?? 1e9,
  loc: r => isDoneFor(r, S.proc) ? 1000 : locationOf(r).order,
};
function sortRows(rows) {
  const f = SORT_KEYS[S.sort.key];
  if (!f) return rows;
  const dir = S.sort.dir;
  return rows.map((r, i) => [f(r), i, r]).sort((a, b) => {
    const x = a[0], y = b[0];
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ja', { numeric: true });
    return c ? c * dir : a[1] - b[1]; // 同じ値は元の並びのまま
  }).map(a => a[2]);
}
document.querySelector('#tab-list thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const k = th.dataset.sort;
  if (S.sort.key !== k) S.sort = { key: k, dir: 1 };
  else if (S.sort.dir === 1) S.sort.dir = -1;
  else S.sort = { key: '', dir: 1 };
  renderList();
});
function renderSortMarks() {
  document.querySelectorAll('#tab-list th[data-sort]').forEach(th => {
    const on = th.dataset.sort === S.sort.key;
    th.classList.toggle('sorted', on);
    th.querySelector('.mark').textContent = on ? (S.sort.dir === 1 ? '▲' : '▼') : '⇅';
  });
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
  let rows = listRows(S.proc);
  if (S.view === 'date') {
    const d = S.dates[S.dateIdx];
    rows = rows.filter(r => r.due === d);
  } else {
    rows = rows.filter(r => !isDoneFor(r, S.proc));
    if (S.view === 'here') rows = rows.filter(r => r.prevDone[S.proc]);
    rows = rows.slice().sort((a, b) => (dueKey(a.due) ?? 1e9) - (dueKey(b.due) ?? 1e9));
  }
  if (q) rows = rows.filter(r => [r.code, r.cno, r.name, r.pno, r.brand, r.model].some(x => String(x).toLowerCase().includes(q)));
  rows = sortRows(rows);
  renderSortMarks();

  shownRows = rows.slice(0, MAX_ROWS);
  $('listCount').textContent = procName(S.proc) + '：' + rows.length + '件（行をタップすると完了・リコートができます）';
  $('listBody').innerHTML = shownRows.map((r, i) =>
    '<tr data-i="' + i + '">' +
    '<td>' + esc(r.pno) + '</td>' +
    '<td>' + esc(brandModel(r)) + '</td>' +
    '<td>' + esc(r.name) + (r.spec ? '<div class="muted">' + esc(r.spec) + '</div>' : '') + '</td>' +
    '<td class="colSpec">' + esc(r.color) + '</td>' +
    '<td>' + r.qty + '</td>' +
    '<td>' + esc(r.due) + '</td>' +
    statusCell(r) +
    '</tr>'
  ).join('') + (rows.length > MAX_ROWS ? '<tr><td colspan="7" class="muted">先頭' + MAX_ROWS + '件を表示中。検索で絞り込んでください。</td></tr>' : '');
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
  $('rmRecoat').classList.toggle('hidden', isFrp(S.proc));
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
    setRows(cached.rows, cached.frpRows);
    showApp();
    refresh(false);
    return;
  }
  lsDel('koutei');
  S.token = '';
  showLogin();
})();
