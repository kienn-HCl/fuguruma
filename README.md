<p align="center">
  <img src="docs/logo.svg" width="96" alt="Fuguruma logo">
</p>

<h1 align="center">文車 Fuguruma</h1>

手持ちの電子書籍（EPUB / PDF）を、スマホ・タブレット・PC のブラウザから同じ UI で読むためのセルフホスト型リーダーです。
読書位置・ハイライト・読書メモ・AI との会話はすべてサーバーに保存され、全端末で同期されます。

本のファイルは**任意のディレクトリ**に置けます（サーバーのローカルディスク、外付けドライブ、NFS / SMB でマウントした共有フォルダなど）。

- 📚 表紙付きの本棚表示、タグでグルーピング、検索・並び替え
- 📖 EPUB（epub.js）/ PDF（pdf.js、日本語 PDF 対応）リーダー。タップ・スワイプ・キーボードでページ送り
- 🖍 ハイライト（5 色）＋コメント、Markdown の読書ノート
- ✦ 選択した文をもとに AI と会話。会話は本ごとに保存され、ノートへ書き出し／AI 要約してから自分で整形できる
  - AI は **Claude API / OpenAI 互換 API（OpenAI・Gemini・OpenRouter・Ollama・LM Studio など）/ サーバー上の Claude Code（`claude -p`）** から選択。Web の設定画面で切り替え可能
- 🔄 端末間で読書位置を同期（別端末で先に進んでいたら「移動」を提案）
- 📁 本のファイルを移動・リネームしても、内容の指紋で同じ本として追跡（メモが消えない）

仕様の詳細は [docs/SPEC.md](docs/SPEC.md) を参照してください。

- [スクリーンショット](#スクリーンショット)
- [はじめかた](#はじめかた)
- [systemd で動かす（推奨）](#systemd-で動かす推奨)
- [Docker で動かす（任意）](#docker-で動かす任意)
- [外部からアクセスする場合](#外部からアクセスする場合)
- [設定](#設定)
- [構成と開発](#構成と開発)

## スクリーンショット

**本棚**：表紙の一覧、タグで絞り込み、読書進捗バー

![本棚](docs/screenshots/library.png)

**リーダー + AI**：選択した文について AI と会話。ハイライトは黄色、会話は本ごとに保存される

![リーダーと AI パネル](docs/screenshots/reader-ai.png)

| 文を選択したときのメニュー | AI の会話を要約してノートに保存 |
|---|---|
| ![選択メニュー](docs/screenshots/reader-selection.png) | ![ノート](docs/screenshots/notes.png) |

| ダークテーマと目次 | 設定画面（AI プロバイダの切り替え） |
|---|---|
| ![ダークテーマ](docs/screenshots/reader-dark.png) | ![設定](docs/screenshots/settings.png) |

**スマホ**

<p>
  <img src="docs/screenshots/mobile-library.png" width="260" alt="スマホの本棚">
  <img src="docs/screenshots/mobile-reader.png" width="260" alt="スマホのリーダー">
  <img src="docs/screenshots/mobile-ai.png" width="260" alt="スマホの AI パネル">
</p>

<sub>サンプルの本は著作権の切れた作品の冒頭部分を使って生成したものです。AI の応答は `claude-cli` プロバイダ（Claude Code）による実際の出力です。</sub>

## はじめかた

### ビルド

```bash
make build                          # web をビルドし、bin/fuguruma を生成（Node.js はビルド時のみ必要）
make build GOOS=linux GOARCH=arm64  # 別アーキテクチャ向けのクロスコンパイル
```

実行に必要なのは **バイナリ 1 つと設定ファイル 1 つ** です。Docker は必須ではありません。

### とりあえず試す

```bash
./bin/fuguruma -config ./config.toml          # 初回は config.toml が作られる
# config.toml の server.books_dir を本のディレクトリに書き換えて再起動
./bin/fuguruma -config ./config.toml passwd   # ログインパスワードを設定（任意）
```

http://localhost:8080 を開き、⚙（設定）から AI プロバイダを設定します。

## systemd で動かす（推奨）

バイナリ + systemd でそのままサーバーとして常駐させられます。以下は Linux での例です。

```bash
# 1. 専用ユーザーとバイナリ
sudo useradd --system --home-dir /var/lib/fuguruma --shell /usr/sbin/nologin fuguruma
sudo install -m 755 bin/fuguruma /usr/local/bin/fuguruma

# 2. 設定ファイル（Web から編集できるよう、ディレクトリごとサービスユーザーの所有にする）
sudo install -d -o fuguruma -g fuguruma -m 750 /etc/fuguruma
sudo install -o fuguruma -g fuguruma -m 600 deploy/config.example.toml /etc/fuguruma/config.toml
sudoedit /etc/fuguruma/config.toml          # server.books_dir などを編集

# 3. ログインパスワード
sudo -u fuguruma /usr/local/bin/fuguruma -config /etc/fuguruma/config.toml passwd

# 4. ユニットを登録して起動（/var/lib/fuguruma は systemd が作成）
sudo install -m 644 deploy/fuguruma.service /etc/systemd/system/fuguruma.service
sudo systemctl daemon-reload
sudo systemctl enable --now fuguruma
```

運用コマンド:

```bash
systemctl status fuguruma          # 状態
journalctl -u fuguruma -f          # ログ
sudo systemctl restart fuguruma    # [server] の設定を変えたら再起動
```

注意点:

- 本のディレクトリは `fuguruma` ユーザーが**読める**必要があります（書き込み権限は不要）。例: `sudo setfacl -R -m u:fuguruma:rX /srv/books`
- ユニットは `ProtectSystem=strict` / `ProtectHome=read-only` で、書き込み可能なのは `/var/lib/fuguruma` と `/etc/fuguruma` だけです。本のディレクトリが `/home` 配下でも読み取りは可能です。
- 本のディレクトリがネットワークマウント（NFS/SMB）の場合は、ユニットの `RequiresMountsFor=` のコメントを外してパスを書くと、マウント完了後に起動します。
- API キーなどを設定ファイルに書きたくない場合は `/etc/fuguruma/env`（`ANTHROPIC_API_KEY=...` 形式、`chmod 600`）に書けば読み込まれます。

### AI に Claude Code（`claude -p`）を使う場合

サーバーにインストールした Claude Code をサービスユーザーとして認証しておきます。

```bash
# サブスクリプションの場合: 長期トークンを発行して env に書く
claude setup-token                                  # 自分のアカウントで実行し、表示されたトークンを控える
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' | sudo tee -a /etc/fuguruma/env
# または API キー: echo 'ANTHROPIC_API_KEY=sk-ant-...' | sudo tee -a /etc/fuguruma/env
sudo chmod 600 /etc/fuguruma/env && sudo chown fuguruma: /etc/fuguruma/env
sudo systemctl restart fuguruma
```

`claude` が `/usr/local/bin` など PATH 上に無い場合は、設定ファイルの `ai.claude_cli.command` にフルパスを書いてください。Fuguruma は `claude -p` を**ツール無効**（`--tools ""`）・空の作業ディレクトリで実行するため、本文に含まれる指示によってサーバー上でコマンドが実行されることはありません。

### ユーザー単位で動かす場合（自分の PC など）

```bash
install -D -m 755 bin/fuguruma ~/.local/bin/fuguruma
install -D -m 644 deploy/fuguruma.user.service ~/.config/systemd/user/fuguruma.service
~/.local/bin/fuguruma -config ~/.config/fuguruma/config.toml passwd   # 設定ファイル作成 + パスワード
$EDITOR ~/.config/fuguruma/config.toml                               # books_dir / data_dir を絶対パスで設定
systemctl --user daemon-reload && systemctl --user enable --now fuguruma
journalctl --user -u fuguruma -f
loginctl enable-linger "$USER"     # ログアウト後も動かし続ける場合
```

（ユーザー単位の場合は `data_dir` に例えば `~/.local/share/fuguruma` の絶対パスを指定してください）

## Docker で動かす（任意）

```bash
mkdir -p config data && sudo chown 1000:1000 config data
# docker-compose.yml の /path/to/books を本のディレクトリに書き換える
docker compose up -d --build
```

コンテナ内のパスは環境変数で固定され、設定は `./config/config.toml` に保存されます。最小イメージには `claude` CLI が含まれないため、`claude-cli` プロバイダを使う場合はバイナリ + systemd 構成にしてください。

## 外部からアクセスする場合

ログインパスワードを設定し、Caddy などで HTTPS を終端してください（Tailscale 等の VPN 内だけで使うならパスワードなしでも可）。ログインを無効にすると、アクセスできる人は誰でも設定画面から AI の API キーを差し替えられる点に注意してください。

AI の応答はストリーミング（SSE）なので、nginx を挟む場合は `proxy_buffering off;` を推奨します。

```
# Caddyfile の例
books.example.com {
  reverse_proxy localhost:8080
}
```

## 設定

### 設定ファイルとデータ

| | 場所 | 内容 |
|---|---|---|
| 設定 | `-config` で指定した TOML（既定 `./config.toml`、環境変数 `FUGURUMA_CONFIG` でも指定可） | 待受アドレス、ディレクトリ、ログインパスワード（bcrypt ハッシュ）、AI プロバイダと API キーなど |
| データ | 設定の `server.data_dir` | `fuguruma.db`（SQLite）、`covers/`、セッション署名鍵 |

- 設定ファイルが無ければ起動時に既定値で作成されます。例: [deploy/config.example.toml](deploy/config.example.toml)
- `[library]` `[auth]` `[ai]` は Web の **設定画面（⚙）** から変更でき、即時反映されます（保存時にファイルが書き換わり、コメントは消えます）。
- `[server]`（待受アドレス・本のディレクトリ・データディレクトリ）と `ai.claude_cli.command` は、セキュリティのため**設定ファイルでのみ**変更できます。変更後は再起動してください。
- API キーを含むため、設定ファイルはパーミッション `0600` で保存されます。
- 環境変数 `FUGURUMA_ADDR` / `FUGURUMA_DATA_DIR` / `FUGURUMA_BOOKS_DIR` / `FUGURUMA_PASSWORD` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` は設定ファイルの値を上書きします（ファイルには書き戻されません。主にコンテナ向け）。
- バックアップは `data_dir` と設定ファイルをコピーすれば十分です。

### AI プロバイダ

| provider | 説明 |
|---|---|
| `anthropic` | Claude API（公式 Go SDK）。安全分類器で拒否された場合に推奨モデルへ自動で再試行するサーバー側フォールバック（`fallbacks: "default"`）を有効にしています |
| `openai` | OpenAI 互換の Chat Completions API。`base_url` を変えれば OpenAI / Gemini / OpenRouter / Ollama / LM Studio / vLLM などに接続できます |
| `claude-cli` | サーバー上の Claude Code を `claude -p` で実行。CLI 側の認証（サブスクリプション等）をそのまま使います |
| `none` | AI 機能を無効化 |

設定画面の「接続テスト」で、保存前に疎通を確認できます。

## 構成と開発

### 技術構成

| | |
|---|---|
| バックエンド | Go（標準 `net/http`）+ SQLite（`modernc.org/sqlite`、CGO 不要） |
| フロントエンド | TypeScript + React + Vite（ビルド結果を Go バイナリに `embed`） |
| 設定 | TOML の設定ファイル（Web の設定画面からも編集可） |
| データ | `data_dir` 配下の SQLite（本のメタデータ・タグ・進捗・ハイライト・ノート・AI 会話）と表紙キャッシュ |

### 開発

```bash
make dev-api   # API サーバー（config.toml を使用、:8080）
make dev-web   # Vite 開発サーバー（:5173、/api は :8080 へプロキシ）
go test ./...
```

```
cmd/fuguruma      エントリポイント（serve / passwd）
internal/config   設定ファイルの読み込み・検証・保存、環境変数による上書き
internal/db       SQLite スキーマ（マイグレーション）とクエリ
internal/library  ディレクトリスキャン、EPUB メタデータ・表紙抽出、移動検知
internal/auth     パスワード（bcrypt）+ 署名付き Cookie
internal/ai       プロバイダ（anthropic / openai / claude-cli）、プロンプト
internal/api      REST / SSE ハンドラ、設定 API、SPA 配信
web/src/pages     本棚・リーダー・ノート・設定・ログイン
web/src/reader    EpubView / PdfView（共通インターフェース ReaderHandle）
deploy/           systemd ユニット、設定ファイル例
docs/             仕様書（SPEC.md）、スクリーンショット、ロゴ
```

DB スキーマを変更するときは `internal/db/db.go` の `migrations` に要素を **追加** してください（`PRAGMA user_version` で適用済みを管理）。

## 既知の制限 / 今後

- 表示設定（テーマ・文字サイズ・本文フォント）は端末ごと
- オフライン読書（PWA）、CBZ、縦書き最適化、本全体を対象にした AI 質問は未対応（SPEC.md §10）
- PDF は 1 ページ表示。ハイライトは選択範囲の矩形で保存するため、ズーム倍率が変わっても位置は保たれます
