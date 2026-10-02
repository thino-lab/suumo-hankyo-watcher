# SUUMO反響 見張り番（Cloudflare Worker）

`system.ss@pure-growth.net` のGmailを5分おきに見て、SUUMOの反響通知が届いていたら
ブランドごとのGitHubリポジトリを起動する。

```
SUUMO → system.ss に反響通知
          ↓ 5分おきに Worker が探す
        貴社コードで振り分けて GitHub を起動 →「SUUMO起動中」ラベル
          ↓ GitHub がダウンロードして顧客ごとにメール
        次の巡回で成功を確認 → ★ と「SUUMO取込済」ラベル
```

**★は「顧客情報のダウンロードまで済んだ」印。** 起動しただけでは付けない。
GitHubが失敗したら★を付けずに「SUUMO起動中」を外し、次の巡回で起動し直す。

| ブランド | 貴社コード | リポジトリ |
|---|---|---|
| オンリーホーム | `501482` | `thino-lab/yamaka_only-home` |
| ナチュリエ | `130967` | `thino-lab/yamaka_naturie` |

ブランドを増やすときは `src/worker.js` の `COMPANIES` に1行足して、登録し直す。

---

## 初回の設定

### 1. Google Cloud（`system.ss@pure-growth.net` で行う）

1. https://console.cloud.google.com で新しいプロジェクトを作る（例：`suumo-hankyo`）
2. 「APIとサービス」→「ライブラリ」→ **Gmail API** を有効にする
3. 「APIとサービス」→「OAuth同意画面」→ ユーザーの種類 **内部（Internal）**
   - **「外部」のテスト中にしない。** 7日で鍵が切れて止まる
4. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」
   - 種類：**ウェブアプリケーション**
   - 承認済みのリダイレクトURI：`https://developers.google.com/oauthplayground`
5. 表示された **クライアントID** と **クライアントシークレット** を控える

### 2. 鍵（リフレッシュトークン）を発行する

1. https://developers.google.com/oauthplayground を開く
2. 右上の歯車 → **Use your own OAuth credentials** にチェック → 1で控えたIDとシークレットを入れる
3. 左の入力欄に `https://www.googleapis.com/auth/gmail.modify` と入れて **Authorize APIs**
4. `system.ss@pure-growth.net` を選んで「許可」
5. **Exchange authorization code for tokens** を押す
6. 表示された **Refresh token** を控える

`gmail.modify` は「読む＋ラベルと★の付け外し」の許可。メールの送信や完全削除はできない。

### 3. GitHubのトークン

GASで使っていたものをそのまま使える。次の設定になっていること。

- Repository access：`yamaka_only-home` と `yamaka_naturie`
- Permissions：**Contents: Read and write**、**Actions: Read-only**

### 4. Cloudflareに登録する

1. Cloudflare の管理画面 → **Workers & Pages** → **Create** → **Create Worker**
2. 名前を `suumo-hankyo-watcher` にして **Deploy**
3. **Edit code** を押し、中身を全部消して `src/worker.js` を貼り付け → **Deploy**
4. **Settings** → **Variables and Secrets** → **Add** で、種類 **Secret** を5つ登録

   | 名前 | 値 |
   |---|---|
   | `GOOGLE_CLIENT_ID` | 1で控えたクライアントID |
   | `GOOGLE_CLIENT_SECRET` | 1で控えたクライアントシークレット |
   | `GOOGLE_REFRESH_TOKEN` | 2で控えたRefresh token |
   | `GITHUB_TOKEN` | 3のトークン |
   | `TEST_KEY` | 好きな長い文字列（動作確認URLの合言葉） |

5. **Settings** → **Trigger Events**（Cron Triggers）→ **Add** → `*/5 * * * *`（5分おき）

### 5. 動作確認

ブラウザで開く（`<名前>` はWorkerのURL。管理画面の上に出ている）。

**① 確認のみ（何も起動しない・安全）**
```
https://suumo-hankyo-watcher.<名前>.workers.dev/check?key=<TEST_KEY>
```
見つかった反響通知が一覧で出る。`code` が `501482` か `130967`、`link` が `true`、
`repo` にリポジトリ名が出ていればよい。

**② 本番どおり1回動かす**
```
https://suumo-hankyo-watcher.<名前>.workers.dev/check?key=<TEST_KEY>&run=1
```
GitHubが起動し、メールに「SUUMO起動中」が付く。5〜10分後に★と「SUUMO取込済」に変われば完成。

### 6. GASの巡回を止める

Worker が動いたら、`system.ss` のGASのトリガー画面（時計のアイコン）で
`checkHankyo` と `confirmRuns` を削除する。**両方動かしたままにしない**
（同じ反響で二重に起動する。台帳が二重送信を防ぐので顧客に2通届くことはないが、無駄になる）。

---

## 止まったとき

| 症状 | 原因 | 直し方 |
|---|---|---|
| ログに `Googleの鍵が使えません … invalid_grant` | `system.ss` のパスワード変更、許可の取り消し、「テスト中」の7日切れ | 2の手順で鍵を発行し直し、`GOOGLE_REFRESH_TOKEN` を更新 |
| `GitHub API エラー 401` | GitHubトークンの期限切れ | トークンを作り直し、`GITHUB_TOKEN` を更新 |
| `GitHub API エラー 404` | トークンにリポジトリが入っていない | トークンの Repository access に追加 |
| 「SUUMO起動中」のまま★にならない | トークンに Actions: Read-only が無い | トークンの権限に追加 |
| `COMPANIES に未登録です` | 新しいブランドの貴社コード | `COMPANIES` に1行足して登録し直す |

ログは Cloudflare の管理画面 → Worker → **Logs** で見られる。



## 手元でのテスト

```
node test/worker.test.mjs
```

疑似の Gmail / GitHub で「起動 → 実行中は待つ → 成功で★ → 失敗なら起動し直す」を確かめる。
`test/sample-notice.eml` は本物と同じ文字コード（ISO-2022-JP）で作った見本の反響通知。


## デプロイ（自動）

Cloudflare の Workers Builds で GitHub と連携済み。`main` に push すると、`wrangler.toml` の設定で自動デプロイされる（1〜2分）。

- コードは GitHub で直す。Cloudflare の画面（Edit code）で直しても、次の push で上書きされる。
- Secrets（Google / GitHub の鍵、TEST_KEY）は Cloudflare 側に残るので、デプロイで消えない。
- 反映されたかは Cloudflare の Worker → Deployments で、どのコミットが Active か確認できる。
