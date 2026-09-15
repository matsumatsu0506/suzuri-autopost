# SUZURI 自動投稿

SUZURI で販売している自分のグッズを、毎日2回（日本時間 6:30 と 18:30）Bluesky に自動投稿します。
朝と夜で必ず違うデザインが選ばれます。

- 費用は無料です（GitHub Actions の無料枠と Gemini API の無料枠だけを使います）
- クレジットカードの登録は不要です
- 自動投稿の操作はすべてターミナルから行えます
- 自分で書いた文章・画像・動画を投稿・予約するための投稿画面もあります（「手動投稿・予約投稿」を参照）

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

## Threads を使う（Phase 2）

`src/platforms/threads.ts` は実装済みです。以下の準備をすれば使えます。

### 画像について（解決済み）

Threads は画像ファイルを送れず、**公開された JPEG / PNG の URL** しか受け付けません。
SUZURI の画像URLは末尾の拡張子で形式が決まり、`....png.webp` を **`....png.jpg`** にすると
JPEG がそのまま返ってきます（8種類のアイテムで実測確認済み）。
そのため**画像を自前でホストする必要はありません**。`src/image.ts` の `toPublicJpegUrl` が変換します。

### 準備の手順

1. https://developers.facebook.com/ でMetaの開発者登録をする
2. アプリを作り、ユースケースとして「Threads API」を選ぶ
3. 権限 `threads_basic` と `threads_content_publish` を追加する
4. 自分の Threads アカウントをテスターとして追加し、Threads 側で承認する
5. 長期アクセストークン（60日有効）を発行する
6. `.env` の `THREADS_ACCESS_TOKEN` に入れて、ローカルで確認する

```bash
npm run post -- --dry-run
```

7. 問題なければ `config.json` の `enabledPlatforms` に `"threads"` を足す

```json
"enabledPlatforms": ["bluesky", "threads"]
```

8. GitHub にも登録する

```bash
gh secret set THREADS_ACCESS_TOKEN
```

### トークンの自動更新（重要）

Threads の長期トークンは**60日で失効**します。放置すると2か月で投稿が止まります。
`.github/workflows/refresh-threads-token.yml` が毎週月曜3:00にトークンを更新しますが、
**Secrets を書き換える権限が必要**なので、以下の準備が要ります。

1. https://github.com/settings/personal-access-tokens で Fine-grained personal access token を作る
   - Repository access: `suzuri-autopost` のみ
   - Permissions → Repository permissions → **Secrets: Read and write**
   - 有効期限は長め（1年など）にする
2. 作ったトークンを登録する

```bash
gh secret set GH_PAT
```

3. 手動で1回動かして確認する

```bash
gh workflow run refresh-threads-token.yml
```

これを設定しない場合は、50日おきに自分でトークンを再発行して
`gh secret set THREADS_ACCESS_TOKEN` を実行する必要があります。

### Threads の制限

- 本文は **500文字**まで（Blueskyの300文字に合わせているので余裕があります）
- 画像は JPEG/PNG、8MBまで、幅320〜1440px
- コンテナ作成から公開まで**35秒待ちます**（Metaの推奨に従っています）
- 1日250投稿まで

## これから増やせるもの

- **Instagram**
  - プロアカウント（ビジネスまたはクリエイター）への切り替えが必要です。無料です
  - 自分のアカウントにだけ投稿するなら、Meta の審査は不要です
- **Facebook**
  - **個人プロフィールへの自動投稿はできません**（API が廃止されています）
  - Facebook ページを作れば投稿できます

## 手動投稿・予約投稿

SUZURI の自動投稿とは別に、自分で書いた文章や画像・動画を
Bluesky / Threads / Instagram / Facebookページ にまとめて投稿・予約できます。

### 投稿画面を開く

`open-post-ui.bat` をダブルクリックするか、コマンドプロンプトで次を実行します。

```bash
cd /d C:\Users\matsu\suzuri-autopost
```

```bash
npm run ui
```

ブラウザで投稿画面（ http://127.0.0.1:5178/ ）が開きます。
終わるときはコマンドプロンプトの画面で Ctrl + C を押します。

画面の項目は上から順に次のとおりです。

- 投稿日時 … 「今すぐ投稿」のチェックを外すと、予約する日時（日本時間）を入力できます
- 投稿アカウント … 投稿するSNSを選びます。前回選んだものを覚えています
- ポスト本文 … 入力欄の下に、選んだSNSごとの文字数が出ます
- 画像または動画 … 1つだけ添付できます（任意）
- 代替テキスト … 画像では必須です
- 予約一覧 … 投稿待ち・失敗した予約が並びます。取り消し・再試行ができます

### 仕組み

1. 投稿画面で送信すると、予約の内容が `queue/posts/` に保存されます（GitHub API で直接コミット）
2. 画像・動画は **GitHub の Release に一時的に置きます**。
   Threads と Instagram は、ネット上に公開されたファイルのURLしか受け付けないためです
3. `.github/workflows/manual-post.yml` が15分ごとに動き、予定時刻を過ぎた予約を投稿します。
   「今すぐ投稿」と「再試行」のときは、その場でこのワークフローを呼び出します
4. すべてのSNSで成功したら、一時ファイルの Release を削除し、記録を `queue/done/` に移します

**PC の電源を切っていても、予約は GitHub で実行されます。** 投稿画面を開いておく必要もありません。

### 知っておくこと

- GitHub Actions の定期実行だけに任せると、**予約時刻から数時間遅れる**ことがあります
  （2026年9月の実測で、6:30 の自動投稿が 8:55 に、18:30 が翌 0:58 に動いた日がありました）。
  時間どおりに動かすには「予約を時間どおりに動かす」の設定をしてください
- リポジトリは公開なので、**予約中の本文と画像・動画は、場所を知っていれば投稿前でも見られます**
- 動画は 100MB まで。Bluesky は3分、Threads は5分、Instagram は3秒〜15分まで
- 形式が合わない動画（WebM、4K、H.264 以外など）は、送信時に ffmpeg で MP4（H.264 / AAC・横幅1920px以下）に自動変換します
- 動画は Instagram ではリールとして投稿されます。リールには代替テキストを付けられません
- Instagram は文字だけの投稿ができません
- X（旧Twitter）は API が有料のため対応していません
- 一部のSNSだけ失敗した場合、成功したSNSにはもう投稿されています。
  予約一覧の「失敗したSNSに再試行」で、失敗したSNSにだけ投稿し直せます
- 投稿の途中で処理が止まった場合（1時間以上「投稿処理中」のまま）は、
  二重投稿を避けるため自動では投稿し直さず「失敗」にします。SNS側を確認してから再試行してください
- 失敗したときは GitHub からメールが届きます。ログには `MANUAL_POST_FAILED` という文字列が入ります

### 予約を時間どおりに動かす（おすすめ・無料）

GitHub の定期実行は混雑すると数時間遅れたり、実行が飛ばされたりします。
無料のタイマーサービス **cron-job.org** から5分ごとにワークフローを呼び出すと、
予約時刻から5分以内に投稿されるようになります。PC の電源が切れていても動きます。

アカウント作成と鍵（トークン）の発行は、ご自身で行ってください。

#### 手順1: GitHub で専用の鍵を作る

1. https://github.com/settings/personal-access-tokens/new を開く
2. Token name に `cron-job-org-manual-post` と入れる
3. Expiration（有効期限）は「No expiration」（期限なし）を選ぶ
4. Repository access で「Only select repositories」を選び、`suzuri-autopost` だけを選ぶ
5. Permissions の Repository permissions で、**Actions を「Read and write」** にする。ほかは触らない
6. 「Generate token」を押し、表示された鍵をコピーする（**一度しか表示されません**）

この鍵でできるのは「このリポジトリのワークフローを起動・停止すること」だけです。
コードや GitHub Secrets を読んだり書き換えたりはできません。

#### 手順2: cron-job.org にジョブを登録する

1. https://cron-job.org/ で無料アカウントを作ってログインする
2. 「CREATE CRONJOB」を押す
3. 次のように入力する
   - Title: `SNS予約投稿`
   - URL: `https://api.github.com/repos/matsumatsu0506/suzuri-autopost/actions/workflows/manual-post.yml/dispatches`
   - Execution schedule: 「Every 5 minutes」
4. 「ADVANCED」のタブを開き、次のように入力する
   - Request method: `POST`
   - Headers に次の3つを追加する
     - `Authorization` … `Bearer 手順1でコピーした鍵`（Bearer のあとに半角スペース）
     - `Accept` … `application/vnd.github+json`
     - `Content-Type` … `application/json`
   - Request body: `{"ref":"main"}`
5. 保存して「TEST RUN」を押す。応答が 200 か 204 なら成功です

成功すると、GitHub の Actions の画面に「手動投稿・予約投稿」が `workflow_dispatch` として5分ごとに並びます。
予約が無いときは10秒ほどで終わります（公開リポジトリなので料金はかかりません）。

- 鍵を作り直したときは、cron-job.org の Authorization も書き換える
- cron-job.org は失敗が25回を超えるとジョブを自動で止めます。止まったら鍵の期限や権限を確認する

### 投稿画面を使う前の準備

- `gh` コマンドで GitHub にログインしていること（`gh auth status` で確認）
- ffmpeg がインストールされていること（動画を添付する場合）
- GitHub Secrets は自動投稿と同じもの（`BLUESKY_*` `THREADS_ACCESS_TOKEN` `META_PAGE_ACCESS_TOKEN`）を使うので、追加の登録は不要です

表示するアカウント名とポート番号は `config.json` の `manualPost` で変えられます。

### 投稿せずに、予定時刻を過ぎた予約を確認する

```bash
npm run queue:run -- --dry-run
```

## ファイルの場所

- `src/index.ts` … 全体の流れ
- `src/suzuri.ts` … SUZURI API から商品を取得する
- `src/select.ts` … 投稿するデザインと商品を選ぶ
- `src/copy.ts` … Gemini で紹介文と代替テキストを作る
- `src/image.ts` … 画像を JPEG に変換する
- `src/compose.ts` … 本文を組み立てて文字数を調整する
- `src/state.ts` … 投稿の記録を読み書きする
- `src/platforms/bluesky.ts` … Bluesky への投稿
- `src/manual/server.ts` … 投稿画面（`npm run ui`）
- `src/manual/page.html` … 投稿画面の見た目と操作
- `src/manual/run-queue.ts` … 予約の実行（GitHub Actions）
- `src/manual/publish.ts` … 手動投稿で各SNSに投稿する処理
- `src/manual/media-prepare.ts` … 画像・動画の変換
- `queue/posts/` … 投稿待ち・失敗した予約
- `queue/done/` … 投稿が終わった予約の記録
- `config.json` … 設定
- `state/posted.json` … 投稿の記録
