// 保存（IndexedDB）。楽譜とそのページは、必ず1つのトランザクションで書き込み・削除する。
const DB_NAME = 'score-auto-scroll';
const DB_VERSION = 1;

let dbPromise;
function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('scores', { keyPath: 'id' });
      d.createObjectStore('pages', { keyPath: 'id', autoIncrement: true }).createIndex('scoreId', 'scoreId');
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

// fn(tx, setResult) の中で要求を出す。トランザクションが完了したら結果を返し、失敗したら全体を取り消す。
async function run(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が取り消されました'));
    try {
      fn(tx, (v) => { result = v; });
    } catch (e) {
      try { tx.abort(); } catch { /* 既に終了 */ }
      reject(e);
    }
  });
}

export function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function describeError(e) {
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
    return '端末の保存容量が足りません。使わない楽譜を削除してからやり直してください。';
  }
  return `保存に失敗しました。（${e?.message || e}）`;
}

export function listScores() {
  return run('scores', 'readonly', (tx, set) => {
    tx.objectStore('scores').getAll().onsuccess = (e) => set(e.target.result);
  });
}

export function getScore(id) {
  return run('scores', 'readonly', (tx, set) => {
    tx.objectStore('scores').get(id).onsuccess = (e) => set(e.target.result);
  });
}

export function putScore(score) {
  return run('scores', 'readwrite', (tx) => { tx.objectStore('scores').put(score); });
}

// 楽譜とページをまとめて保存する。pages は {blob, width, height} の配列。
export function addScore(score, pages) {
  return run(['scores', 'pages'], 'readwrite', (tx) => {
    const store = tx.objectStore('pages');
    const ids = [];
    const finish = () => { score.pageIds = ids; tx.objectStore('scores').put(score); };
    if (!pages.length) return finish();
    pages.forEach((p, i) => {
      store.add({ scoreId: score.id, blob: p.blob, width: p.width, height: p.height }).onsuccess = (e) => {
        ids[i] = e.target.result;
        if (ids.filter((x) => x !== undefined).length === pages.length) finish();
      };
    });
  });
}

export function appendPages(scoreId, pages) {
  return run(['scores', 'pages'], 'readwrite', (tx, set) => {
    tx.objectStore('scores').get(scoreId).onsuccess = (e) => {
      const score = e.target.result;
      if (!score) throw new Error('楽譜が見つかりません');
      const ids = [];
      pages.forEach((p, i) => {
        tx.objectStore('pages').add({ scoreId, blob: p.blob, width: p.width, height: p.height }).onsuccess = (ev) => {
          ids[i] = ev.target.result;
          if (ids.filter((x) => x !== undefined).length === pages.length) {
            score.pageIds = [...score.pageIds, ...ids];
            score.updatedAt = Date.now();
            tx.objectStore('scores').put(score);
            set(score);
          }
        };
      });
    };
  });
}

export async function getPages(ids) {
  const out = await run('pages', 'readonly', (tx, set) => {
    const arr = new Array(ids.length);
    set(arr); // 要求の完了後に中身が埋まった状態で返る
    ids.forEach((id, i) => {
      tx.objectStore('pages').get(id).onsuccess = (e) => { arr[i] = e.target.result; };
    });
  });
  return out.filter(Boolean);
}

export function deletePage(scoreId, pageId) {
  return run(['scores', 'pages'], 'readwrite', (tx, set) => {
    tx.objectStore('scores').get(scoreId).onsuccess = (e) => {
      const score = e.target.result;
      score.pageIds = score.pageIds.filter((id) => id !== pageId);
      score.updatedAt = Date.now();
      tx.objectStore('pages').delete(pageId);
      tx.objectStore('scores').put(score);
      set(score);
    };
  });
}

export function deleteScore(id) {
  return run(['scores', 'pages'], 'readwrite', (tx) => {
    tx.objectStore('scores').delete(id);
    tx.objectStore('pages').index('scoreId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { tx.objectStore('pages').delete(cur.primaryKey); cur.continue(); }
    };
  });
}

// すべての楽譜・ページ・設定を消す。アプリ本体のキャッシュには触れない。
export function clearAll() {
  return run(['scores', 'pages', 'settings'], 'readwrite', (tx) => {
    for (const name of ['scores', 'pages', 'settings']) tx.objectStore(name).clear();
  });
}

export async function loadSettings() {
  const rows = await run('settings', 'readonly', (tx, set) => {
    tx.objectStore('settings').getAll().onsuccess = (e) => set(e.target.result);
  });
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function saveSetting(key, value) {
  return run('settings', 'readwrite', (tx) => { tx.objectStore('settings').put({ key, value }); });
}
