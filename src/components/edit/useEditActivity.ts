/** 編集送信を止めるべき端末状態を購読する。 */

import { useEffect, useRef, useState } from "react";

import { useOnline } from "../../hooks/useOnline";
import { isEditSendBlocked } from "../../lib/edit";

/**
 * オフラインまたはバックグラウンドなら true を返す。
 *
 * @returns 新規送信を止める状態と理由。
 */
export function useEditActivity() {
  const online = useOnline();
  const [hidden, setHidden] = useState(() => document.hidden);
  // 通信中に一度中断して戻っても、利用者が再開するまでは停止を保持する。
  const interrupted = useRef(false);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) interrupted.current = true;
      setHidden(document.hidden);
    };
    const onOffline = () => {
      interrupted.current = true;
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return {
    online,
    hidden,
    blocked: isEditSendBlocked(online, hidden),
    /** 手動の保存・再開操作で中断履歴を解除する。 */
    resetInterruption: () => {
      interrupted.current = false;
    },
    /** 通信中に発生した中断も、現在の表示状態によらず返す。 */
    wasInterrupted: (): boolean => interrupted.current,
  };
}
