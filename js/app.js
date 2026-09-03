/* ============================================================
 * 新幹線 運行状況チェッカー — メインロジック
 * ------------------------------------------------------------
 *  1) 出発駅→目的駅から経路上の新幹線各線を判定（路線グラフ BFS）
 *  2) 出発／到着の日時から「乗換の目安」を概算表示（＋乗換案内へ deep link）
 *  3) 運行情報フィード（status.json）があれば各線の状況を表示
 *  4) 併せて各社の公式運行情報ページへ誘導
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

/* ---------- 乗換の目安（概算） ---------- */

function connKind(a, b) {
  return CONNECTION_KIND[[a, b].sort().join('|')] || 'transfer';
}

// 区間の所要分（路線を等間隔とみなして按分する簡易モデル）
function segMinutes(seg) {
  const L = LINES[seg.lineId];
  const i = L.stations.indexOf(seg.from);
  const j = L.stations.indexOf(seg.to);
  if (i < 0 || j < 0 || L.stations.length < 2) return L.mins || 30;
  const frac = Math.abs(j - i) / (L.stations.length - 1);
  return Math.max(5, Math.round((L.mins || 60) * frac));
}

function buildLegs(segments) {
  const legs = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    legs.push({ type: 'ride', lineId: seg.lineId, from: seg.from, to: seg.to, mins: segMinutes(seg) });
    if (k < segments.length - 1) {
      const next = segments[k + 1];
      if (seg.to !== next.from) {
        const tr = TRANSFERS.find(t =>
          (t.a === seg.to && t.b === next.from) || (t.b === seg.to && t.a === next.from));
        legs.push({ type: 'relay', from: seg.to, to: next.from, mins: (tr && tr.relayMins) || 60, note: tr && tr.note });
      } else {
        const kind = connKind(seg.lineId, next.lineId);
        legs.push({ type: 'transfer', at: seg.to, kind, mins: TRANSFER_MIN[kind] });
      }
    }
  }
  return legs;
}

function assignTimes(legs, basis, when) {
  const total = legs.reduce((s, l) => s + l.mins, 0);
  let t = new Date(basis === 'arr' ? when.getTime() - total * 60000 : when.getTime());
  const start = new Date(t);
  const timed = legs.map(l => {
    const dep = new Date(t);
    t = new Date(t.getTime() + l.mins * 60000);
    return { ...l, dep, arr: new Date(t) };
  });
  return { legs: timed, start, end: new Date(t), total };
}

function fmtDur(m) {
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? (mm ? `${h}時間${mm}分` : `${h}時間`) : `${mm}分`;
}
function fmtClock(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function yahooUrl(from, to, dt, basis) {
  const p = (n) => String(n).padStart(2, '0');
  const mm = p(dt.getMinutes());
  const q = new URLSearchParams({
    from, to,
    y: String(dt.getFullYear()), m: String(dt.getMonth() + 1), d: String(dt.getDate()),
    hh: p(dt.getHours()), m1: mm[0], m2: mm[1],
    type: basis === 'arr' ? '4' : '1',
    ticket: 'ic', expkind: '1', ws: '3', shin: '1', s: '0',
  });
  return 'https://transit.yahoo.co.jp/search/result?' + q.toString();
}

/* ---------- 運賃・料金のめやす（概算） ---------- */

const fareLookup = (a, b) => FARE_TABLE[a + '|' + b] || FARE_TABLE[b + '|' + a] || null;
const round100 = (n) => Math.round(n / 100) * 100;
const yen = (n) => (n == null ? '－' : '¥' + Math.round(n).toLocaleString('ja-JP'));

function fareCurve(km) {
  const c = FARE_CURVE;
  if (km <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (km <= c[i][0]) {
      const [k0, v0] = c[i - 1], [k1, v1] = c[i];
      return v0 + (v1 - v0) * (km - k0) / (k1 - k0);
    }
  }
  const [k1, v1] = c[c.length - 1];
  return v1 + (km - k1) * 21;
}

// グリーン料金のめやす（本州・距離帯。九州はやや安いが概算では共通）
function greenFee(km) {
  if (km <= 100) return 1300;
  if (km <= 200) return 2800;
  if (km <= 400) return 4190;
  if (km <= 600) return 5400;
  if (km <= 800) return 6600;
  return 8000;
}

function segKm(seg) {
  const L = LINES[seg.lineId];
  const i = L.stations.indexOf(seg.from), j = L.stations.indexOf(seg.to);
  if (i < 0 || j < 0 || L.stations.length < 2) return L.km || 100;
  return (L.km || 100) * Math.abs(j - i) / (L.stations.length - 1);
}

function jiyuFromShitei(s, lineId, km) {
  if (NO_JIYU.has(lineId)) return null;
  const premium = (lineId === 'tokaido' || lineId === 'sanyo' || lineId === 'kyushu');
  return round100(s - (premium ? Math.max(760, km * 1.5) : 530));
}

// 区間の運賃（{s, j, g, est}）
function segFare(seg) {
  const km = segKm(seg);
  const hit = fareLookup(seg.from, seg.to);
  if (hit) {
    // 表に j を明示（数値 or null=全車指定）。未定義のときだけ推計。
    const j = hit.j !== undefined ? hit.j : jiyuFromShitei(hit.s, seg.lineId, km);
    return { s: hit.s, j, g: round100(hit.s - 520 + greenFee(km)), est: false };
  }
  const f = LINE_FARE_FACTOR[seg.lineId] || 1.05;
  const s = round100(fareCurve(km) * f);
  return { s, j: jiyuFromShitei(s, seg.lineId, km), g: round100(s - 520 + greenFee(km)), est: true };
}

function tripFare(origin, dest, segments) {
  const rows = segments.map(seg => ({
    label: `${LINES[seg.lineId].name}（${seg.from}→${seg.to}）`,
    ...segFare(seg),
  }));

  const totalKm = segments.reduce((a, seg) => a + segKm(seg), 0);
  const anyNoJiyu = segments.some(seg => NO_JIYU.has(seg.lineId));

  // 区間の切れ目がすべて直通/一部直通か（＝実質乗り換えなし）
  const allThrough = segments.every((seg, i) =>
    i === 0 || (segments[i - 1].to === seg.from
      && ['through', 'partial'].includes(connKind(segments[i - 1].lineId, seg.lineId))));

  const through = fareLookup(origin, dest);
  let total, totalEst, totalNote;
  if (through) {
    const j = through.j !== undefined ? through.j
      : (anyNoJiyu ? null : round100(through.s - Math.max(760, totalKm * 1.5)));
    total = { s: through.s, j, g: round100(through.s - 520 + greenFee(totalKm)) };
    totalEst = false;
    totalNote = '通しの乗車券の目安';
  } else if (segments.length > 1 && allThrough) {
    // 直通なので1本の距離として概算（区間の足し算だと特急料金を二重に数えてしまう）
    const domLine = segments.slice().sort((a, b) => segKm(b) - segKm(a))[0].lineId;
    const s = round100(fareCurve(totalKm) * (LINE_FARE_FACTOR[domLine] || 1.05));
    total = {
      s,
      j: anyNoJiyu ? null : jiyuFromShitei(s, domLine, totalKm),
      g: round100(s - 520 + greenFee(totalKm)),
    };
    totalEst = true;
    totalNote = '直通の目安（概算）';
  } else {
    const sum = (k) => rows.every(r => r[k] != null) ? rows.reduce((a, r) => a + r[k], 0) : null;
    total = { s: sum('s'), j: sum('j'), g: sum('g') };
    totalEst = true;
    const hasRelay = segments.some((seg, i) => i > 0 && segments[i - 1].to !== seg.from);
    totalNote = hasRelay ? '在来線乗継を含む概算（通しの乗車券とは差が出やすい）'
      : (segments.length > 1 ? '区間ごとの合計（通しだと数百円安いことがあります）' : 'めやす');
  }
  return { rows, total, totalEst, totalNote };
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

/* ---------- 乗換の目安の描画 ---------- */

function renderItinerary(segments, origin, dest, when, basis, dateProvided) {
  const wrap = el('div', 'itinerary');
  wrap.appendChild(el('h3', null, '乗換の目安'));

  const legs = buildLegs(segments);
  const { legs: timed, start, end, total } = assignTimes(legs, basis, when);

  const baseLabel = basis === 'arr' ? '到着' : '出発';
  wrap.appendChild(el('p', 'itin-note',
    `${dateProvided ? '' : '（現在時刻を基準）'}${baseLabel} ${fmtClock(when)} 指定・所要時間はおおよその概算です。正確な時刻は下の検索から。`));

  const list = el('ul', 'itin-list');
  const timeRow = (d, place) => {
    const li = el('li', 'itin-row');
    li.appendChild(el('span', 'itin-time', fmtClock(d)));
    li.appendChild(el('span', 'itin-place', place));
    return li;
  };
  const legRow = (cls, txt) => {
    const li = el('li', 'itin-row');
    li.appendChild(el('span', 'itin-time', ''));
    li.appendChild(el('span', 'itin-leg ' + cls, txt));
    return li;
  };

  list.appendChild(timeRow(timed[0].dep, timed[0].from + ' 発'));
  timed.forEach((l) => {
    if (l.type === 'ride') {
      list.appendChild(legRow('leg-line', `${LINES[l.lineId].name}　約${fmtDur(l.mins)}`));
      list.appendChild(timeRow(l.arr, l.to + ' 着'));
    } else if (l.type === 'transfer') {
      let txt;
      if (l.kind === 'through') txt = `${l.at}：直通運転あり（別列車に乗り換える場合の目安 約${l.mins}分）`;
      else if (l.kind === 'partial') txt = `${l.at}：乗換の目安 約${l.mins}分（直通列車もあり）`;
      else txt = `${l.at}：乗換の目安 約${l.mins}分`;
      list.appendChild(legRow('leg-transfer', txt));
      list.appendChild(timeRow(l.arr, l.at + ' 発'));
    } else { // relay
      list.appendChild(legRow('leg-transfer', `${l.note || 'つなぎの在来線特急'}　約${fmtDur(l.mins)}`));
      list.appendChild(timeRow(l.arr, l.to + ' 発'));
    }
  });
  wrap.appendChild(list);

  const nTransfer = legs.filter(l => l.type === 'transfer' || l.type === 'relay').length;
  wrap.appendChild(el('p', 'itin-total',
    `総所要 約${fmtDur(total)}（${fmtClock(start)} → ${fmtClock(end)}${end.getDate() !== start.getDate() ? ' 翌日' : ''}／乗換 ${nTransfer}回）`));

  const actions = el('div', 'itin-actions');
  const y = el('a', null, 'Yahoo!路線情報で正確な時刻・運賃を検索');
  y.href = yahooUrl(origin, dest, when, basis); y.target = '_blank'; y.rel = 'noopener';
  actions.appendChild(y);
  wrap.appendChild(actions);

  return wrap;
}

/* ---------- 運賃・料金のめやすの描画 ---------- */

function renderFare(segments, origin, dest) {
  const { rows, total, totalEst, totalNote } = tripFare(origin, dest, segments);
  const wrap = el('div', 'fare-card');
  wrap.appendChild(el('h3', null, '運賃・料金のめやす'));

  const scroll = el('div', 'fare-scroll');
  const table = el('table', 'fare-table');
  const thead = el('tr', null);
  ['', '自由席', '指定席', 'グリーン車'].forEach(h => thead.appendChild(el('th', null, h)));
  table.appendChild(thead);

  const mark = (est) => (est ? ' †' : '');
  rows.forEach(r => {
    const tr = el('tr', null);
    tr.appendChild(el('td', 'fare-label', r.label + mark(r.est)));
    tr.appendChild(el('td', 'fare-num', yen(r.j)));
    tr.appendChild(el('td', 'fare-num', yen(r.s)));
    tr.appendChild(el('td', 'fare-num', yen(r.g)));
    table.appendChild(tr);
  });

  const tr = el('tr', 'fare-total');
  tr.appendChild(el('td', 'fare-label', `合計（${totalNote}）` + mark(totalEst)));
  tr.appendChild(el('td', 'fare-num', yen(total.j)));
  tr.appendChild(el('td', 'fare-num', yen(total.s)));
  tr.appendChild(el('td', 'fare-num', yen(total.g)));
  table.appendChild(tr);

  scroll.appendChild(table);
  wrap.appendChild(scroll);

  wrap.appendChild(el('p', 'itin-note',
    '大人1名・片道・通常期のめやすです（† は距離からの概算）。'
    + '割引きっぷ・早特・往復割引は含みません。正確な運賃は上の「Yahoo!路線情報」で確認してください。'));
  return wrap;
}

/* ---------- 経路検索の描画 ---------- */

async function renderResult(origin, dest, opts) {
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

  out.appendChild(renderItinerary(plan.segments, origin, dest, opts.when, opts.basis, opts.dateProvided));
  out.appendChild(renderFare(plan.segments, origin, dest));

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

// フィード取得＋状態表示。取得できたら feed オブジェクト、ダメなら null
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
function fillStationSelect(sel, defaultVal) {
  sel.innerHTML = '';
  const ph = el('option', null, '— 駅を選択 —');
  ph.value = ''; ph.disabled = true; ph.selected = true;
  sel.appendChild(ph);
  Object.values(LINES).forEach(L => {
    const og = document.createElement('optgroup');
    og.label = L.name;
    L.stations.forEach(st => {
      const o = el('option', null, st);
      o.value = st;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  if (defaultVal) sel.value = defaultVal;
}

function initInputs() {
  fillStationSelect($('#origin'), '東京');
  fillStationSelect($('#dest'), '');
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#date').value = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  $('#time').value = `${p(now.getHours())}:${p(now.getMinutes())}`;
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
    const o = $('#origin').value;
    const d = $('#dest').value;
    if (!o || !d) return;
    const basis = $('#basis').value;
    const dateStr = $('#date').value;
    const timeStr = $('#time').value;
    const dateProvided = !!(dateStr && timeStr);
    const when = dateProvided ? new Date(`${dateStr}T${timeStr}`) : new Date();
    renderResult(o, d, { basis, when, dateProvided });
  });
  $('#swap').addEventListener('click', () => {
    const o = $('#origin'), d = $('#dest');
    [o.value, d.value] = [d.value, o.value];
  });
}

window.addEventListener('DOMContentLoaded', () => {
  initInputs();
  initTabs();
  initSettings();
  initForm();
  updateFeedIndicator();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
});
