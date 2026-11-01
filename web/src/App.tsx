import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, Status } from "./api";
import Library from "./pages/Library";
import Reader from "./pages/Reader";
import Notes from "./pages/Notes";
import Login from "./pages/Login";
import SettingsPage from "./pages/Settings";
import { ToastHost } from "./components/Toast";
import { flushProgress, useOnline } from "./offline";

type StatusCtxValue = Status & { refresh: () => Promise<void> };
const StatusCtx = createContext<StatusCtxValue>({ authRequired: false, loggedIn: true, aiEnabled: false, aiProvider: "none", uploadEnabled: false, uploadMaxMb: 0, refresh: async () => {} });
export const useStatus = () => useContext(StatusCtx);

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const online = useOnline();
  const refresh = useCallback(
    () =>
      api
        .status()
        .then((s) => {
          setStatus(s);
          try {
            localStorage.setItem("fuguruma:status", JSON.stringify(s));
          } catch { /* ignore */ }
        })
        .catch(() => {
          // Offline without a cached answer: assume the last known state so saved books can be read.
          try {
            const last = JSON.parse(localStorage.getItem("fuguruma:status") || "null");
            if (last) setStatus(last);
          } catch { /* ignore */ }
        }),
    [],
  );

  // Reading positions recorded offline are sent once the connection is back.
  useEffect(() => {
    if (online) flushProgress();
  }, [online]);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => refresh();
    window.addEventListener("fuguruma:unauthorized", onUnauthorized);
    return () => window.removeEventListener("fuguruma:unauthorized", onUnauthorized);
  }, [refresh]);

  if (!status) return null;
  if (status.authRequired && !status.loggedIn) return <Login onLogin={refresh} />;

  return (
    <StatusCtx.Provider value={{ ...status, refresh }}>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/read/:id" element={<Reader />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/notes/:id" element={<Notes />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      {!online && <div className="offline-banner" role="status" title="この端末に保存した本を読めます（メモ・ノートは読むだけ）">オフライン</div>}
      <ToastHost />
    </StatusCtx.Provider>
  );
}
