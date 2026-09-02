#!/usr/bin/env python3
"""
新幹線 運行状況スクレイパー
------------------------------------------------------------
Yahoo!路線情報の運行情報ページ（transit.yahoo.co.jp/diainfo/<code>/0）から
新幹線10線の運行状況を取得し、status.json に正規化して書き出す。

- 標準ライブラリのみ（urllib）。pip インストール不要。
- 1路線が取得失敗しても level="unknown" として続行する。
- GitHub Actions からcronで定期実行し、差分があれば status.json をコミットする。

一次情報はあくまで各鉄道会社の公式サイト。本JSONは目安。
"""

import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# 路線ID（アプリの js/data.js の LINES と一致させる）→ Yahoo diainfo コード
LINES = {
    "tohoku":      {"name": "東北新幹線",   "yahoo": "1"},
    "hokkaido":    {"name": "北海道新幹線", "yahoo": "637"},
    "akita":       {"name": "秋田新幹線",   "yahoo": "6"},
    "yamagata":    {"name": "山形新幹線",   "yahoo": "5"},
    "joetsu":      {"name": "上越新幹線",   "yahoo": "3"},
    "hokuriku":    {"name": "北陸新幹線",   "yahoo": "624"},
    "tokaido":     {"name": "東海道新幹線", "yahoo": "7"},
    "sanyo":       {"name": "山陽新幹線",   "yahoo": "8"},
    "kyushu":      {"name": "九州新幹線",   "yahoo": "410"},
    "nishikyushu": {"name": "西九州新幹線", "yahoo": "640"},
}

UA = "Mozilla/5.0 (compatible; shinkansen-unko-checker/1.0; personal use)"
TAG_RE = re.compile(r"<[^>]+>")


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as res:
        return res.read().decode("utf-8", "replace")


def strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", TAG_RE.sub("", s)).strip()


def classify(dd_class: str, icon: str, dt_label: str, text: str) -> str:
    c = (dd_class or "").lower() + " " + (icon or "").lower()
    s = (dt_label or "") + " " + (text or "")
    if "suspend" in c or re.search(r"見合わせ|運休|運転取りやめ|終日運転を取りやめ", s):
        return "suspend"
    if "normal" in c or (not dd_class and "平常" in s):
        return "normal"
    if "trouble" in c or "alert" in c or re.search(r"遅延|遅れ|運転変更|臨時ダイヤ|一部列車|直通運転中止|区間運休", s):
        return "trouble"
    return "unknown"


def nice_label(dt_label: str, text: str, level: str) -> str:
    """Yahoo の見出し（"その他" など）が曖昧なとき、本文から分かりやすい語を作る。"""
    if level == "normal":
        return "平常運転"
    if level == "unknown":
        return "情報取得できず"
    if re.search(r"見合わせ", text):
        return "運転見合わせ"
    if re.search(r"運休|運転取りやめ", text):
        return "運休"
    if re.search(r"遅れ|遅延", text):
        return "遅延"
    if re.search(r"運転変更|臨時ダイヤ|一部列車", text):
        return "運転変更・一部運休"
    if dt_label and dt_label not in ("その他", "運行状況"):
        return dt_label
    return {"normal": "平常運転", "trouble": "運行情報あり",
            "suspend": "運転見合わせ", "unknown": "情報取得できず"}[level]


def parse_yahoo(html: str) -> dict:
    block = re.search(r'<div id="mdServiceStatus">(.*?)</div>', html, re.S)
    updated = re.search(r'<span class="subText">(.*?)</span>', html, re.S)
    updated_txt = strip_tags(updated.group(1)).replace("<!-- -->", "") if updated else ""

    if not block:
        return {"level": "unknown", "label": "情報取得できず", "text": "", "updated": updated_txt}

    b = block.group(1)
    dt = re.search(r"<dt>(.*?)</dt>", b, re.S)
    dd = re.search(r'<dd class="([^"]*)">(.*?)</dd>', b, re.S)
    icon = re.search(r'<dt>\s*<span class="([^"]*)"', b)
    dt_label = strip_tags(dt.group(1)) if dt else ""
    dd_class = dd.group(1) if dd else ""
    icon_cls = icon.group(1) if icon else ""
    text = strip_tags(dd.group(2)) if dd else strip_tags(b)

    level = classify(dd_class, icon_cls, dt_label, text)
    return {
        "level": level,
        "label": nice_label(dt_label, text, level),
        "text": text,
        "updated": updated_txt,
    }


def main() -> int:
    out = {
        "generatedAt": datetime.now(JST).isoformat(timespec="seconds"),
        "source": "Yahoo!路線情報 (transit.yahoo.co.jp/diainfo)",
        "note": "一次情報は各鉄道会社の公式サイト。本データは目安です。",
        "lines": {},
    }
    errors = 0
    for lid, meta in LINES.items():
        url = f"https://transit.yahoo.co.jp/diainfo/{meta['yahoo']}/0"
        entry = {"name": meta["name"], "url": url,
                 "level": "unknown", "label": "", "text": "", "updated": ""}
        try:
            entry.update(parse_yahoo(fetch(url)))
            entry["name"] = meta["name"]
            entry["url"] = url
        except Exception as e:  # noqa: BLE001
            errors += 1
            entry["text"] = f"取得エラー: {e}"
            print(f"[warn] {lid} {meta['name']}: {e}", file=sys.stderr)
        out["lines"][lid] = entry
        print(f"{lid:12} {entry['level']:8} {entry['label']}  {entry['text'][:40]}")
        time.sleep(1)  # 相手サーバーへの配慮

    with open("status.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"\nwrote status.json ({errors} error(s))")
    return 0  # 一部失敗でも成功扱い（unknown として掲出）


if __name__ == "__main__":
    raise SystemExit(main())
