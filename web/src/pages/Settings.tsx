import { FormEvent, ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AIPatch, AIProvider, api, Settings } from "../api";
import { useStatus } from "../App";
import { toast } from "../components/Toast";

const providerLabels: Record<AIProvider, string> = {
  none: "使わない",
  anthropic: "Claude API",
  openai: "OpenAI 互換 API",
  "claude-cli": "Claude Code CLI（claude -p）",
};

const openaiPresets = [
  { label: "OpenAI", url: "https://api.openai.com/v1" },
  { label: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { label: "Ollama", url: "http://localhost:11434/v1" },
  { label: "LM Studio", url: "http://localhost:1234/v1" },
];

/** A key input: empty = keep the stored key; `cleared` = remove it. */
type KeyState = { value: string; cleared: boolean };
const emptyKey: KeyState = { value: "", cleared: false };
const keyPatch = (k: KeyState) => (k.cleared ? "" : k.value || undefined);

export default function SettingsPage() {
  const status = useStatus();
  const [s, setS] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<AIProvider>("none");
  const [anth, setAnth] = useState({ model: "", effort: "medium" });
  const [anthKey, setAnthKey] = useState<KeyState>(emptyKey);
  const [oa, setOa] = useState({ baseUrl: "", model: "" });
  const [oaKey, setOaKey] = useState<KeyState>(emptyKey);
  const [cliModel, setCliModel] = useState("");
  const [scan, setScan] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = (x: Settings) => {
    setS(x);
    setProvider(x.ai.provider);
    setAnth({ model: x.ai.anthropic.model, effort: x.ai.anthropic.effort || "medium" });
    setOa({ baseUrl: x.ai.openai.baseUrl, model: x.ai.openai.model });
    setCliModel(x.ai.claudeCli.model);
    setScan(x.library.scanInterval);
    setAnthKey(emptyKey);
    setOaKey(emptyKey);
  };
  useEffect(() => {
    api.settings().then(load);
  }, []);

  if (!s) return null;
  const env = new Set(s.envOverrides ?? []);

  const aiPatch = (): AIPatch => ({
    provider,
    anthropic: { ...anth, apiKey: keyPatch(anthKey) },
    openai: { ...oa, apiKey: keyPatch(oaKey) },
    claudeCli: { model: cliModel },
  });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      load(await api.saveSettings({ library: { scanInterval: scan }, ai: aiPatch() }));
      await status.refresh();
      toast("設定を保存しました");
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testAI(aiPatch());
      setTestResult(r.ok ? { ok: true, text: r.reply ?? "OK" } : { ok: false, text: r.error ?? "失敗しました" });
    } catch (err) {
      setTestResult({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><img src="/favicon.svg" alt="" />文車</Link>
        <strong>設定</strong>
      </header>
      <main className="settings">
        <form onSubmit={save}>
          <section className="card">
            <h2>AI 連携</h2>
            {s.ai.error && <p className="warn">現在の設定ではAIを利用できません: {s.ai.error}</p>}
            <div className="field">
              <label>プロバイダ</label>
              <div className="seg">
                {(Object.keys(providerLabels) as AIProvider[]).map((p) => (
                  <button type="button" key={p} className={`btn ${provider === p ? "primary" : ""}`} onClick={() => setProvider(p)}>
                    {providerLabels[p]}
                  </button>
                ))}
              </div>
            </div>

            {provider === "anthropic" && (
              <>
                <KeyField label="API キー" info={s.ai.anthropic} state={anthKey} onChange={setAnthKey} envLocked={env.has("ai.anthropic.api_key") ? "ANTHROPIC_API_KEY" : ""} />
                <Field label="モデル" hint="例: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5">
                  <input className="input" value={anth.model} onChange={(e) => setAnth({ ...anth, model: e.target.value })} placeholder="claude-opus-5-5" />
                </Field>
                <Field label="effort（応答の深さとコスト）">
                  <select className="input" value={anth.effort} onChange={(e) => setAnth({ ...anth, effort: e.target.value })}>
                    {["low", "medium", "high", "xhigh", "max"].map((v) => <option key={v}>{v}</option>)}
                  </select>
                </Field>
              </>
            )}

            {provider === "openai" && (
              <>
                <Field label="Base URL" hint="Chat Completions 互換のエンドポイント">
                  <input className="input" value={oa.baseUrl} onChange={(e) => setOa({ ...oa, baseUrl: e.target.value })} />
                  <div className="row" style={{ flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {openaiPresets.map((p) => (
                      <button type="button" key={p.label} className="chip" onClick={() => setOa({ ...oa, baseUrl: p.url })}>{p.label}</button>
                    ))}
                  </div>
                </Field>
                <KeyField label="API キー（ローカル LLM なら不要）" info={s.ai.openai} state={oaKey} onChange={setOaKey} envLocked={env.has("ai.openai.api_key") ? "OPENAI_API_KEY" : ""} />
                <Field label="モデル" hint="プロバイダ側のモデル名をそのまま入力">
                  <input className="input" value={oa.model} onChange={(e) => setOa({ ...oa, model: e.target.value })} placeholder="モデル名" required />
                </Field>
              </>
            )}

            {provider === "claude-cli" && (
              <>
                <p className="small muted">
                  サーバー上の Claude Code（<code>{s.ai.claudeCli.command}</code>）を <code>claude -p</code> で呼び出します（ツールは無効化）。
                  CLI は <code>ANTHROPIC_API_KEY</code>（API キー）で認証してください。
                  Claude のサブスクリプション（Free / Pro / Max）の認証情報をこのようなアプリ経由で使うことは、
                  Anthropic の規約で認められていない場合があります。
                </p>
                <Field label="モデル（空欄で CLI の既定）" hint="例: opus, sonnet, claude-opus-5-5">
                  <input className="input" value={cliModel} onChange={(e) => setCliModel(e.target.value)} />
                </Field>
              </>
            )}

            {provider !== "none" && (
              <div className="row" style={{ alignItems: "flex-start" }}>
                <button type="button" className="btn" onClick={test} disabled={testing}>{testing ? "テスト中…" : "接続テスト"}</button>
                {testResult && <span className="small" style={{ color: testResult.ok ? "#2e7d32" : "#c0392b", whiteSpace: "pre-wrap" }}>{testResult.ok ? "✓ " : "✗ "}{testResult.text}</span>}
              </div>
            )}
          </section>

          <section className="card">
            <h2>ライブラリ</h2>
            <Field label="自動スキャン間隔" hint="例: 30m, 2h。0 で自動スキャンしない（本棚の ⟳ で手動実行）">
              <input className="input" value={scan} onChange={(e) => setScan(e.target.value)} style={{ maxWidth: 160 }} />
            </Field>
          </section>

          <div className="row" style={{ justifyContent: "flex-end", marginBottom: 24 }}>
            <button className="btn primary">保存</button>
          </div>
        </form>

        <PasswordCard passwordSet={s.auth.passwordSet} envLocked={env.has("auth.password")} onChanged={() => api.settings().then(load).then(status.refresh)} />

        <section className="card">
          <h2>サーバー</h2>
          <p className="small muted">以下は設定ファイルで変更し、サーバーを再起動すると反映されます。</p>
          <dl className="kv">
            <dt>設定ファイル</dt><dd><code>{s.configPath}</code></dd>
            <dt>待受アドレス</dt><dd><code>{s.server.addr}</code>{env.has("server.addr") && <Env name="FUGURUMA_ADDR" />}</dd>
            <dt>本のディレクトリ</dt><dd><code>{s.server.booksDir}</code>{env.has("server.books_dir") && <Env name="FUGURUMA_BOOKS_DIR" />}</dd>
            <dt>データディレクトリ</dt><dd><code>{s.server.dataDir}</code>{env.has("server.data_dir") && <Env name="FUGURUMA_DATA_DIR" />}</dd>
          </dl>
        </section>
      </main>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="small muted" style={{ marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function Env({ name }: { name: string }) {
  return <span className="small muted"> （環境変数 {name} で上書き中）</span>;
}

function KeyField({
  label, info, state, onChange, envLocked,
}: {
  label: string;
  info: { apiKeySet: boolean; apiKeyHint: string };
  state: KeyState;
  onChange: (k: KeyState) => void;
  envLocked: string;
}) {
  if (envLocked) {
    return (
      <Field label={label}>
        <div className="small muted">環境変数 {envLocked} で設定されています（{info.apiKeyHint}）</div>
      </Field>
    );
  }
  const stored = info.apiKeySet && !state.cleared;
  return (
    <Field label={label} hint={stored ? "保存済みのキーを使います。変更する場合のみ入力してください。" : undefined}>
      <div className="row">
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={state.value}
          placeholder={stored ? `設定済み ${info.apiKeyHint}` : "未設定"}
          onChange={(e) => onChange({ value: e.target.value, cleared: false })}
        />
        {stored && <button type="button" className="btn ghost small danger" onClick={() => onChange({ value: "", cleared: true })}>削除</button>}
        {state.cleared && <span className="small muted">保存時に削除</span>}
      </div>
    </Field>
  );
}

function PasswordCard({ passwordSet, envLocked, onChanged }: { passwordSet: boolean; envLocked: boolean; onChanged: () => void }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const submit = async (e: FormEvent, disable = false) => {
    e.preventDefault();
    if (disable && !confirm("ログインを無効にすると、このサーバーにアクセスできる人は誰でも本・メモ・設定を閲覧・変更できます。よろしいですか？")) return;
    try {
      await api.changePassword(cur, disable ? "" : next);
      setCur("");
      setNext("");
      toast(disable ? "ログインを無効にしました" : "パスワードを変更しました（他の端末はログアウトされます）");
      onChanged();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>ログインパスワード</h2>
      {envLocked ? (
        <p className="small muted">環境変数 FUGURUMA_PASSWORD で設定されているため、ここでは変更できません。</p>
      ) : (
        <form onSubmit={submit}>
          {!passwordSet && <p className="warn">ログインが無効です。外部からアクセスできる環境ではパスワードを設定してください。</p>}
          {passwordSet && (
            <Field label="現在のパスワード">
              <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
            </Field>
          )}
          <Field label="新しいパスワード（8 文字以上）">
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} required />
          </Field>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {passwordSet && <button type="button" className="btn ghost danger" onClick={(e) => submit(e, true)}>ログインを無効にする</button>}
            <button className="btn primary">{passwordSet ? "変更" : "設定"}</button>
          </div>
        </form>
      )}
    </section>
  );
}
