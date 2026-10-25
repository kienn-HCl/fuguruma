import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Conversation, Locator, Message, Note, sendMessage } from "../api";
import Markdown from "./Markdown";
import { toast } from "./Toast";

const suggestions = ["わかりやすく解説して", "背景や前提知識を教えて", "要点をまとめて", "反対の立場から考えると？", "具体例を挙げて"];

/** AI tab of the reader panel: conversation list, or one open conversation. */
export default function AiPanel({
  bookId, openId, onOpen, onJump, activeNote, onNoteSaved, enabled,
}: {
  bookId: string;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onJump: (loc: Locator) => void;
  activeNote: Note | null;
  onNoteSaved: (n: Note) => void;
  enabled: boolean;
}) {
  const [list, setList] = useState<Conversation[]>([]);
  useEffect(() => {
    if (!openId) api.conversations(bookId).then(setList);
  }, [bookId, openId]);

  if (openId) {
    return <Chat key={openId} id={openId} onBack={() => onOpen(null)} onJump={onJump} activeNote={activeNote} onNoteSaved={onNoteSaved} enabled={enabled} />;
  }
  return (
    <div>
      {!enabled && <div className="empty small">AI は無効です。<a href="/settings">設定画面</a>から AI プロバイダを設定してください。</div>}
      <div className="small muted" style={{ padding: "10px 16px" }}>本文を選択して「AIに聞く」で会話を始めます。</div>
      {list.length === 0 && <div className="empty">まだ会話はありません</div>}
      {list.map((c) => (
        <div key={c.id} className="list-item" onClick={() => onOpen(c.id)}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.title || "（無題）"}</div>
          {c.passage && <blockquote className="quote">{c.passage}</blockquote>}
          <div className="small muted" style={{ marginTop: 4 }}>{new Date(c.updatedAt).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function Chat({
  id, onBack, onJump, activeNote, onNoteSaved, enabled,
}: {
  id: string;
  onBack: () => void;
  onJump: (loc: Locator) => void;
  activeNote: Note | null;
  onNoteSaved: (n: Note) => void;
  enabled: boolean;
}) {
  const nav = useNavigate();
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
      if (!title) api.conversation(id).then((c) => setTitle(c.title));
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

  const savedToast = (n: Note) => {
    onNoteSaved(n);
    toast(activeNote ? `「${n.title || "ノート"}」に追記しました` : "ノートを作成しました", {
      label: "開く",
      run: () => nav(`/notes/${n.id}`),
    });
  };

  const exportAll = async (messageIds?: string[]) => {
    const n = await api.exportConversation(id, { noteId: activeNote?.id, messageIds });
    savedToast(n);
  };

  const summarize = async () => {
    setBusy("summarize");
    try {
      const n = await api.summarizeConversation(id, { noteId: activeNote?.id });
      savedToast(n);
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
  const target = activeNote ? `「${activeNote.title || "無題"}」に追記` : "新規ノート";

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
            onBlur={() => title !== conv.title && api.renameConversation(id, title)}
          />
          <button className="btn ghost small danger" onClick={removeConv}>削除</button>
        </div>
        {conv.passage && (
          <blockquote className="quote" style={{ marginTop: 8, cursor: conv.locator ? "pointer" : undefined }} onClick={() => conv.locator && onJump(conv.locator)} title="本文の該当箇所へ">
            {conv.passage}
          </blockquote>
        )}
        {msgs.length > 0 && (
          <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
            <button className="btn small" onClick={() => exportAll()} title={target}>📝 会話をノートへ</button>
            <button className="btn small" onClick={summarize} disabled={!!busy || !enabled}>
              {busy === "summarize" ? "要約中…" : "✨ 要約してノートへ"}
            </button>
            <span className="small muted">→ {target}</span>
          </div>
        )}
      </div>
      <div className="chat-msgs">
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
            {m.role === "assistant" && (
              <div className="msg-actions">
                <button className="btn ghost small" onClick={() => exportAll([m.id])}>ノートへ</button>
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
