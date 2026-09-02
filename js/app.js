/* ============================================================
 * 新幹線 運行状況チェッカー — メインロジック
 * ------------------------------------------------------------
 *  1) 出発駅→目的駅から経路上の新幹線各線を判定
 *  2) 運行情報フィード（status.json）があれば各線の状況を表示
 *  3) 併せて各社の公式運行情報ページへ誘導
 *
 * フィードは scraper/scrape.py が生成し、GitHub Actions が
 * status.json を更新する。アプリは raw.githubusercontent.com
 * などのURLをフィードとして読む（⚙設定）。
 * ========================================================== */

const LS_KEY = 'shinkansen_unko_v2';

const DEFAULT_SETTINGS = {
  feedEnabled: false,
  feedUrl: '',
};

const FEED_URL_EXAMPLE = 'https://raw.githubusercontent.com/USER/REPO/main/status.json';

let settings = loadSettings();
let feedCache = null; // { at:number, feed:object }

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}

/* ---------- 経路探索（路線グラフ上の BFS） ---------- */

function connectionStation(lineA, lineB) {
  const a = new Set(LINES[lineA].stations);
  const shared = LINES[lineB].stations.filter(s => a.has(s));
  if (shared.length) {
    for (const p of TRANSFER_PRIORITY) if (shared.includes(p)) return { station: p };
    return { station: shared[0] };
  }
  for (const t of TRANSFERS) {
    if (t.lineA === lineA && t.lineB === lineB) return { station: t.a, station2: t.b, note: t.note };
    if (t.lineA === lineB && t.lineB === lineA) return { station: t.b, station2: t.a, note: t.note };
  }
  return null;
}

function findLinePath(fromLines, toLines) {
  const toSet = new Set(toLines);
  const queue = fromLines.map(l => [l]);
  const visited = new Set(fromLines);
  while (queue.length) {
    const path = queue.shift();
    const last = path[path.length - 1];
    if (toSet.has(last)) return path;
    for (const nextId of Object.keys(LINES)) {
      if (visited.has(nextId)) continue;
      if (connectionStation(last, nextId)) {
        visited.add(nextId);
        queue.push([...path, nextId]);
      }
    }
  }
  return null;
}

function planRoute(origin, dest) {
  if (origin === dest) return { error: '出発駅と目的駅が同じです。' };
  const oLines = STATION_LINES[origin];
  const dLines = STATION_LINES[dest];
  if (!oLines) return { error: `「${origin}」は新幹線の駅として登録されていません。` };
  if (!dLines) return { error: `「${dest}」は新幹線の駅として登録されていません。` };

  const direct = oLines.find(l => dLines.includes(l));
  if (direct) return { segments: [{ lineId: direct, from: origin, to: dest }] };

  const linePath = findLinePath(oLines, dLines);
  if (!linePath) return { error: '経路が見つかりませんでした（対応表の範囲外の可能性があります）。' };

  const segments = [];
  let curStart = origin;
  for (let i = 0; i < linePath.length; i++) {
    const lineId = linePath[i];
    if (i < linePath.length - 1) {
      const conn = connectionStation(lineId, linePath[i + 1]);
      segments.push({ lineId, from: curStart, to: conn.station, transferNote: conn.note });
      curStart = conn.station2 || conn.station;
    } else {
      segments.push({ lineId, from: curStart, to: dest });
    }
  }
  return { segments };
}

/* ---------- 運行情報フィード ---------- */

async function fetchFeed(force = false) {
  if (!settings.feedEnabled || !settings.feedUrl) return { ok: false, reason: 'disabled' };
  if (!force && feedCache && Date.now() - feedCache.at < 60_000) return { ok: true, feed: feedCache.feed };

  const sep = settings.feedUrl.includes('?') ? '&' : '?';
  const url = settings.feedUrl.trim() + sep + '_=' + Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    const feed = await res.json();
    if (!feed || typeof feed !== 'object' || !feed.lines) return { ok: false, reason: 'format' };
    feedCache = { at: Date.now(), feed };
    return { ok: true, feed };
  } catch (e) {
    return { ok: false, reason: 'network', message: String(e) };
  }
}

const LEVEL_TO_BADGE = { normal: 'normal', trouble: 'delay', suspend: 'stop', unknown: 'alert' };

/* ---------- 描画ヘルパ ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function badge(level, label) { return el('span', 'status-badge ' + level, label); }

function officialCard(opId) {
  const o = OFFICIAL[opId];
  const wrap = el('div', 'link-card');
  const a = el('a', 'link-btn', '▶ ' + o.label);
  a.href = o.url; a.target = '_blank'; a.rel = 'noopener';
  wrap.appendChild(a);
  if (o.note) wrap.appendChild(el('p', 'muted', o.note));
  return wrap;
}

function lineCard(lineId, feed) {
  const L = LINES[lineId];
  const card = el('div', 'line-card');
  card.style.setProperty('--c', L.color);

  const head = el('div', 'line-head');
  head.appendChild(el('span', 'line-name', L.name));
  head.appendChild(el('span', 'line-op',
    OPERATORS[L.op].name + (L.subOp ? ` / ${OPERATORS[L.subOp].name}（${L.subFrom}以西）` : '')));
  card.appendChild(head);

  const info = feed && feed.lines ? feed.lines[lineId] : null;
  if (info) {
    const lvl = LEVEL_TO_BADGE[info.level] || 'alert';
    card.appendChild(badge(lvl, info.label || info.level || '—'));
    if (info.text) card.appendChild(el('p', 'info-text', info.text));
    const meta = [];
    if (info.updated) meta.push(info.updated);
    meta.push('Yahoo!路線情報 経由');
    card.appendChild(el('p', 'muted', meta.join(' ／ ')));
  }

  card.appendChild(el('p', 'info-text', '👇 最新・正確な状況は公式サイトで'));
  card.appendChild(officialCard(L.op));
  if (L.subOfficial) card.appendChild(officialCard(L.subOfficial));
  return card;
}

function feedStamp(feed) {
  const p = el('p', 'feed-stamp');
  const d = feed && feed.generatedAt ? new Date(feed.generatedAt) : null;
  let when = feed && feed.generatedAt ? feed.generatedAt : '';
  if (d && !isNaN(d)) {
    const z = (n) => String(n).padStart(2, '0');
    when = `${d.getMonth() + 1}/${d.getDate()} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  p.textContent = `運行情報フィード更新: ${when}`;
  return p;
}

/* ---------- 経路検索の描画 ---------- */

async function renderResult(origin, dest) {
  const out = $('#result');
  out.innerHTML = '';

  const plan = planRoute(origin, dest);
  if (plan.error) { out.appendChild(el('div', 'notice error', plan.error)); return; }

  const summary = el('div', 'route-summary');
  summary.appendChild(el('h2', null, `${origin} → ${dest}`));
  const chips = el('div', 'chips');
  plan.segments.forEach((seg, i) => {
    const L = LINES[seg.lineId];
    const chip = el('span', 'chip');
    chip.style.setProperty('--c', L.color);
    chip.textContent = `${L.name}（${seg.from}→${seg.to}）`;
    chips.appendChild(chip);
    if (i < plan.segments.length - 1) chips.appendChild(el('span', 'arrow', '›'));
  });
  summary.appendChild(chips);
  plan.segments.filter(s => s.transferNote).forEach(s =>
    summary.appendChild(el('p', 'muted', '※ ' + s.transferNote)));
  out.appendChild(summary);

  const feed = await withFeed(out);

  const seen = new Set();
  for (const seg of plan.segments) {
    if (seen.has(seg.lineId)) continue;
    seen.add(seg.lineId);
    out.appendChild(lineCard(seg.lineId, feed));
  }

  const ref = el('div', 'ref-links');
  ref.appendChild(el('h3', null, '横断的に確認できるサイト'));
  AGGREGATORS.forEach(a => {
    const link = el('a', 'ref-link', a.label);
    link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
    ref.appendChild(link);
  });
  out.appendChild(ref);
}

// フィード取得＋状態表示。取得できたら feed オブジェクト、ダメなら null を返す
async function withFeed(out) {
  if (!settings.feedEnabled || !settings.feedUrl) return null;
  const loading = el('div', 'notice', '運行情報フィードを取得中…');
  out.appendChild(loading);
  const r = await fetchFeed();
  loading.remove();
  if (r.ok) {
    out.appendChild(feedStamp(r.feed));
    return r.feed;
  }
  out.appendChild(feedNotice(r));
  return null;
}

function feedNotice(r) {
  const div = el('div', 'notice warn');
  if (r.reason === 'http') div.textContent = `フィード取得エラー（HTTP ${r.status}）。URLを確認してください。公式リンクをご利用ください。`;
  else if (r.reason === 'format') div.textContent = 'フィードの形式が想定と違います（status.json ではない可能性）。';
  else if (r.reason === 'network') div.textContent = 'フィードに接続できませんでした（オフライン／URL誤り等）。公式リンクをご利用ください。';
  else div.textContent = 'フィードを取得できませんでした。公式リンクをご利用ください。';
  return div;
}

/* ---------- 全線一覧 ---------- */
async function renderOverview() {
  const out = $('#overview');
  out.innerHTML = '';
  const feed = await withFeed(out);
  Object.keys(LINES).forEach(id => out.appendChild(lineCard(id, feed)));
}

/* ---------- 初期化 ---------- */
function initStationInputs() {
  const dl = $('#stations');
  ALL_STATIONS.forEach(s => { const o = document.createElement('option'); o.value = s; dl.appendChild(o); });
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('#' + t.dataset.panel).classList.add('active');
      if (t.dataset.panel === 'panel-overview') renderOverview();
    });
  });
}

function initSettings() {
  const dlg = $('#settings');
  $('#open-settings').addEventListener('click', () => {
    $('#s-enabled').checked = settings.feedEnabled;
    $('#s-url').value = settings.feedUrl;
    dlg.showModal();
  });
  $('#s-example').addEventListener('click', () => { $('#s-url').value = FEED_URL_EXAMPLE; });
  $('#s-save').addEventListener('click', (e) => {
    e.preventDefault();
    settings.feedEnabled = $('#s-enabled').checked;
    settings.feedUrl = $('#s-url').value.trim();
    saveSettings();
    feedCache = null;
    dlg.close();
    updateFeedIndicator();
  });
  $('#s-cancel').addEventListener('click', (e) => { e.preventDefault(); dlg.close(); });
}

function updateFeedIndicator() {
  const ind = $('#feed-indicator');
  if (settings.feedEnabled && settings.feedUrl) {
    ind.textContent = '● フィード連携ON';
    ind.className = 'key-ind ok';
  } else {
    ind.textContent = '公式リンク方式';
    ind.className = 'key-ind';
  }
}

function initForm() {
  $('#route-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const o = $('#origin').value.trim();
    const d = $('#dest').value.trim();
    if (o && d) renderResult(o, d);
  });
  $('#swap').addEventListener('click', () => {
    const o = $('#origin'), d = $('#dest');
    [o.value, d.value] = [d.value, o.value];
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initStationInputs();
  initTabs();
  initSettings();
  initForm();
  updateFeedIndicator();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
