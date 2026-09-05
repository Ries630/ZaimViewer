/** 検証済みの編集能力と公開設定。 */
import * as v from "valibot";
import { editModeSchema, type EditCapabilities } from "./edit-contract";

/** 検証完了後に運用側で設定する非秘密のフラグ。 */
export interface EditEnvironment {
  EDIT_ENABLED?: string;
  EDIT_VERIFIED_MODES?: string;
  EDIT_INCOME_NAME_VERIFIED?: string;
  EDIT_TRANSFER_VERIFIED?: string;
}

/**
 * 未設定・不正な設定を有効化と解釈しない。
 * @param env Worker の設定。
 * @returns 公開してよい編集能力。
 */
export function editCapabilitiesOf(env: EditEnvironment): EditCapabilities {
  const parsed = v.safeParse(
    v.array(editModeSchema),
    (env.EDIT_VERIFIED_MODES ?? "").split(",").filter(Boolean),
  );
  const transfer = env.EDIT_TRANSFER_VERIFIED === "true";
  const modes = parsed.success ? parsed.output.filter((mode) => mode !== "transfer" || transfer) : [];
  const enabled = env.EDIT_ENABLED === "true" && modes.length > 0;
  return {
    enabled,
    modes: enabled ? modes : [],
    incomeName: enabled && env.EDIT_INCOME_NAME_VERIFIED === "true",
    transfer: enabled && transfer,
  };
}
