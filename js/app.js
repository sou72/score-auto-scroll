import * as db from './db.js';
import { importImages, importPdf, ImportError } from './importer.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---- 範囲と初期値（SPEC 4.10） ----
const DEFAULTS = { speed: 40, textZoom: 100, imageZoom: 100, fullscreen: true, wakeLock: true };
const ZOOM_MIN = 50, ZOOM_MAX = 300, ZOOM_STEP = 10;
const TEXT_BASE_PX = 18;
// 0〜40は2〜10px/秒（遅い側を細かく）、40〜100は10〜300px/秒
const speedToPx = (v) => (v <= 40 ? 2 * Math.pow(5, v / 40) : 10 * Math.pow(30, (v - 40) / 60));
const speedLabel = (v) => (v <= 33 ? 'おそい' : v <= 66 ? 'ふつう' : 'はやい');

let settings = { ...DEFAULTS };

// ---- 共通の小さな部品 ----
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// buttons: [{label, primary, danger, onClick}]。onClick が false を返すと閉じない。
function openDialog({ title, body, buttons }) {
  const dlg = $('#dlg');
  $('#dlg-title').textContent = title;
  $('#dlg-body').replaceChildren(...(body ? [].concat(body) : []));
  const box = $('#dlg-buttons');
  box.replaceChildren(...buttons.map((b) => el('button', {
    type: 'button',
    textContent: b.label,
    className: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
    onclick: () => { if (b.onClick?.() !== false) dlg.close(); },
  })));
  if (!dlg.open) dlg.showModal();
  return dlg;
}
const closeDialog = () => { if ($('#dlg').open) $('#dlg').close(); };
const alertDialog = (message, title = 'お知らせ') =>
  openDialog({ title, body: el('p', { textContent: message }), buttons: [{ label: '閉じる', primary: true }] });
const confirmDialog = (message, okLabel, onOk) =>
  openDialog({ title: '確認', body: el('p', { textContent: message }),
    buttons: [{ label: okLabel, danger: true, onClick: onOk }, { label: 'やめる' }] });
function textDialog(title, value, onOk) {
  const input = el('input', { type: 'text', value });
  openDialog({ title, body: el('label', { className: 'field' }, input),
    buttons: [{ label: '決定', primary: true, onClick: () => onOk(input.value.trim()) }, { label: 'やめる' }] });
  input.select();
}

async function withBusy(text, task) {
  const busy = $('#busy');
  const bar = $('#busy-bar');
  $('#busy-text').textContent = text;
  bar.value = 0;
  busy.hidden = false;
  try {
    return await task((done, total) => {
      $('#busy-text').textContent = total > 1 ? `${text}（${Math.min(done + 1, total)} / ${total} ページ）` : text;
      bar.value = total ? done / total : 0;
    });
  } finally {
    busy.hidden = true;
  }
}

function errorMessage(e) {
  return e instanceof ImportError ? e.message : db.describeError(e);
}

// ---- 保存（要求できる場合は、データを勝手に消さないよう頼む） ----
let persistAsked = false;
async function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { await navigator.storage?.persist?.(); } catch { /* 非対応 */ }
}
async function saveScore(score) {
  try {
    await db.putScore(score);
    askPersist();
    return true;
  } catch (e) {
    alertDialog(db.describeError(e), '保存できませんでした');
    return false;
  }
}

function autoTitle(body) {
  const line = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 40) : '無題の楽譜';
}
const fmtDate = (t) => new Date(t).toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });

function newScore(kind, title, extra = {}) {
  const now = Date.now();
  return {
    id: db.newId(), title, titleCustom: kind === 'image', kind, body: '', pageIds: [],
    speed: settings.speed,
    zoom: kind === 'text' ? settings.textZoom : settings.imageZoom,
    createdAt: now, updatedAt: now, ...extra,
  };
}

// ---- 画面切り替えと画面ごとの後始末 ----
const screens = ['list', 'player', 'editor', 'settings'];
let currentLeave = null;
function show(name) {
  for (const s of screens) $(`#screen-${s}`).hidden = s !== name;
}
const go = (hash) => { location.hash = hash; };

let routeChain = Promise.resolve();
function route() {
  routeChain = routeChain.then(async () => {
    if (currentLeave) { const f = currentLeave; currentLeave = null; await f(); }
    const [, name, arg] = location.hash.split('/');
    if (name === 'play') await openPlayer(arg);
    else if (name === 'edit') await openEditor(arg);
    else if (name === 'settings') openSettings();
    else await openList();
  }).catch((e) => { console.error(e); alertDialog(db.describeError(e), 'エラー'); });
}

// ======================================================================
// 3.1 楽譜一覧
// ======================================================================
async function openList() {
  show('list');
  await renderList();
}

async function renderList() {
  const scores = (await db.listScores()).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  $('#empty-msg').hidden = scores.length > 0;
  $('#score-list').replaceChildren(...scores.map((s) => {
    const sub = s.kind === 'text' ? '文字' : `画像・PDF（${s.pageIds.length}ページ）`;
    return el('li', { className: 'item' },
      el('button', { type: 'button', className: 'item-main', onclick: () => go(`#/play/${s.id}`) },
        el('span', { className: 'item-title', textContent: s.title }),
        el('span', { className: 'item-sub', textContent: `${sub} ・ ${fmtDate(s.updatedAt)}` })),
      el('button', { type: 'button', className: 'btn', textContent: '⋯ メニュー', onclick: () => scoreMenu(s) }));
  }));
}

function scoreMenu(s) {
  openDialog({
    title: s.title,
    buttons: [
      { label: '名前を変える', onClick: () => { setTimeout(() => renameScore(s), 0); } },
      { label: '内容を編集する', onClick: () => { go(`#/edit/${s.id}`); } },
      { label: '削除する', danger: true, onClick: () => { setTimeout(() => deleteScoreWithConfirm(s), 0); } },
      { label: '閉じる' },
    ],
  });
}

function renameScore(s) {
  textDialog('名前を変える', s.title, (name) => {
    if (!name) { toast('名前を入力してください'); return false; }
    s.title = name; s.titleCustom = true; s.updatedAt = Date.now();
    saveScore(s).then((ok) => ok && renderList());
  });
}

function deleteScoreWithConfirm(s) {
  confirmDialog(`「${s.title}」を削除します。元に戻せません。よろしいですか？`, '削除する', () => {
    db.deleteScore(s.id).then(renderList).catch((e) => alertDialog(db.describeError(e), '削除できませんでした'));
  });
}

function addMenu() {
  openDialog({
    title: '楽譜を追加',
    buttons: [
      { label: '文字を貼り付ける', onClick: () => { go('#/edit/new'); } },
      { label: '写真・画像を選ぶ', onClick: () => { pickFiles('#file-image', (files) => addImageScore(files)); } },
      { label: 'PDFを選ぶ', onClick: () => { pickFiles('#file-pdf', (files) => addPdfScore(files[0])); } },
      { label: 'やめる' },
    ],
  });
}

// ファイル選択は、ボタンを押した操作の中で直接 click() を呼ぶ必要がある
function pickFiles(selector, handler) {
  const input = $(selector);
  input.value = '';
  input.onchange = () => { const files = [...input.files]; input.value = ''; if (files.length) handler(files); };
  input.click();
}

const baseName = (f) => f.name.replace(/\.[^.]+$/, '') || '無題の楽譜';

async function createImageScore(title, task, text) {
  try {
    const pages = await withBusy(text, task);
    const score = newScore('image', title);
    await db.addScore(score, pages);
    askPersist();
    go(`#/play/${score.id}`);
  } catch (e) {
    alertDialog(errorMessage(e), '取り込めませんでした');
  }
}
const addImageScore = (files) => createImageScore(
  files.length === 1 ? baseName(files[0]) : `写真の楽譜 ${fmtDate(Date.now())}`,
  (p) => importImages(files, p), '画像を取り込み中');
const addPdfScore = (file) => createImageScore(baseName(file), (p) => importPdf(file, p), 'PDFを取り込み中');

// ======================================================================
// 3.2 演奏画面
// ======================================================================
const P = { score: null, urls: [], playing: false, raf: 0, lastT: 0, pos: 0, lastSet: 0, touching: false, saveTimer: 0, wake: null };

async function openPlayer(id) {
  const score = id && await db.getScore(id);
  if (!score) { go('#/'); toast('楽譜が見つかりません'); return; }
  P.score = score;
  show('player');
  $('#screen-player').classList.remove('playing');
  $('#player-title').textContent = score.title;
  const content = $('#content');
  if (score.kind === 'text') {
    content.className = 'text';
    content.textContent = score.body; // HTMLとして解釈しない
  } else {
    const pages = await db.getPages(score.pageIds);
    content.className = 'pages';
    content.replaceChildren(...pages.map((pg) => {
      const url = URL.createObjectURL(pg.blob);
      P.urls.push(url);
      const img = el('img', { src: url, alt: '', draggable: false, width: pg.width, height: pg.height });
      img.style.aspectRatio = `${pg.width} / ${pg.height}`;
      return img;
    }));
    if (!pages.length) content.textContent = 'ページがありません。「⋯ メニュー」から内容を編集してください。';
  }
  applyZoom(false);
  $('#viewer').scrollTop = 0;
  $('#viewer').scrollLeft = 0;
  syncSpeedUi();
  setPlaying(false);
  currentLeave = leavePlayer;
}

async function leavePlayer() {
  setPlaying(false);
  await releaseImmersive();
  await flushScoreSave();
  P.urls.forEach((u) => URL.revokeObjectURL(u));
  P.urls = [];
  $('#content').replaceChildren();
  P.score = null;
}

function currentPx() { return speedToPx(P.score.speed); }

function syncSpeedUi() {
  const v = Math.round(P.score.speed);
  $('#speed').value = v;
  $('#speed-out').textContent = `${speedLabel(v)}（${v}）`;
}

function saveScoreSoon() {
  clearTimeout(P.saveTimer);
  P.saveTimer = setTimeout(flushScoreSave, 400);
}
async function flushScoreSave() {
  clearTimeout(P.saveTimer);
  P.saveTimer = 0;
  if (P.score) await saveScore(P.score);
}

function applyZoom(keepPosition = true) {
  const v = $('#viewer');
  const ratio = keepPosition && v.scrollHeight ? v.scrollTop / v.scrollHeight : 0;
  const z = P.score.zoom;
  if (P.score.kind === 'text') {
    $('#content').style.fontSize = `${(TEXT_BASE_PX * z) / 100}px`;
    $('#content').style.width = '';
  } else {
    $('#content').style.width = `${z}%`;
  }
  if (keepPosition) { v.scrollTop = ratio * v.scrollHeight; P.pos = v.scrollTop; P.lastSet = v.scrollTop; }
}

function changeZoom(delta) {
  const z = clamp(P.score.zoom + delta, ZOOM_MIN, ZOOM_MAX);
  if (z === P.score.zoom) { toast(delta > 0 ? 'これ以上、拡大できません' : 'これ以上、縮小できません'); return; }
  P.score.zoom = z;
  applyZoom();
  saveScoreSoon();
  toast(`大きさ ${z}%`, 1200);
}

function setPlaying(on) {
  if (on === P.playing && !(on && !P.raf)) return;
  P.playing = on;
  cancelAnimationFrame(P.raf);
  P.raf = 0;
  $('#btn-play').textContent = on ? '一時停止' : '再生';
  $('#screen-player').classList.toggle('playing', on);
  if (on) {
    const v = $('#viewer');
    P.pos = v.scrollTop; P.lastSet = v.scrollTop; P.lastT = 0;
    P.raf = requestAnimationFrame(tick);
  }
}

function tick(t) {
  if (!P.playing) return;
  const v = $('#viewer');
  if (P.lastT) {
    let dt = (t - P.lastT) / 1000;
    if (dt > 0.25) dt = 0; // 裏に回っていた間は進めない
    // 指でスクロールされたら、その位置から続ける
    if (P.touching || Math.abs(v.scrollTop - P.lastSet) > 2) {
      P.pos = v.scrollTop;
    } else {
      P.pos += currentPx() * dt;
      const max = v.scrollHeight - v.clientHeight;
      if (P.pos >= max - 0.5) { v.scrollTop = max; setPlaying(false); toast('最後まで表示しました'); return; }
      v.scrollTop = P.pos;
    }
    P.lastSet = v.scrollTop;
  }
  P.lastT = t;
  P.raf = requestAnimationFrame(tick);
}

async function togglePlay() {
  if (P.playing) { setPlaying(false); return; }
  const v = $('#viewer');
  if (v.scrollTop >= v.scrollHeight - v.clientHeight - 1 && v.scrollTop > 0) v.scrollTop = 0; // 末尾からは先頭へ戻して再生
  setPlaying(true);
  await enterImmersive();
}

// ---- 4.9 全画面表示・消灯防止（非対応なら何もしない） ----
async function acquireWake() {
  try {
    if (!navigator.wakeLock || P.wake) return;
    P.wake = await navigator.wakeLock.request('screen');
    P.wake.addEventListener('release', () => { P.wake = null; });
  } catch { /* 非対応・拒否 */ }
}
async function enterImmersive() {
  if (settings.fullscreen && !document.fullscreenElement) {
    try { await document.documentElement.requestFullscreen?.(); } catch { /* 非対応 */ }
  }
  if (settings.wakeLock) await acquireWake();
}
async function releaseImmersive() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* 無視 */ }
  try { await P.wake?.release(); } catch { /* 無視 */ }
  P.wake = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    P.lastT = 0; // その間の時間を進めない
    if (P.playing && settings.wakeLock) acquireWake();
  }
});

function setupPlayer() {
  $('#btn-back').onclick = () => go('#/');
  $('#btn-play').onclick = togglePlay;
  $('#btn-top').onclick = () => { const v = $('#viewer'); v.scrollTop = 0; P.pos = 0; P.lastSet = 0; };
  $('#btn-zoom-in').onclick = () => changeZoom(ZOOM_STEP);
  $('#btn-zoom-out').onclick = () => changeZoom(-ZOOM_STEP);
  $('#speed').oninput = (e) => {
    P.score.speed = +e.target.value;
    syncSpeedUi();
    saveScoreSoon();
  };
  $('#btn-player-menu').onclick = playerMenu;

  // 表示部分のタップで再生／一時停止。なぞった場合は切り替えない
  const v = $('#viewer');
  let down = null;
  v.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; P.touching = true; });
  v.addEventListener('pointerup', (e) => {
    P.touching = false;
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved < 10 && quick) togglePlay();
  });
  v.addEventListener('pointercancel', () => { P.touching = false; down = null; });
  v.addEventListener('wheel', () => { /* マウスホイールのスクロールは tick が検出する */ }, { passive: true });
}

function playerMenu() {
  openDialog({
    title: P.score.title,
    buttons: [
      { label: '内容を編集する', onClick: () => { go(`#/edit/${P.score.id}`); } },
      { label: '閉じる', primary: true },
    ],
  });
}

// ======================================================================
// 3.3 編集画面
// ======================================================================
const E = { score: null, chain: Promise.resolve(), timer: 0, urls: [] };

async function openEditor(id) {
  E.score = null;
  if (id && id !== 'new') {
    E.score = await db.getScore(id);
    if (!E.score) { go('#/'); toast('楽譜が見つかりません'); return; }
  }
  show('editor');
  const isImage = E.score?.kind === 'image';
  $('#ed-text-wrap').hidden = isImage;
  $('#ed-image-wrap').hidden = !isImage;
  $('#ed-title').value = E.score?.title ?? '';
  $('#ed-body').value = E.score?.body ?? '';
  $('#ed-status').textContent = '入力すると自動で保存されます。';
  $('#btn-edit-play').hidden = !E.score;
  if (isImage) await renderEditorPages();
  currentLeave = leaveEditor;
}

async function leaveEditor() {
  await flushEditorSave();
  E.urls.forEach((u) => URL.revokeObjectURL(u));
  E.urls = [];
  $('#ed-pages').replaceChildren();
  E.score = null;
}

function editorChanged() {
  clearTimeout(E.timer);
  E.timer = setTimeout(flushEditorSave, 500);
  $('#ed-status').textContent = '保存中…';
}

function flushEditorSave() {
  clearTimeout(E.timer);
  E.timer = 0;
  E.chain = E.chain.then(async () => {
    const title = $('#ed-title').value.trim();
    const body = $('#ed-body').value;
    let s = E.score;
    if (!s) {
      if (!body.trim() && !title) return; // 空のまま楽譜は作らない
      s = newScore('text', title || autoTitle(body));
      s.titleCustom = !!title;
    }
    if (s.kind === 'text') {
      s.body = body;
      if (title && title !== s.title) { s.title = title; s.titleCustom = true; }
      else if (!title) { s.titleCustom = false; }
      if (!s.titleCustom) s.title = autoTitle(body);
    } else if (title) {
      s.title = title; s.titleCustom = true;
    }
    s.updatedAt = Date.now();
    if (await saveScore(s)) {
      E.score = s;
      if (!s.titleCustom && document.activeElement !== $('#ed-title')) $('#ed-title').value = s.title;
      $('#btn-edit-play').hidden = false;
      $('#ed-status').textContent = '保存しました。';
    } else {
      $('#ed-status').textContent = '保存できませんでした。';
    }
  });
  return E.chain;
}

async function renderEditorPages() {
  E.urls.forEach((u) => URL.revokeObjectURL(u));
  E.urls = [];
  const pages = await db.getPages(E.score.pageIds);
  const last = pages.length - 1;
  $('#ed-pages').replaceChildren(...pages.map((pg, i) => {
    const url = URL.createObjectURL(pg.blob);
    E.urls.push(url);
    const btn = (label, onclick, props = {}) => el('button', { type: 'button', className: 'btn', textContent: label, onclick, ...props });
    return el('li', { className: 'item item-page' },
      el('img', { className: 'thumb', src: url, alt: '' }),
      el('span', { className: 'item-main' }, el('span', { className: 'item-title', textContent: `${i + 1} ページ目` })),
      btn('↑ 上へ', () => movePage(i, -1), { disabled: i === 0 }),
      btn('↓ 下へ', () => movePage(i, 1), { disabled: i === last }),
      btn('削除', () => removePage(pg.id), { className: 'btn danger' }));
  }));
}

async function movePage(i, d) {
  const ids = [...E.score.pageIds];
  [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
  E.score.pageIds = ids;
  E.score.updatedAt = Date.now();
  if (await saveScore(E.score)) await renderEditorPages();
}

function removePage(pageId) {
  if (E.score.pageIds.length <= 1) {
    alertDialog('最後の1ページは削除できません。楽譜ごと消す場合は、一覧の「⋯ メニュー」から削除してください。');
    return;
  }
  confirmDialog('このページを削除します。元に戻せません。', '削除する', () => {
    db.deletePage(E.score.id, pageId).then((s) => { E.score = s; return renderEditorPages(); })
      .catch((e) => alertDialog(db.describeError(e), '削除できませんでした'));
  });
}

async function appendToScore(task, text) {
  try {
    await flushEditorSave();
    const pages = await withBusy(text, task);
    E.score = await db.appendPages(E.score.id, pages);
    await renderEditorPages();
    toast(`${pages.length}ページを追加しました`);
  } catch (e) {
    alertDialog(errorMessage(e), '追加できませんでした');
  }
}

function setupEditor() {
  $('#ed-title').oninput = editorChanged;
  $('#ed-body').oninput = editorChanged;
  $('#btn-edit-back').onclick = async () => { await flushEditorSave(); go('#/'); };
  $('#btn-edit-play').onclick = async () => { await flushEditorSave(); if (E.score) go(`#/play/${E.score.id}`); };
  $('#ed-add-image').onclick = () => pickFiles('#file-image', (files) => appendToScore((p) => importImages(files, p), '画像を取り込み中'));
  $('#ed-add-pdf').onclick = () => pickFiles('#file-pdf', (files) => appendToScore((p) => importPdf(files[0], p), 'PDFを取り込み中'));
}

// ======================================================================
// 3.4 設定画面
// ======================================================================
function setSetting(key, value) {
  settings[key] = value;
  db.saveSetting(key, value).catch((e) => alertDialog(db.describeError(e), '保存できませんでした'));
}

function zoomOptions(select, current, key) {
  select.replaceChildren();
  for (let z = ZOOM_MIN; z <= ZOOM_MAX; z += ZOOM_STEP) select.append(el('option', { value: z, textContent: `${z}%` }));
  select.value = current;
  select.onchange = () => setSetting(key, +select.value);
}

function setupSettings() {
  $('#btn-settings').onclick = () => go('#/settings');
  $('#btn-settings-back').onclick = () => go('#/');
  $('#btn-add').onclick = addMenu;

  const sp = $('#st-speed');
  const showSpeed = () => { $('#st-speed-out').textContent = `${speedLabel(+sp.value)}（${sp.value}）`; };
  sp.value = settings.speed; showSpeed();
  sp.oninput = () => { showSpeed(); setSetting('speed', +sp.value); };
  zoomOptions($('#st-text-zoom'), settings.textZoom, 'textZoom');
  zoomOptions($('#st-image-zoom'), settings.imageZoom, 'imageZoom');
  $('#st-fullscreen').checked = settings.fullscreen;
  $('#st-fullscreen').onchange = (e) => setSetting('fullscreen', e.target.checked);
  const wl = $('#st-wakelock');
  wl.checked = settings.wakeLock;
  wl.onchange = (e) => setSetting('wakeLock', e.target.checked);
  if (!('wakeLock' in navigator)) { wl.disabled = true; $('#st-wakelock-note').hidden = false; }
}

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`);

async function openSettings() {
  show('settings');
  const info = $('#st-storage');
  const rows = [];
  const row = (k, v) => rows.push(el('dt', { textContent: k }), el('dd', { textContent: v }));
  try {
    const est = await navigator.storage?.estimate?.();
    row('使用容量', est?.usage != null ? `${fmtBytes(est.usage)}${est.quota ? `（上限の目安 ${fmtBytes(est.quota)}）` : ''}` : '調べられません');
  } catch { row('使用容量', '調べられません'); }
  try {
    const p = await navigator.storage?.persisted?.();
    row('データの保護', p ? '保護されています' : '保護されていません（ブラウザの判断で消える場合があります）');
  } catch { row('データの保護', '調べられません'); }
  const offline = !!(await (window.caches?.match('index.html').catch(() => null)));
  row('オフライン', offline ? '通信なしで使えます' : 'まだ準備ができていません（通信できる場所で一度開いてください）');
  info.replaceChildren(...rows);
}

// ======================================================================
// 起動
// ======================================================================
function updateOnline() { $('#offline-badge').hidden = navigator.onLine; }

async function main() {
  try { settings = { ...DEFAULTS, ...(await db.loadSettings()) }; }
  catch (e) { alertDialog(`保存領域を開けませんでした。プライベートブラウズでは使えない場合があります。（${e?.message || e}）`, 'エラー'); }
  setupPlayer();
  setupEditor();
  setupSettings();
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
}
main();
