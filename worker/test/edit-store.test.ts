/** 編集計画と同期・編集の共有ゲートを公開境界から検証する。 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireMutation,
  getMutation,
  initializeOperations,
  insertEditPlan,
  readEditPlan,
  releaseMutation,
  saveEditPlan,
} from "../src/edit-store";

beforeEach(async () => {
  await initializeOperations(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mutation_gate"),
    env.DB.prepare("DELETE FROM edit_plans"),
  ]);
});

describe("mutation_gate", () => {
  it("同時に取得を試みても 1 件だけが所有者になる", async () => {
    const results = await Promise.all([
      acquireMutation(env.DB, "owner-a", "edit"),
      acquireMutation(env.DB, "owner-b", "sync"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const owner = results[0] ? "owner-a" : "owner-b";
    const kind = results[0] ? "edit" : "sync";
    expect(await getMutation(env.DB)).toMatchObject({ owner, kind });
  });

  it("所有者以外の解放ではゲートを残し、所有者の解放で消す", async () => {
    await expect(acquireMutation(env.DB, "owner", "edit")).resolves.toBe(true);

    await releaseMutation(env.DB, "other-owner");
    expect(await getMutation(env.DB)).toMatchObject({ owner: "owner", kind: "edit" });

    await releaseMutation(env.DB, "owner");
    await expect(getMutation(env.DB)).resolves.toBeNull();
  });

  it("開始時刻が古くても既存所有者を自動で置き換えない", async () => {
    await expect(acquireMutation(env.DB, "stale-owner", "sync")).resolves.toBe(true);
    await env.DB.prepare("UPDATE mutation_gate SET started_at = ? WHERE slot = 1")
      .bind("2000-01-01T00:00:00.000Z")
      .run();

    await expect(acquireMutation(env.DB, "new-owner", "edit")).resolves.toBe(false);
    await expect(getMutation(env.DB)).resolves.toMatchObject({
      owner: "stale-owner",
      kind: "sync",
    });
  });
});

describe("edit_plans", () => {
  it("計画を保存して読み取り、ゲート下で更新できる", async () => {
    const original = JSON.stringify({ items: [{ id: 1, status: "sending" }] });
    const updated = JSON.stringify({ items: [{ id: 1, status: "mirror_pending" }] });

    await insertEditPlan(env.DB, "plan-1", original, "2099-01-01T00:00:00.000Z");
    await expect(readEditPlan(env.DB, "plan-1")).resolves.toBe(original);
    await expect(readEditPlan(env.DB, "missing")).resolves.toBeNull();

    await saveEditPlan(env.DB, "plan-1", updated);
    await expect(readEditPlan(env.DB, "plan-1")).resolves.toBe(updated);
  });

  it("初期化は操作テーブルを作る", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mutation_gate', 'edit_plans') ORDER BY name",
    ).all<{ name: string }>();

    expect(results.map(({ name }) => name)).toEqual(["edit_plans", "mutation_gate"]);
  });
});
