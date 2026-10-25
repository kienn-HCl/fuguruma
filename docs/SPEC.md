# Fuguruma（文車）仕様書 v0.2

セルフホスト型の電子書籍リーダー Web アプリ。サーバーから参照できる任意のディレクトリ（ローカルディスク、外付けドライブ、NFS/SMB マウントなど）にある電子書籍を、スマホ・タブレット・PC のブラウザから同じ UI で読み、ハイライト・読書メモ・AI との対話を全デバイスで同期する。

---

## 1. 目的と方針

| 項目 | 方針 |
|---|---|
| 対応端末 | モダンブラウザ（iOS Safari / Android Chrome / デスクトップ）。レスポンシブ 1 本で対応し、ネイティブアプリは作らない |
| デプロイ | **Go のシングルバイナリ**にフロントエンドを `embed` で同梱。systemd で常駐させるのが基本形。Docker は任意 |
| 本の置き場所 | 任意のディレクトリ（`server.books_dir`）。読み取り専用で構わない。特定のストレージ製品には依存しない |
| 設定とデータの分離 | **設定**は TOML の設定ファイル、**データ**（メタデータ・タグ・進捗・ハイライト・ノート・会話）は SQLite（`data_dir/fuguruma.db`） |
| 利用者 | 個人利用（シングルユーザー）。v0.1 ではマルチユーザーは対象外 |
| 本ファイルへの書き込み | 既存の本ファイルは**変更・上書き・削除しない**。注釈は全て DB 側に保持する。唯一の例外は Web からのアップロードで、`upload_dir` に**新しいファイルを作る**ことだけを行う（§3.1.1） |

### 対象外（v0.1）
- マルチユーザー / 共有
- DRM 付き書籍
- オフライン読書（PWA キャッシュ）… 将来課題
- CBZ / MOBI / AZW3 … 将来課題（AZW3 は変換推奨）

---

## 2. 技術構成

```
┌────────────── Browser (TS / React) ───────────────┐
│ 本棚  ─  リーダー(epub.js / pdf.js) ─ メモ ─ AIパネル │
└───────────────▲───────────────────────────────────┘
                │ JSON REST + SSE (AI ストリーミング)
┌───────────────┴────────── Go (net/http) ──────────┐
│ auth │ library scanner │ REST API │ AI proxy       │
│        SQLite (modernc, CGO不要)                   │
└──────┬──────────────────────────┬─────────────────┘
       │ read-only                 │ HTTPS
   books_dir (any dir)     AI provider (Claude API / OpenAI互換)
   config.toml (settings)  data_dir/fuguruma.db (data)
```

| レイヤ | 採用 | 理由 |
|---|---|---|
| バックエンド | Go 1.26 / 標準 `net/http`（1.22+ のパターンルーティング） | 依存最小。クロスコンパイル容易 |
| DB | SQLite（`modernc.org/sqlite`, pure Go） | CGO 不要でクロスコンパイル・Docker が簡単 |
| AI | Claude API: 公式 Go SDK / OpenAI 互換: HTTP（SSE） | プロバイダを差し替え可能な `Provider` インターフェース |
| 設定 | TOML（`github.com/BurntSushi/toml`） | 人が編集しやすく、Web からの書き戻しも可能 |
| フロント | TypeScript + React 18 + Vite | |
| EPUB 描画 | epub.js | CFI による位置指定・ハイライトが可能 |
| PDF 描画 | pdf.js（pdfjs-dist） | テキストレイヤで文字選択可能。Range リクエストで部分読み込み |
| Markdown | marked + DOMPurify | メモのプレビュー |

---

## 3. 機能要件

### 3.1 ライブラリ（本棚）
- `books_dir` 配下を再帰スキャンし、`.epub` / `.pdf` を登録する。
  - 起動時 + `library.scan_interval`（既定 30 分）ごと + UI の「再スキャン」ボタン。
  - 隠しディレクトリと、ストレージ製品が作るメタデータディレクトリ（`@eaDir`, `#recycle` など `@`/`#` 始まり）は除外。
- **書籍の同一性**：ファイル先頭 1MB とサイズから作る `fingerprint` を保持。ディレクトリ内でファイルを移動・リネームしても、同じ fingerprint の新パスに自動で付け替え、メモや進捗を失わない。
- ファイルが消えた本は `missing` 扱いにし、データ（ハイライト・ノート・会話・進捗・タグ）は残す。同じ内容のファイルが再び現れれば付け直す（場所・名前は問わない）。
  - 本棚では missing の本を既定で表示せず、「見つからない本」チップで一覧する。
  - missing の本に限り、「本棚から削除」で DB の記録を消せる。ハイライト・AI 会話・進捗・タグ付けは削除し、ノートは本に紐づかないノートとして残す。キャッシュした表紙も消す。**本のファイルは削除しない**（ファイルが存在する本は削除できない）。
- スキャンの安全装置：本のディレクトリが存在しない・読めない場合、または本が 1 冊も見つからないのに登録済みの本がある場合（マウントが外れて空のマウントポイントだけ見えている状態）は、スキャンを中止して本の状態を変えない。読めなかったサブディレクトリ配下の本も missing にしない。
- メタデータ
  - EPUB：OPF からタイトル・著者・説明・表紙画像を抽出。
  - PDF：ファイル名をタイトルに。表紙は**クライアントで 1 ページ目を描画して** サーバーにアップロード（Go 側に PDF レンダラを持たないため）。
  - タイトル・著者は UI から上書き編集可能。
- 表示：表紙グリッド（本棚）。並び替え（最近読んだ順 / 追加順 / タイトル順）、全文検索（タイトル・著者）、タグ絞り込み。読書進捗バーを表紙に表示。

### 3.1.1 本のアップロード
- 本棚の「＋ 本を追加」ボタン、または本棚へのファイルのドロップから EPUB / PDF をアップロードできる（複数可、1 ファイルずつ順に送信し進捗を表示）。
- 保存先は `books_dir/upload_dir`（既定 `Uploads`）。フォルダが無ければ作成する。
- **既存ファイルは決して上書きしない**。同名のファイルがあれば `名前 (2).pdf` のように別名にする（ハードリンクで配置し、対応しないファイルシステムでは存在確認のうえリネーム）。
- アップロード中のデータは同じフォルダの隠しファイル（`.fuguruma-upload-*.part`）に書き、完了後に配置する。スキャナは隠しファイルを無視するので、途中のファイルが登録されることはない。失敗時は一時ファイルを削除する。
- 検証：拡張子が `.epub` / `.pdf` であること、中身が一致すること（PDF ヘッダー、EPUB は container.xml と OPF を読めること）、サイズが `upload_max_mb` 以下であること。
- 重複：内容の指紋（§3.1）が一致する本があれば 409 で断り、既存の本へのリンクを返す。一致した本が「ファイルが見つからない」状態なら、新規登録せずその本に付け直す（メモ・ハイライト・進捗が戻る）。
- ファイル名はパス区切り・制御文字・Windows で使えない文字を `_` に置き換え、先頭のドットを除き、長さを制限する。
- 任意で、アップロードした本に付けるタグを選べる。
- 設定（Web から変更可）：`library.upload_enabled`、`library.upload_dir`（`books_dir` の外を指す値は拒否）、`library.upload_max_mb`。

### 3.2 タグ
- 本に複数タグを付与（多対多）。タグには色を設定可能。
- 本棚のサイドバー/上部チップでタグごとにグルーピング表示・絞り込み。
- タグの作成・名称変更・削除。

### 3.3 リーダー
- EPUB：ページ送り（paginated）。左右タップ / スワイプ / キーボード矢印でページ移動。目次ジャンプ。
- PDF：ページ単位表示、幅フィット、ズーム、ページ番号ジャンプ。
- 表示設定（端末ごと・localStorage）：文字サイズ、テーマ（ライト / セピア / ダーク）。
- **読書位置の同期**：位置（EPUB は CFI、PDF はページ番号）と進捗率をサーバーに保存。別端末で開くと続きから。後勝ち（`updated_at` 比較）。

### 3.4 ハイライトと読書メモ
- テキスト選択 → ポップアップから「ハイライト（色選択）」「メモ」「AIに聞く」「コピー」。
- ハイライト：位置（EPUB: CFI range / PDF: ページ + 正規化矩形）・選択テキスト・色・短いコメントを保存。リーダー上に再描画。
- 読書メモ（ノート）：Markdown の自由記述ドキュメント。本に紐づくもの・紐づかないもの両方可。編集 / プレビュー切替。
- サイドパネルで「ハイライト一覧」「この本のノート」を閲覧し、クリックで該当箇所へジャンプ。
- 全体の「ノート」画面：全ノートの一覧・検索・編集。

### 3.5 AI 連携
- 選択した文を起点に AI と会話する（プロバイダは §3.7 から選択）。
  - コンテキスト：書名・著者・選択文・選択文の前後テキスト（最大 ~3000 字）をシステムプロンプトに含める。
  - 応答はストリーミング（SSE）で逐次表示。
- 会話は本ごとに保存。後から一覧・再開できる。会話の元になった選択箇所へジャンプ可能。
- **整形して残す**：
  - 会話全体、または個別メッセージを「ノートへ書き出し」。Markdown として新規ノート作成 / 既存ノートへ追記。
  - 書き出したノートは通常のノートとして自由に編集できる（＝自分で整形）。
  - 「AI に要約させてノート化」ボタン：会話を AI に Markdown で要約させ、その結果をノートとして保存（その後手で整形）。
- AI プロバイダ（§3.7）が未設定・設定不備なら AI 機能は UI 上で無効化し、設定画面へ誘導する。

### 3.6 認証
- 設定ファイルの `auth.password_hash`（bcrypt）が設定されていればログインを要求。署名付き Cookie セッション（30 日）。
  - 設定方法：`fuguruma -config FILE passwd`、または Web の設定画面（現在のパスワードの確認が必要）。
  - 署名にはパスワードを含めるため、**パスワードを変更すると他の端末のセッションは無効**になる。
  - 環境変数 `FUGURUMA_PASSWORD`（平文）が設定されている場合はそちらを優先し、Web からは変更不可。
- 未設定時は認証なし（VPN 内やリバースプロキシ認証の背後で使う想定）。設定画面に警告を表示する。
- 外部公開する場合は HTTPS 終端（Caddy 等）を前段に置くこと。

### 3.7 AI プロバイダ
| provider | 実装 | 備考 |
|---|---|---|
| `anthropic` | Claude API（公式 Go SDK、ストリーミング、システムプロンプトのキャッシュ） | `fallbacks: "default"` で拒否時に推奨モデルへ自動再試行 |
| `openai` | OpenAI 互換 Chat Completions（`base_url` + `/chat/completions`、SSE） | OpenAI / Gemini / OpenRouter / Ollama / LM Studio / vLLM 等 |
| `none` | AI 無効 | |

- 全プロバイダ共通で、システムプロンプト（書名・著者・周辺本文・選択文）と会話履歴を渡し、テキストをストリーミングで返す。
- 設定画面から「接続テスト」（未保存の設定で短いリクエストを送る）が可能。

### 3.8 設定画面
- Web から変更できる項目（即時反映、設定ファイルへ書き戻し）
  - AI：プロバイダ、各プロバイダのモデル・API キー・Base URL・effort
  - ライブラリ：自動スキャン間隔、アップロードの有効/無効・保存先フォルダ・サイズ上限
  - ログインパスワードの設定・変更・無効化
- 表示のみ（設定ファイルで変更し再起動）：待受アドレス、本のディレクトリ、データディレクトリ、設定ファイルのパス
- API キーはブラウザへ返さない（設定済みかどうかと末尾 4 文字のみ表示）。空欄で保存すると既存のキーを維持し、「削除」で明示的に消去。
- 環境変数で上書きされている項目は、その旨を表示し編集不可にする。

---

## 4. 非機能要件
- 本ファイルの配信は `http.ServeContent` で Range リクエスト対応（PDF の部分読み込み、大きな EPUB）。
- パストラバーサル防止：配信は DB に登録された ID 経由のみ。パスは常に `books_dir` 配下であることを検証。
- 本ディレクトリは読み取り専用でも動作すること（アップロードだけが使えなくなる）。
- 設定ファイルは API キーを含むため `0600` で、一時ファイル経由のアトミックな置き換えで保存する。
- CSRF 対策：状態を変える API（POST / PUT / PATCH / DELETE）は、`Sec-Fetch-Site` / `Origin` ヘッダーでクロスサイトからのリクエストを拒否する（Go 標準の `http.CrossOriginProtection`）。
- ログイン試行の制限：同じクライアントからの失敗が 15 分以内に 5 回続いたら 15 分間ロックする。リバースプロキシが同一ホスト上にある場合のみ `X-Forwarded-For` を信頼する。
- ログインが無効のまま外部から到達できるアドレスで待ち受けている場合は、起動時に警告を出す。
- バックアップ：設定ファイルと `data_dir` をコピーすればよい。

---

## 5. 設定

### 5.1 設定ファイル（TOML）
起動時に `-config FILE`（既定：`$FUGURUMA_CONFIG` または `./config.toml`）を読み込む。存在しなければ既定値で作成する。

```toml
[server]                  # 再起動で反映
  addr = ":8080"
  data_dir = "/var/lib/fuguruma"
  books_dir = "/srv/books"

[library]
  scan_interval = "30m"   # "0" で自動スキャン無効
  upload_enabled = true   # Web からのアップロード（§3.1.1）
  upload_dir = "Uploads"  # books_dir からの相対パス
  upload_max_mb = 512

[auth]
  password_hash = ""      # bcrypt。空ならログイン不要

[ai]
  provider = "none"       # none | anthropic | openai
  [ai.anthropic]
    api_key = ""
    model = "claude-opus-5-5"
    effort = "medium"     # low | medium | high | xhigh | max
  [ai.openai]
    base_url = "https://api.openai.com/v1"
    api_key = ""
    model = ""
```

### 5.2 環境変数による上書き
コンテナや秘密情報の受け渡し用。ファイルには書き戻さない。

| 変数 | 上書き対象 |
|---|---|
| `FUGURUMA_CONFIG` | 設定ファイルのパス（`-config` の既定値） |
| `FUGURUMA_ADDR` / `FUGURUMA_DATA_DIR` / `FUGURUMA_BOOKS_DIR` | `server.*` |
| `FUGURUMA_PASSWORD` | ログインパスワード（平文、`password_hash` より優先） |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | 各プロバイダの API キー |

### 5.3 コマンド
- `fuguruma [-config FILE] [serve]`：サーバー起動
- `fuguruma [-config FILE] passwd`：ログインパスワードを設定（空入力でログイン無効）
- `fuguruma version`：バージョンを表示（リリースビルドではタグ名）

### 5.4 デプロイ形態
1. **バイナリ + systemd（基本）**：`deploy/fuguruma.service`（システム）/ `deploy/fuguruma.user.service`（ユーザー単位）。専用ユーザー、`StateDirectory=fuguruma`（= `/var/lib/fuguruma`）、`ProtectSystem=strict` で書き込み先を `/var/lib/fuguruma` と `/etc/fuguruma` に限定。
2. **Docker（任意）**：`/config`（設定）・`/data`（データ）・`/books`（本）をマウント。

---

## 6. データモデル（SQLite）

```sql
books(id TEXT PK, path TEXT UNIQUE, format TEXT, title, author, description,
      fingerprint TEXT, size INT, mtime INT, has_cover INT,
      missing INT, added_at INT, updated_at INT, last_opened_at INT)
tags(id INTEGER PK, name TEXT UNIQUE, color TEXT)
book_tags(book_id, tag_id, PK(book_id, tag_id))
progress(book_id PK, locator TEXT, percent REAL, updated_at INT)
highlights(id TEXT PK, book_id, locator TEXT /*JSON*/, text, color, comment,
           created_at, updated_at)
notes(id TEXT PK, book_id NULL, title, body /*Markdown*/, created_at, updated_at)
conversations(id TEXT PK, book_id, title, passage, context, locator, created_at, updated_at)
messages(id TEXT PK, conversation_id, role /*user|assistant*/, content, created_at)
```

- `locator`（JSON）
  - EPUB：`{"type":"epub","cfi":"epubcfi(...)"}`
  - PDF：`{"type":"pdf","page":12,"rects":[[x,y,w,h],...]}`（rect はページサイズで 0〜1 に正規化）
- 時刻は全て Unix ミリ秒。

---

## 7. API（`/api` 配下, JSON）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/status` | 認証要否・ログイン状態・AI 有効か・プロバイダ名 |
| POST | `/api/login` / `/api/logout` | `{password}` |
| GET | `/api/books?q=&tag=&sort=` | 本一覧（タグ・進捗付き） |
| GET / PATCH | `/api/books/{id}` | 詳細 / タイトル・著者編集 |
| DELETE | `/api/books/{id}` | missing の本を本棚から削除（ファイルが存在する本は 409）。本のファイルは削除しない |
| GET | `/api/books/{id}/file` | 本ファイル（Range 対応） |
| GET / PUT | `/api/books/{id}/cover` | 表紙取得 / アップロード（PDF 用） |
| PUT | `/api/books/{id}/tags` | `{tagIds:[...]}` タグ付け替え |
| GET / PUT | `/api/books/{id}/progress` | 読書位置 |
| POST | `/api/library/scan` | 再スキャン（本のディレクトリが読めない・空のときは 503 で中止し、本の状態を変えない） |
| POST | `/api/library/upload` | 本のアップロード（multipart：`tagIds` → `file` の順）。201 で本を返す。409 重複（`bookId` 付き）/ 413 サイズ超過 / 415 非対応形式 / 403 無効 |
| GET / POST | `/api/tags` | 一覧 / 作成 |
| PATCH / DELETE | `/api/tags/{id}` | 編集 / 削除 |
| GET / POST | `/api/books/{id}/highlights` | 一覧 / 作成 |
| PATCH / DELETE | `/api/highlights/{id}` | 編集 / 削除 |
| GET / POST | `/api/notes?bookId=&q=` | 一覧 / 作成 |
| GET / PATCH / DELETE | `/api/notes/{id}` | 取得 / 編集 / 削除 |
| GET / POST | `/api/books/{id}/conversations` | 会話一覧 / 作成 `{passage, context, locator}` |
| GET / PATCH / DELETE | `/api/conversations/{id}` | 取得（メッセージ込み）/ 改題 / 削除 |
| POST | `/api/conversations/{id}/messages` | 送信 → **SSE** で応答ストリーム |
| POST | `/api/conversations/{id}/summarize` | AI 要約 → ノート作成 |
| POST | `/api/conversations/{id}/export` | 会話を Markdown 化してノート作成/追記 `{noteId?, messageIds?}` |

| GET / PUT | `/api/settings` | 設定の取得 / 部分更新（ライブラリ・AI）。API キーは返さない |
| POST | `/api/settings/password` | `{current, new}` パスワード設定・変更（`new` 空で無効化） |
| POST | `/api/settings/ai/test` | 未保存の AI 設定で接続テスト |

SSE イベント（`data: <json>`）：`{"type":"delta","text":"..."}` / `{"type":"done","message":{...}}` / `{"type":"error","error":"..."}`

---

## 8. 画面

1. **ログイン**（パスワード設定時のみ）
2. **本棚**：ヘッダ（検索・並び替え・再スキャン）、タグチップ列、表紙グリッド。長押し/右クリック or 「…」で本の編集（タグ・タイトル）。
3. **リーダー**：全画面。上部バー（戻る・目次・設定・パネル）は中央タップで表示/非表示。右（スマホは下からのシート）にパネル：ハイライト / ノート / AI。
4. **ノート一覧・エディタ**：Markdown 編集 + プレビュー。
5. **設定**：AI 連携、ライブラリ、ログインパスワード、サーバー情報（§3.8）。

---

## 9. ディレクトリ構成

```
fuguruma/
├── cmd/fuguruma/main.go          エントリポイント（serve / passwd）
├── internal/
│   ├── config/                 設定ファイルの読み込み・検証・保存
│   ├── db/                     SQLite 接続・マイグレーション・クエリ
│   ├── library/                スキャナ・EPUB メタデータ/表紙抽出
│   ├── auth/                   セッション Cookie
│   ├── ai/                     AI プロバイダ（Claude API / OpenAI 互換）
│   └── api/                    HTTP ハンドラ
├── web/                        フロントエンド (Vite + React + TS)
│   ├── embed.go                dist を go:embed
│   └── src/
├── deploy/                     systemd ユニット、設定ファイル例
├── Dockerfile / docker-compose.yml / Makefile
└── docs/SPEC.md
```

---

## 10. ロードマップ（v0.2 以降の候補）
- PWA 化（ホーム画面追加・オフラインキャッシュ）
- 縦書き EPUB の最適化、ルビ
- CBZ（コミック）対応
- ハイライト全文検索、ノート間リンク
- 本全体を AI に渡す「この本について質問」（章単位の要約キャッシュ）
- AI プロバイダの追加（Gemini ネイティブ API、Bedrock 等）
- ノートのエクスポート（Obsidian 向け Markdown 一括出力）
- OPDS フィード
