/** 同期と編集が共有する処理ゲート、および編集計画の D1 永続化。 */

import type { Database } from "./db";

/** 処理ゲートを所有する処理の種別。 */
export type MutationKind = "sync" | "edit" | "plan" | "reconcile";

/** 処理管理テーブルを作る。既存のミラー表には触れない。 */
export async function initializeOperations(db: Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS mutation_gate (
        slot       INTEGER PRIMARY KEY CHECK (slot = 1),
        owner      TEXT NOT NULL,
        kind       TEXT NOT NULL,
        started_at TEXT NOT NULL
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS edit_plans (
        id         TEXT PRIMARY KEY,
        payload    TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    ),
  ]);
}

/**
 * 処理ゲートを条件付きで取得する。
 *
 * 期限切れを理由に既存所有者を置き換えない。INSERT と競合判定を 1 文に
 * 閉じることで、Worker と D1 HTTP クライアントのどちらからも原子的に取得する。
 *
 * @param db ミラー DB。
 * @param owner 処理を識別する所有者 ID。
 * @param kind 処理の種別。
 * @returns ゲートを取得できたか。
 */
export async function acquireMutation(
  db: Database,
  owner: string,
  kind: MutationKind,
): Promise<boolean> {
  await initializeOperations(db);
  const row = await db
    .prepare(
      `INSERT INTO mutation_gate (slot, owner, kind, started_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(slot) DO NOTHING
       RETURNING slot`,
    )
    .bind(owner, kind, new Date().toISOString())
    .first<{ slot: number }>();
  return row !== null;
}

/** 現在のゲート所有者を取得する。 */
export async function getMutation(
  db: Database,
): Promise<{ owner: string; kind: string; started_at: string } | null> {
  return await db
    .prepare("SELECT owner, kind, started_at FROM mutation_gate WHERE slot = 1")
    .first<{ owner: string; kind: string; started_at: string }>();
}

/** 所有者 ID が一致する場合だけゲートを解放する。 */
export async function releaseMutation(db: Database, owner: string): Promise<void> {
  await db.prepare("DELETE FROM mutation_gate WHERE slot = 1 AND owner = ?").bind(owner).run();
}

/** 編集計画を新規保存する。既存 ID の上書きは行わない。 */
export async function insertEditPlan(
  db: Database,
  id: string,
  payload: string,
  expiresAt: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO edit_plans (id, payload, expires_at) VALUES (?, ?, ?)")
    .bind(id, payload, expiresAt)
    .run();
}

/** 編集計画の payload を取得する。期限だけを理由に削除しない。 */
export async function readEditPlan(db: Database, id: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT payload FROM edit_plans WHERE id = ?")
    .bind(id)
    .first<{ payload: string }>();
  return row?.payload ?? null;
}

/** ゲート下で編集計画の payload を更新する。 */
export async function saveEditPlan(db: Database, id: string, payload: string): Promise<void> {
  await db.prepare("UPDATE edit_plans SET payload = ? WHERE id = ?").bind(payload, id).run();
}
