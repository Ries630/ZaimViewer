/**
 * 編集計画 API のクライアント。
 *
 * 編集系エンドポイントは作成・実行・照合の状態を同じ計画 ID で追跡する。
 * 読み取り RPC の `hc` とは別に、ここでは URL を明示する。計画 ID を URL
 * エンコードする境界を一箇所に置き、サーバーから返る機械コードも保持する。
 */

import { useQuery } from "@tanstack/react-query";
import * as v from "valibot";

import { accessAwareFetch } from "./access";
import type { TransactionFilter } from "./transactions";
import type { EditCapabilities, EditChanges, EditPlan, EditSnapshot } from "../lib/edit";
import { editModeSchema, editPlanSchema } from "../../worker/src/edit-contract";

/** 単体編集計画の作成入力。 */
export interface SingleEditPlanInput {
  /** 作成元。 */
  source: "single";
  /** 利用者が確認した更新前の値。 */
  expected: EditSnapshot;
  /** 変更項目。 */
  changes: EditChanges;
}

/** フィルタ結果から一括編集計画を作る入力。 */
export interface FilterEditPlanInput {
  /** 作成元。 */
  source: "filter";
  /** API のクエリ文字列と同じ形の対象条件。 */
  filter: TransactionFilter;
  /** 全対象へ適用する変更項目。 */
  changes: EditChanges;
}

/** 編集計画の作成入力。 */
export type CreateEditPlanInput = SingleEditPlanInput | FilterEditPlanInput;

/** API が返すエラーを、画面の表示と再試行判定へ渡す例外。 */
export class EditApiError extends Error {
  /**
   * @param status HTTP ステータス。
   * @param code 機械判定用のエラーコード。
   * @param message 利用者へ出す説明。
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EditApiError";
  }
}

/** capability のレスポンスを通信境界で検証する。 */
const editCapabilitiesSchema = v.strictObject({
  enabled: v.boolean(),
  modes: v.array(editModeSchema),
  incomeName: v.boolean(),
  transfer: v.boolean(),
});

/** API エラーのレスポンスを通信境界で検証する。 */
const apiErrorSchema = v.object({
  error: v.object({ code: v.string(), message: v.string() }),
});

/**
 * 編集 API の JSON を取得する。
 *
 * @param path 相対 API パス。
 * @param init リクエスト設定。
 * @returns JSON 本体。
 * @throws {EditApiError} API がエラーを返したとき。
 */
async function requestJson<TSchema extends v.GenericSchema>(
  path: string,
  schema: TSchema,
  init?: RequestInit,
): Promise<v.InferOutput<TSchema>> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await accessAwareFetch(path, {
    ...init,
    headers,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = v.safeParse(apiErrorSchema, body);
    const code = parsed.success ? parsed.output.error.code : "unknown_error";
    const message = parsed.success
      ? parsed.output.error.message
      : `編集 API がエラーを返しました（${response.status}）`;
    throw new EditApiError(response.status, code, message);
  }
  return v.parse(schema, body);
}

/** 編集 capability を取得する。 */
export function getEditCapabilities(): Promise<EditCapabilities> {
  return requestJson("/api/edit-capabilities", editCapabilitiesSchema, { method: "GET" });
}

/** 編集計画を作成する。 */
export function createEditPlan(input: CreateEditPlanInput): Promise<EditPlan> {
  return requestJson("/api/edit-plans", editPlanSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 編集計画を ID で取得する。 */
export function getEditPlan(id: string): Promise<EditPlan> {
  return requestJson(`/api/edit-plans/${encodeURIComponent(id)}`, editPlanSchema, {
    method: "GET",
  });
}

/** 編集計画の対象 1 件を実行する。 */
export function executeEditPlan(id: string, transactionId: number): Promise<EditPlan> {
  return requestJson(`/api/edit-plans/${encodeURIComponent(id)}/execute`, editPlanSchema, {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId }),
  });
}

/** 結果不明の対象 1 件を再送せず照合する。 */
export function reconcileEditPlan(id: string, transactionId: number): Promise<EditPlan> {
  return requestJson(`/api/edit-plans/${encodeURIComponent(id)}/reconcile`, editPlanSchema, {
    method: "POST",
    body: JSON.stringify({ transaction_id: transactionId }),
  });
}

/** 編集 capability を TanStack Query で共有する。 */
export function useEditCapabilities() {
  return useQuery({
    queryKey: ["edit-capabilities"],
    queryFn: getEditCapabilities,
    staleTime: Infinity,
  });
}

/**
 * 編集計画を再読込する。
 *
 * active plan ID だけを sessionStorage に残し、明細データそのものは保存しない。
 * @param id 計画 ID。未指定ならクエリを発行しない。
 */
export function useEditPlan(id: string | null) {
  return useQuery({
    queryKey: ["edit-plan", id],
    queryFn: () => {
      if (id === null) throw new Error("編集計画 ID がありません");
      return getEditPlan(id);
    },
    enabled: id !== null,
    retry: false,
  });
}
