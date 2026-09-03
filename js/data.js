/* ============================================================
 * 新幹線の路線・駅・乗換・公式運行情報リンクの定義
 * ------------------------------------------------------------
 * LINES     : 各新幹線の駅を「起点→終点」の順に並べた配列
 * TRANSFERS : 駅名が一致しない実際の乗継ぎ（在来線リレー等）
 * OFFICIAL  : 事業者ごとの公式運行情報ページ
 *
 * 路線ID（tohoku 等）は scraper/scrape.py の LINES および
 * status.json の lines のキーと一致させること。
 * ========================================================== */

/* 事業者 */
const OPERATORS = {
  jre: { name: 'JR東日本' },
  jrc: { name: 'JR東海' },
  jrw: { name: 'JR西日本' },
  jrk: { name: 'JR九州' },
  jrh: { name: 'JR北海道' },
};

/* 路線定義（駅は運行区間の順）
 * mins : 全区間を最速達列車で乗り通した場合のおおよその所要分（乗換目安の概算用）。
 *        駅間は等間隔とみなして按分する簡易モデル。正確な時刻は乗換案内で。 */
const LINES = {
  tohoku: {
    name: '東北新幹線', op: 'jre', color: '#00a650', mins: 185,
    stations: ['東京','上野','大宮','小山','宇都宮','那須塩原','新白河','郡山','福島','白石蔵王','仙台','古川','くりこま高原','一ノ関','水沢江刺','北上','新花巻','盛岡','いわて沼宮内','二戸','八戸','七戸十和田','新青森'],
  },
  hokkaido: {
    name: '北海道新幹線', op: 'jrh', color: '#8bc53f', mins: 60,
    stations: ['新青森','奥津軽いまべつ','木古内','新函館北斗'],
  },
  akita: {
    name: '秋田新幹線', op: 'jre', color: '#e5006e', mins: 100,
    stations: ['盛岡','雫石','田沢湖','角館','大曲','秋田'],
  },
  yamagata: {
    name: '山形新幹線', op: 'jre', color: '#f5a200', mins: 100,
    stations: ['福島','米沢','高畠','赤湯','かみのやま温泉','山形','天童','さくらんぼ東根','村山','大石田','新庄'],
  },
  joetsu: {
    name: '上越新幹線', op: 'jre', color: '#e60012', mins: 105,
    stations: ['東京','上野','大宮','熊谷','本庄早稲田','高崎','上毛高原','越後湯沢','浦佐','長岡','燕三条','新潟'],
  },
  hokuriku: {
    name: '北陸新幹線', op: 'jre', color: '#0072bc', mins: 200,
    // 上越妙高で JR東日本／JR西日本の境界。運行情報は両社が全線分を掲出。
    stations: ['東京','上野','大宮','高崎','安中榛名','軽井沢','佐久平','上田','長野','飯山','上越妙高','糸魚川','黒部宇奈月温泉','富山','新高岡','金沢','小松','加賀温泉','芦原温泉','福井','越前たけふ','敦賀'],
    subOp: 'jrw', subFrom: '上越妙高', subOfficial: 'jrw_hokuriku',
  },
  tokaido: {
    name: '東海道新幹線', op: 'jrc', color: '#1268b3', mins: 150,
    stations: ['東京','品川','新横浜','小田原','熱海','三島','新富士','静岡','掛川','浜松','豊橋','三河安城','名古屋','岐阜羽島','米原','京都','新大阪'],
  },
  sanyo: {
    name: '山陽新幹線', op: 'jrw', color: '#004098', mins: 150,
    stations: ['新大阪','新神戸','西明石','姫路','相生','岡山','新倉敷','福山','新尾道','三原','東広島','広島','新岩国','徳山','新山口','厚狭','新下関','小倉','博多'],
  },
  kyushu: {
    name: '九州新幹線', op: 'jrk', color: '#e50012', mins: 90,
    stations: ['博多','新鳥栖','久留米','筑後船小屋','新大牟田','新玉名','熊本','新八代','新水俣','出水','川内','鹿児島中央'],
  },
  nishikyushu: {
    name: '西九州新幹線', op: 'jrk', color: '#d80c18', mins: 30,
    stations: ['武雄温泉','嬉野温泉','新大村','諫早','長崎'],
  },
};

/* 駅名が一致しない実際の乗継ぎ（BFS で仮想エッジとして使う）
 * relayMins : つなぎの在来線区間のおおよその所要分 */
const TRANSFERS = [
  { a: '武雄温泉', lineA: 'nishikyushu', b: '博多', lineB: 'sanyo',  relayMins: 80, note: '在来線特急「リレーかもめ」（武雄温泉〜博多、約1時間20分）' },
  { a: '武雄温泉', lineA: 'nishikyushu', b: '博多', lineB: 'kyushu',  relayMins: 80, note: '在来線特急「リレーかもめ」（武雄温泉〜博多、約1時間20分）' },
];

/* 路線どうしの接続の性質（乗換目安の表示用）
 *   through : 直通列車がある（つばさ／こまち／はやぶさ／みずほ・さくら 等）
 *   partial : 一部直通（東海道⇔山陽ののぞみ 等）
 *   未定義  : 通常は乗り換え
 * キーは路線ID2つを昇順で "|" 連結 */
const CONNECTION_KIND = {
  'akita|tohoku': 'through',
  'tohoku|yamagata': 'through',
  'hokkaido|tohoku': 'through',
  'kyushu|sanyo': 'through',
  'sanyo|tokaido': 'partial',
};

/* 乗換の目安（分） */
const TRANSFER_MIN = { through: 4, partial: 8, transfer: 12 };

/* 複数の共通駅がある場合の乗換駅の優先順 */
const TRANSFER_PRIORITY = ['大宮','高崎','福島','盛岡','新青森','新大阪','博多','東京','上野'];

/* 事業者ごとの公式運行情報 */
const OFFICIAL = {
  jre: {
    label: 'JR東日本 新幹線の運行情報',
    url: 'https://traininfo.jreast.co.jp/train_info/shinkansen.aspx',
    note: '30分以上の遅れ・運休を掲出',
  },
  jrc: {
    label: 'JR東海 東海道・山陽新幹線 運行状況',
    url: 'https://traininfo.jr-central.co.jp/shinkansen/sp/ja/index.html',
    note: 'おおむね10分以上の遅れ・運休を掲出',
  },
  jrw: {
    label: 'JR西日本 山陽新幹線 運行情報',
    url: 'https://trafficinfo.westjr.co.jp/sanyo.html',
    note: 'おおむね10分以上の遅れ・運休を掲出',
  },
  jrw_hokuriku: {
    label: 'JR西日本 北陸新幹線 運行情報',
    url: 'https://trafficinfo.westjr.co.jp/h_shinkansen.html',
    note: '金沢〜敦賀を中心にJR西日本エリアを掲出',
  },
  jrk: {
    label: 'JR九州 運行情報（九州新幹線）',
    url: 'https://www.jrkyushu.co.jp/trains/info/',
    note: '西九州新幹線は https://www.jrkyushu.co.jp/trains/info/nishi.html',
  },
  jrh: {
    label: 'JR北海道 列車運行情報',
    url: 'https://www3.jrhokkaido.co.jp/webunkou/',
    note: '北海道新幹線を含む',
  },
};

/* 横断的に確認できる民間サイト */
const AGGREGATORS = [
  { label: 'Yahoo!路線情報（新幹線）', url: 'https://transit.yahoo.co.jp/diainfo' },
  { label: '駅探 新幹線の遅延・運行状況', url: 'https://ekitan.com/transit/shinkansen/train-status' },
];

/* 全駅（重複除去・ソート）— 入力補助用 */
const ALL_STATIONS = (() => {
  const s = new Set();
  Object.values(LINES).forEach(l => l.stations.forEach(st => s.add(st)));
  return [...s].sort((a, b) => a.localeCompare(b, 'ja'));
})();

/* 駅名 → その駅が属する路線ID配列 */
const STATION_LINES = (() => {
  const m = {};
  Object.entries(LINES).forEach(([id, l]) => {
    l.stations.forEach(st => { (m[st] ||= []).push(id); });
  });
  return m;
})();
