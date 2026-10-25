import { useEffect, useState } from "react";

type ToastMsg = { text: string; action?: { label: string; run: () => void }; id: number };

let push: (t: Omit<ToastMsg, "id">) => void = () => {};

/** Shows a transient message at the bottom of the screen. */
export function toast(text: string, action?: ToastMsg["action"]) {
  push({ text, action });
}

export function ToastHost() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  useEffect(() => {
    push = (t) => setMsg({ ...t, id: Date.now() });
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), msg.action ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [msg]);
  if (!msg) return null;
  return (
    <div className="toast" role="status">
      <span>{msg.text}</span>
      {msg.action && (
        <button
          onClick={() => {
            msg.action!.run();
            setMsg(null);
          }}
        >
          {msg.action.label}
        </button>
      )}
    </div>
  );
}
