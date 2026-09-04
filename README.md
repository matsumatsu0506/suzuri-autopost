# SUZURI 自動投稿

SUZURI で販売している自分のグッズを、毎日2回（日本時間 6:30 と 18:30）Bluesky に自動投稿します。
朝と夜で必ず違うデザインが選ばれます。

- 費用は無料です（GitHub Actions の無料枠と Gemini API の無料枠だけを使います）
- クレジットカードの登録は不要です
- 操作はすべてターミナルから行えます。管理画面はありません

## 仕組み

1. GitHub Actions が1日2回、決まった時刻にこのプログラムを動かします
2. SUZURI API から自分の商品を全件取得します
3. 「まだ紹介していない、または一番長く紹介していないデザイン」を1つ選びます
4. そのデザインの商品から1点（Tシャツなど）を選びます
5. Gemini が紹介文と画像の代替テキストを作ります
6. Bluesky に画像付きで投稿します
7. 「どのデザインをいつ投稿したか」を `state/posted.json` に記録し、リポジトリにコミットします

全デザインを一巡したら自動的に最初に戻り、ずっと回り続けます。

### デザイン単位で選ぶ理由

SUZURI は1つのデザインから、Tシャツ・マグカップ・ステッカーなど何十種類もの商品を自動で作ります。
商品を単純に1件ずつ選ぶと、同じ絵柄が何日も連続して投稿されてしまいます。
そのためこのプログラムは、必ず「デザイン（material）」の単位で選びます。

---

## 準備

### 1. 必要なキーを4つ用意する

| 名前 | 取得先 |
| --- | --- |
| `SUZURI_API_TOKEN` | https://suzuri.jp/developer/apps で「アプリケーションを作成」 |
| `BLUESKY_IDENTIFIER` | 自分の Bluesky のハンドル（例 `example.bsky.social`） |
| `BLUESKY_APP_PASSWORD` | Bluesky の 設定 → プライバシーとセキュリティ → アプリパスワード |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |

`BLUESKY_APP_PASSWORD` は**ログイン用のパスワードではありません**。
アプリパスワードは後からいつでも取り消せるので、必ずこちらを使ってください。

### 2. 自分のユーザー名を設定する

`config.json` の `suzuriUserName` に、自分の SUZURI のユーザー名を入れます。
自分のショップの URL が `https://suzuri.jp/abcdef` なら `abcdef` の部分です。

### 3. ローカルで動かす準備

`.env.example` を `.env` という名前でコピーして、4つのキーを書き込みます。
`.env` は `.gitignore` に入っているので GitHub には上がりません。

```bash
cp .env.example .env
```

依存パッケージを入れます。

```bash
npm install
```

---

## 動作確認

### まず、SUZURI から商品が取れるか確認する

```bash
npm run check
```

商品の件数と、使っているフィールドが実際に存在するかどうかが表示されます。
デザインごとのアイテム数もここで確認できます。

### 次に、投稿せずに中身だけ確認する

```bash
npm run post -- --dry-run
```

「どのデザインが選ばれたか」「生成された紹介文」「画像の代替テキスト」「投稿される本文の完成形」
「文字数」がすべてターミナルに表示されます。**この時点では投稿も記録もされません。**

特定のデザインで試したいときは、デザインID を指定できます。

```bash
npm run post -- --dry-run --material-id=12345
```

### 納得したら、実際に1回投稿してみる

```bash
npm run post -- --slot=manual
```

---

## GitHub に置いて自動化する

### 1. リポジトリを作る

```bash
git init
git add -A
git commit -m "初回コミット"
gh repo create suzuri-autopost --public --source=. --push
```

### 2. キーを GitHub Secrets に登録する

以下を1つずつ実行します。実行すると値の入力を求められるので、そこに貼り付けてください。
（コマンドの履歴に残らないので安全です）

```bash
gh secret set SUZURI_API_TOKEN
```

```bash
gh secret set BLUESKY_IDENTIFIER
```

```bash
gh secret set BLUESKY_APP_PASSWORD
```

```bash
gh secret set GEMINI_API_KEY
```

登録できたか確認します。

```bash
gh secret list
```

### 3. GitHub Actions で手動実行して確かめる

まず投稿しない設定で試します。

```bash
gh workflow run "SUZURI 自動投稿" -f slot=manual -f dry_run=true
```

しばらくしてから結果を見ます。

```bash
gh run list --workflow="SUZURI 自動投稿" --limit 3
```

```bash
gh run view --log
```

問題なければ `dry_run=false` で本番投稿を試します。

```bash
gh workflow run "SUZURI 自動投稿" -f slot=manual -f dry_run=false
```

これが成功すれば、あとは毎日 6:30 と 18:30 に自動で動きます。

---

## 設定の変え方

すべて `config.json` で変えられます。コードを触る必要はありません。

- `itemPriority` … どのアイテムを優先して投稿するか。上にあるものが優先されます
- `hashtags` … 付けるハッシュタグ
- `includeItemHashtag` … アイテム名（#スタンダードTシャツ など）のタグを自動で付けるか
- `copyTone` … 紹介文の語り口
- `maxBodyLength` … 紹介文の最大文字数（既定 180）
- `cooldownRuns` … 直近何回分のデザインを「連続で出さない」ようにするか（既定 3）
- `enabledPlatforms` … 投稿先。今は `["bluesky"]` のみ

### 投稿時刻を変える

`.github/workflows/post.yml` の `cron` を書き換えます。**cron は UTC で書きます。**

| 日本時間 | cron に書く値 |
| --- | --- |
| 6:30 | `30 21 * * *` |
| 7:00 | `0 22 * * *` |
| 8:00 | `0 23 * * *` |
| 12:00 | `0 3 * * *` |
| 18:30 | `30 9 * * *` |
| 21:00 | `0 12 * * *` |

計算方法は「日本時間から9時間を引く」です。引いてマイナスになったら24を足します（前日扱いになります）。

---

## 知っておいてほしいこと

### 投稿時刻は正確ではありません

GitHub Actions の定期実行は、混雑状況によって**数分から数十分遅れることがあります**。
「6:30ちょうど」ではなく「6:30すぎ」と考えてください。

### 60日間さわらないと自動実行が止まります

GitHub の仕様で、リポジトリに60日間まったく活動がないと定期実行が停止されます。
このプログラムは毎日 `state/posted.json` をコミットするので通常は止まりませんが、
もし止まった場合は GitHub からメールが届きます。
その時は GitHub のリポジトリの Actions タブを開き、ワークフローを再度有効にしてください。

### 失敗したときの気づき方

GitHub Actions が失敗すると、GitHub から自動でメールが届きます。
届かない場合は https://github.com/settings/notifications を開き、
「Actions」の項目でメール通知が有効になっているか確認してください。

失敗したときのログには `SUZURI_AUTOPOST_FAILED` という文字列が必ず入ります。

### Bluesky でリンクカードが出ないのは仕様です

画像を添付した投稿では、URL のリンクカード（大きなプレビュー）は表示されません。
これは AT Protocol の仕様です。URL 自体はリンクとして機能します。

### 紹介文が作れなかったとき

Gemini の無料枠は混雑時に一時的なエラー（HTTP 503）を返すことがあります。
その場合は4秒後、12秒後と自動で2回まで待って再試行します。
それでもだめなら「商品名・アイテム名・価格」だけの定型文に切り替えて投稿を続けます。処理は止まりません。

### 使う Gemini のモデル

既定は `gemini-3.6-flash` です（2026年9月時点で動作確認済み）。
モデルが廃止された場合は `.env` または GitHub Secrets の `GEMINI_MODEL` で差し替えられます。
なお `gemini-2.5-flash` は既に新規利用ができなくなっています。

---

## これから増やせるもの

- **Threads**（`src/platforms/threads.ts` にスタブがあります）
  - 画像は JPEG/PNG の**公開URL**が必要です。バイナリは送れません
  - アクセストークンが**60日で失効**するため、自動更新の仕組みが別途必要です
- **Instagram**
  - プロアカウント（ビジネスまたはクリエイター）への切り替えが必要です。無料です
  - 自分のアカウントにだけ投稿するなら、Meta の審査は不要です
- **Facebook**
  - **個人プロフィールへの自動投稿はできません**（API が廃止されています）
  - Facebook ページを作れば投稿できます

## ファイルの場所

- `src/index.ts` … 全体の流れ
- `src/suzuri.ts` … SUZURI API から商品を取得する
- `src/select.ts` … 投稿するデザインと商品を選ぶ
- `src/copy.ts` … Gemini で紹介文と代替テキストを作る
- `src/image.ts` … 画像を JPEG に変換する
- `src/compose.ts` … 本文を組み立てて文字数を調整する
- `src/state.ts` … 投稿の記録を読み書きする
- `src/platforms/bluesky.ts` … Bluesky への投稿
- `config.json` … 設定
- `state/posted.json` … 投稿の記録
