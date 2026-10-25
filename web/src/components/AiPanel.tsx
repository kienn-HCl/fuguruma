import { useEffect, useRef, useState } from "react";
import { api, Conversation, Locator, Memo, Message, Saved, sendMessage } from "../api";
import Markdown from "./Markdown";
import { toast } from "./Toast";

const suggestions = ["わかりやすく解説して", "背景や前提知識を教えて", "要点をまとめて", "反対の立場から考えると？", "具体例を挙げて"];

/** AI tab of the reader panel: conversation list, or one open conversation. */
export default function AiPanel({
  list, memos, openId, onOpen, onReload, onJump, onShowMemo, onSaved, enabled,
}: {
  /** Conversations of the book. */
  list: Conversation[];
  memos: Memo[];
  openId: string | null;
  onOpen: (id: string | null) => void;
  /** The list changed (title set, conversation deleted). */
  onReload: () => void;
  onJump: (loc: Locator) => void;
  onShowMemo: (m: Memo) => void;
  onSaved: (s: Saved) => void;
  enabled: boolean;
}) {
  if (openId) {
    const conv = list.find((c) => c.id === openId);
    const memo = memos.find((m) => m.id === conv?.memoId) ?? null;
    return (
      <Chat
        key={openId}
        id={openId}
        memo={memo}
        onBack={() => {
          onOpen(null);
          onReload();
        }}
        onJump={onJump}
        onShowMemo={onShowMemo}
        onSaved={onSaved}
        onChanged={onReload}
        enabled={enabled}
      />
    );
  }
  return (
    <div>
      {!enabled && <div className="empty small">AI は無効です。<a href="/settings">設定画面</a>から AI プロバイダを設定してください。</div>}
      <div className="small muted" style={{ padding: "10px 16px" }}>本文を選択して「AIに聞く」で会話を始めます。</div>
      {list.length === 0 && <div className="empty">まだ会話はありません</div>}
      {list.map((c) => {
        const memo = memos.find((m) => m.id === c.memoId);
        return (
          <div key={c.id} className="list-item" onClick={() => onOpen(c.id)}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title || "（無題）"}</div>
            {c.passage && <blockquote className="quote">{c.passage}</blockquote>}
            <div className="small muted" style={{ marginTop: 4 }}>
              {memo && <>📝 {memo.label || "メモ"} · </>}
              {new Date(c.updatedAt).toLocaleString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Chat({
  id, memo, onBack, onJump, onShowMemo, onSaved, onChanged, enabled,
}: {
  id: string;
  memo: Memo | null;
  onBack: () => void;
  onJump: (loc: Locator) => void;
  onShowMemo: (m: Memo) => void;
  onSaved: (s: Saved) => void;
  onChanged: () => void;
  enabled: boolean;
}) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "summarize">("");
  const [title, setTitle] = useState("");
  const abort = useRef<AbortController>();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.conversation(id).then((c) => {
      setConv(c);
      setMsgs(c.messages ?? []);
      setTitle(c.title);
    });
    return () => abort.current?.abort();
  }, [id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [msgs, streaming]);

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    setInput("");
    setBusy("send");
    setStreaming("");
    abort.current = new AbortController();
    try {
      for await (const ev of sendMessage(id, text, abort.current.signal)) {
        if (ev.type === "user") setMsgs((m) => [...m, ev.message]);
        else if (ev.type === "delta") setStreaming((s) => (s ?? "") + ev.text);
        else if (ev.type === "done") {
          setMsgs((m) => [...m, ev.message]);
          setStreaming(null);
        } else if (ev.type === "error") {
          toast(`AI エラー: ${ev.error}`);
          if (ev.removedMessageId) setMsgs((m) => m.filter((x) => x.id !== ev.removedMessageId));
          setInput(text);
          setStreaming(null);
        }
      }
      if (!title)
        api.conversation(id).then((c) => {
          setTitle(c.title);
          onChanged();
        });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // The server discards an interrupted exchange; resync with it.
        api.conversation(id).then((c) => setMsgs(c.messages ?? []));
        setInput(text);
      } else toast((e as Error).message);
      setStreaming(null);
    } finally {
      setBusy("");
    }
  };

  const saved = (r: Saved) => {
    onSaved(r);
    const m = r.memo;
    toast(m ? "メモに追記しました" : "本のノートに追記しました", m ? { label: "メモを見る", run: () => onShowMemo(m) } : undefined);
  };

  const exportAll = async (messageIds?: string[]) => saved(await api.exportConversation(id, { messageIds }));

  const summarize = async () => {
    setBusy("summarize");
    try {
      saved(await api.summarizeConversation(id));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const removeConv = async () => {
    if (!confirm("この会話を削除しますか？")) return;
    await api.deleteConversation(id);
    onBack();
  };

  if (!conv) return <div className="empty">読み込み中…</div>;
  const dest = memo ? "メモ" : "ノート";

  return (
    <div className="chat">
      <div className="chat-head">
        <div className="row">
          <button className="icon-btn" onClick={onBack} aria-label="一覧へ">‹</button>
          <input
            className="editor-title"
            style={{ fontSize: 15 }}
            value={title}
            placeholder="（無題）"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== conv.title && api.renameConversation(id, title).then(onChanged)}
          />
          <button className="btn ghost small danger" onClick={removeConv}>削除</button>
        </div>
        {conv.passage && (
          <blockquote className="quote" style={{ marginTop: 8, cursor: conv.locator ? "pointer" : undefined }} onClick={() => conv.locator && onJump(conv.locator)} title="本文の該当箇所へ">
            {conv.passage}
          </blockquote>
        )}
        {memo && (
          <button className="link small" style={{ marginTop: 4 }} onClick={() => onShowMemo(memo)}>
            📝 メモ（{memo.label || "場所不明"}）に紐づいた会話
          </button>
        )}
        {msgs.length > 0 && (
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
            <button className="btn small" onClick={() => exportAll()} title={`会話を${dest}に追記`}>📝 会話を{dest}へ</button>
            <button className="btn small" onClick={summarize} disabled={!!busy || !enabled} title={`AI が会話を要約して${dest}に追記`}>
              {busy === "summarize" ? "要約中…" : `✨ 要約して${dest}へ`}
            </button>
          </div>
        )}
      </div>
      <div className="chat-msgs">
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
            {m.role === "assistant" && (
              <div className="msg-actions">
                <button className="btn ghost small" onClick={() => exportAll([m.id])}>{dest}へ</button>
                <button className="btn ghost small" onClick={() => navigator.clipboard.writeText(m.content).then(() => toast("コピーしました"))}>コピー</button>
              </div>
            )}
          </div>
        ))}
        {streaming !== null && (
          <div className="msg assistant">
            {streaming ? <Markdown text={streaming} /> : <span className="muted">考え中…</span>}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {msgs.length === 0 && streaming === null && (
        <div className="suggest">
          {suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)} disabled={!enabled}>{s}</button>
          ))}
        </div>
      )}
      <div className="chat-input">
        <textarea
          className="input"
          rows={2}
          value={input}
          disabled={!enabled}
          placeholder={enabled ? "質問を入力（⌘/Ctrl+Enter で送信）" : "AI は無効です"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {busy === "send" ? (
          <button className="btn" onClick={() => abort.current?.abort()}>停止</button>
        ) : (
          <button className="btn primary" onClick={() => send(input)} disabled={!input.trim() || !enabled}>送信</button>
        )}
      </div>
    </div>
  );
}
