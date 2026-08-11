import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SessionExpiredError } from "./api/access";
import { App } from "./App";
import "./index.css";

/**
 * データ取得の既定。
 *
 * ミラーは 1 日 1 回しか更新されない（launchd で毎日 06:00）ので、
 * 画面に戻るたびに取り直す必要はない。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      // セッション切れは画面遷移で解決するので、リトライしても無駄に終わる
      retry: (failureCount, error) => !(error instanceof SessionExpiredError) && failureCount < 2,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root が無い");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
