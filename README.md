# 楽譜スクロール

歌詞・コード・写真・PDFの楽譜を取り込み、一定速度で自動スクロールするアプリです。
ビルド不要の静的ファイルだけで動き、データは端末の中にだけ保存されます。

## 手元で動かす

`index.html` をダブルクリックしても動きません（ESモジュールとService Workerにはサーバーが必要です）。このフォルダで次のどちらかを実行し、`http://localhost:8000/` を開きます。

```
python -m http.server 8000
# または
npx serve .
```

`localhost` はHTTPSでなくてもService Workerが使えます。

## 公開する（GitHub Pages）

1. このフォルダの中身をGitHubのリポジトリに置く。
2. Settings → Pages で、公開するブランチとフォルダ（`/ (root)`）を選ぶ。
3. 表示されたURL（HTTPS）を利用者に共有する。

## スマートフォンに入れる

- Android（Chrome）：URLを開き、メニューから「ホーム画面に追加」または「アプリをインストール」。
- iPhone（Safari）：URLを開き、共有ボタンから「ホーム画面に追加」。**追加しておかないと、長く使わないデータをSafariが消すことがあります。**

一度開けば、以降は通信なしで起動します。

## 更新を配る

ファイルを差し替えたら、[sw.js](sw.js) の `VERSION` を上げてください（`v1` → `v2`）。更新はアプリを一度閉じて開き直したときに切り替わります。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` | 画面と見た目 |
| `js/app.js` | 画面と操作 |
| `js/db.js` | 保存（IndexedDB） |
| `js/importer.js` | 画像・PDFの取り込み |
| `sw.js` / `manifest.webmanifest` | オフライン動作・ホーム画面追加 |
| `lib/pdfjs/` | PDF.js（Apache-2.0、同梱のLICENSE参照） |

速さの調整：[js/app.js](js/app.js) の `speedToPx`（最小2、倍率50）を変えると、スライダーの速度範囲を変えられます。
