# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code (claude.ai/code) への指針を提供する。

## プロジェクト概要

出発駅から到着駅までを入力すると、経路上の新幹線各線を判定して運行状況を表示し、各社の公式運行情報ページへ誘導する PWA。新幹線の運行状況を返す無料の公式APIが存在しないため、GitHub Actions で定期的に Yahoo!路線情報をスクレイピングして `status.json` を生成し、それをアプリが読む方式になっている。

`build-app` という個人ワークスペース内の1プロジェクトとして管理されているが、それ自体は独立した git リポジトリ。ワークスペース横断の共通事項は親フォルダの `CLAUDE.md` を参照。

## アーキテクチャ

```
[GitHub Actions cron] → scraper/scrape.py → status.json をコミット
                                                   │ raw.githubusercontent.com（CORS対応）
                                                   ▼
                                     PWA (index.html) が読み込んで表示
```

- `scraper/scrape.py` は標準ライブラリのみ（`pip install` 不要）。`transit.yahoo.co.jp/diainfo/<code>/0` を新幹線10線分取得し、`mdServiceStatus` ブロックから状態・本文・更新時刻を抽出。1路線が失敗しても `level: "unknown"` で継続し、各リクエスト間に1秒スリープする。
- `.github/workflows/scrape.yml` が JST 6/9/12/15/18/21時の cron で `scraper/scrape.py` を実行し、変更があれば `status.json` をコミット・push する。
- `status.json` の路線キー（`tokaido` 等）は `js/data.js` の `LINES` と一致させること。出力形式を変える場合は `js/app.js` の読み込み処理とセットで直す。

## コマンド

- **ローカル起動**: `ローカルサーバー起動.cmd`（または `server.ps1`）→ http://localhost:8123/
- **スクレイパーの手動実行**: `python scraper/scrape.py`（カレントディレクトリに `status.json` を書き出す）
- **ビルド／lint／テスト**: 該当コマンド無し。

## ディレクトリ構造

```
index.html                   画面
css/styles.css                スタイル
js/data.js                    路線・駅・乗換・運賃表・公式リンクの定義（データ更新はここ）
js/app.js                     経路探索・乗換/運賃の概算・フィード取得・描画
manifest.webmanifest / sw.js  PWA
icons/ , img/hero.webp        アプリアイコン・ヒーローバナー（Nano Banana Pro 生成）
status.json                   スクレイパー生成の運行状況（Actions が更新するので手で編集しない）
scraper/scrape.py             スクレイパー本体
.github/workflows/scrape.yml  GitHub Actions（cron）
server.ps1 / *.cmd            ローカル配信用
```

## 経路・運賃の概算について

- 時刻表データは持っていない。`js/data.js` の `LINES[].mins`（駅数按分）と `TRANSFER_MIN` を積み上げて所要時間を概算表示している。精度を上げたい場合はこれらの値を実ダイヤに合わせて調整する。
- 運賃も `FARE_TABLE`（主要区間の実額）または `FARE_CURVE` × `LINE_FARE_FACTOR`（距離ベースの概算、`†` 表示）による目安であり、正確な運賃APIは無い。

## 注意事項

- スクレイピングは1日6回・各10リクエストに制限されている。Yahoo!の利用規約・robotsを尊重し、頻度を安易に上げないこと。一次情報は各鉄道会社の公式サイト。
