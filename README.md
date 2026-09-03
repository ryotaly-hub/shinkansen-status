# 新幹線 運行状況チェッカー

出発駅から到着駅までを入力すると、**経路上の新幹線各線を判定し、運行状況を表示＋各社の公式運行情報ページへ誘導**する PWA です。

新幹線の運行状況を返す無料の公式APIは存在しない（ODPT の JR東日本データは新幹線を含まない、他社は不参加）ため、
**Yahoo!路線情報を1日数回スクレイピングして `status.json` を作り、それをアプリが読む**方式にしています。

```
[GitHub Actions cron] → scraper/scrape.py → status.json をコミット
                                                   │ raw.githubusercontent.com（CORS対応）
                                                   ▼
                                     PWA (index.html) が読み込んで表示
```

---

## セットアップ（GitHub Actions）

### 1. リポジトリを作成してプッシュ

このフォルダごと GitHub の**新規リポジトリ**（例 `shinkansen-status`）にプッシュします。

```bash
cd "新幹線の運行状況"
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<あなた>/<リポジトリ>.git
git push -u origin main
```

### 2. Actions の書き込み権限を確認

リポジトリの **Settings → Actions → General → Workflow permissions** を
**「Read and write permissions」** にする（ワークフロー側にも `permissions: contents: write` を書いてありますが念のため）。

### 3. 動作確認

**Actions タブ → 「scrape-shinkansen-status」→ Run workflow** で手動実行。
成功すると `status.json` が更新コミットされます。以降は cron（JST 6/9/12/15/18/21時）で自動更新。

### 4. アプリにフィードURLを登録

`status.json` の raw URL は:

```
https://raw.githubusercontent.com/<あなた>/<リポジトリ>/main/status.json
```

アプリを開き（`ローカルサーバー起動.cmd` → http://localhost:8123/ 、または `index.html` を直接）、
右上 ⚙ → **「運行情報フィードを使う」にチェック → 上記URLを貼り付け → 保存**。

> GitHub Pages を有効にすればアプリ自体もホストできます。その場合フィードURLは同一オリジンの `./status.json` でも可（Service Worker はキャッシュしません）。

---

## スクレイパー

`scraper/scrape.py` — 標準ライブラリのみ（`pip install` 不要）。ローカル実行:

```bash
python scraper/scrape.py      # カレントに status.json を書き出す
```

Yahoo!路線情報の `transit.yahoo.co.jp/diainfo/<code>/0` を10線分取得し、
`mdServiceStatus` ブロックから状態・本文・更新時刻を抽出して正規化します。
1路線が失敗しても `level: "unknown"` で継続。相手サーバー配慮で各リクエスト間に1秒スリープ。

### status.json の形式

```json
{
  "generatedAt": "2026-09-02T09:15:21+09:00",
  "source": "Yahoo!路線情報 (transit.yahoo.co.jp/diainfo)",
  "lines": {
    "tokaido": {
      "name": "東海道新幹線",
      "url": "https://transit.yahoo.co.jp/diainfo/7/0",
      "level": "normal",          // normal | trouble | suspend | unknown
      "label": "平常運転",
      "text": "現在､事故･遅延に関する情報はありません。",
      "updated": "9月2日 9時14分更新"
    }
  }
}
```

路線ID（`tokaido` 等）は `js/data.js` の `LINES` と一致させています。

### スクレイピングの頻度・マナー

- 1日6回・各10リクエストのみ。過度なアクセスはしないこと。
- Yahoo! の利用規約・robots を尊重。問題があれば頻度を下げる／公式サイト直リンクのみに切り替える。
- **一次情報は各鉄道会社の公式サイト。** `status.json` はあくまで目安で、遅延・欠落があり得ます。

---

## 公式運行情報ソース（アプリ内リンク）

| 新幹線 | 事業者 | URL |
|---|---|---|
| 東北・上越・山形・秋田 | JR東日本 | https://traininfo.jreast.co.jp/train_info/shinkansen.aspx |
| 東海道 | JR東海 | https://traininfo.jr-central.co.jp/shinkansen/sp/ja/index.html |
| 山陽 | JR西日本 | https://trafficinfo.westjr.co.jp/sanyo.html |
| 北陸 | JR東日本 / JR西日本 | 上記JR東日本 ／ https://trafficinfo.westjr.co.jp/h_shinkansen.html |
| 九州 | JR九州 | https://www.jrkyushu.co.jp/trains/info/ |
| 西九州 | JR九州 | https://www.jrkyushu.co.jp/trains/info/nishi.html |
| 北海道 | JR北海道 | https://www3.jrhokkaido.co.jp/webunkou/ |
| 東海道・山陽・九州（まとめ） | JR東海運営 | https://expy.jp/enjoytrip/traininfo/ |

---

## ファイル構成

```
index.html                   画面
css/styles.css                スタイル
js/data.js                    路線・駅・乗換・運賃表・公式リンクの定義（データ更新はここ）
js/app.js                     経路探索・乗換/運賃の概算・フィード取得・描画
manifest.webmanifest / sw.js  PWA
icons/icon.svg                アイコン
status.json                   スクレイパー生成の運行状況（Actionsが更新）
scraper/scrape.py             スクレイパー本体
.github/workflows/scrape.yml  GitHub Actions（cron）
server.ps1 / *.cmd            ローカル配信用（http://localhost:8123）
```

## 経路探索について

- `js/data.js` の `LINES` に新幹線10線の駅を起点→終点順で定義。
- 2駅が同一路線 → 直通。異なれば路線グラフのBFSで乗換経路を求め、代表的な乗換駅（大宮・福島・盛岡・新大阪・博多 等を優先）を表示。
- 西九州新幹線は武雄温泉〜博多の在来線特急「リレーかもめ」乗継ぎとして扱う。

## 乗換の目安（概算）について

**時刻表データは持っていません。** 出発／到着の日時を指定すると、各路線を最速達列車で乗り通した場合の
おおよその所要分（`js/data.js` の `LINES[].mins` を駅数で按分）＋乗換の目安分（`TRANSFER_MIN`）を
積み上げて、発着時刻と総所要をざっくり表示します。

- `basis = 到着` の場合は総所要分を逆算して出発時刻を求めます。
- 直通運転がある接続（`CONNECTION_KIND`：つばさ／こまち／はやぶさ／みずほ・さくら 等）は
  「乗換なしの場合あり」と注記し、乗換分を短く見積もります。
- 結果内の「Yahoo!路線情報で正確な時刻を検索」ボタンは、指定した from / to / 日時 / 出発・到着区分を
  Yahoo!乗換案内の検索URLに引き継ぎます（`yahooUrl()`）。**正確な時刻はこちらで。**

精度を上げたい場合は `LINES[].mins` と `TRANSFER_MIN` を実際のダイヤに合わせて調整してください。

## 運賃・料金のめやすについて

**正確な運賃APIはありません。** 経路の下に、区間ごと × 座席種別（自由席／指定席／グリーン車）の
概算と合計を表示します。大人1名・片道・通常期。割引きっぷ・往復割引・早特は含みません。

- `js/data.js` の `FARE_TABLE`：主要区間の「総額（運賃＋特急料金）」実額の目安。
  出典は新幹線旅行研究所（shinkansen.tabiris.com）ほか、2023〜2025年時点。**運賃改定で変わります。**
  `s`=指定席（通常期）, `j`=自由席（`null` は全車指定席の区間）。
- 表に無い区間は `FARE_CURVE`（距離→指定席総額の近似）× `LINE_FARE_FACTOR`（路線係数）で概算し、`†` を付けます。
- 直通列車がある区間（`CONNECTION_KIND`）は、区間の足し算ではなく通しの距離で概算します
  （特急料金の二重計上を避けるため）。
- 在来線特急リレー（西九州新幹線がらみ）を含む経路は誤差が大きめ。必ず Yahoo!路線情報で確認してください。
- グリーン料金は `greenFee()` の距離帯テーブルの目安。

値を最新化するときは `FARE_TABLE` の数字を各社の最新運賃で置き換えるのが手軽です。
