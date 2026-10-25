import { FormEvent, useState } from "react";
import { api } from "../api";

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.login(pw);
      onLogin();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="brand" style={{ fontSize: 32, justifyContent: "center" }}><img src="/favicon.svg" alt="" style={{ width: 40, height: 40 }} />文車 Fuguruma</div>
        <input className="input" type="password" placeholder="パスワード" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <div className="small" style={{ color: "#c0392b" }}>{err}</div>}
        <button className="btn primary" style={{ justifyContent: "center" }}>ログイン</button>
      </form>
    </div>
  );
}
