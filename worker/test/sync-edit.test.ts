/** 同期とミラー反映の排他、および未照合編集計画との連携を検証する。 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireMutation,
  getMutation,
  initializeOperations,
  insertEditPlan,
} from "../src/edit-store";
import { replaceMirrorMoney } from "../src/mirror-write";
import { seedDatabase } from "./fixtures";
import { syncAll } from "../src/sync";
import { ZaimClient, type ZaimMaster, type ZaimMoney } from "../src/zaim";

const CREDENTIALS = {
  consumerKey: "consumer-key",
  consumerSecret: "consumer-secret",
  accessToken: "access-token",
  accessTokenSecret: "access-token-secret",
};

/** 非同期処理をテスト中だけ再開するための待機値。 */
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/** 非同期処理をテスト中だけ一時停止・再開するための待機値を作る。 */
function deferred(): Deferred {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolver = done;
  });
  return { promise, resolve: () => resolver?.() };
}

/** 外部の Zaim API を呼ばず、同期へ固定データを返すクライアント。 */
class StubClient extends ZaimClient {
  readonly money: ZaimMoney[];
  readonly iterStarted: Promise<void>;
  verifyCallCount = 0;
  failVerify = false;
  #markIterStarted: () => void = () => {};
  readonly #waitForMoney: Promise<void> | undefined;

  /**
   * @param money 同期で返す明細。
   * @param waitForMoney 明細取得を一時停止する待機。排他範囲の検証に使う。
   */
  constructor(money: ZaimMoney[] = [], waitForMoney?: Promise<void>) {
    super(CREDENTIALS, async () => Response.json({}));
    this.money = money;
    this.#waitForMoney = waitForMoney;
    this.iterStarted = new Promise<void>((resolve) => {
      this.#markIterStarted = resolve;
    });
  }

  /** 認証確認を記録し、必要なら同期を失敗させる。 */
  override async verify(): Promise<Record<string, unknown>> {
    this.verifyCallCount += 1;
    if (this.failVerify) throw new Error("意図した認証失敗");
    return {};
  }

  /** 固定の空カテゴリを返す。 */
  override async categories(): Promise<ZaimMaster[]> {
    return [];
  }

  /** 固定の空ジャンルを返す。 */
  override async genres(): Promise<ZaimMaster[]> {
    return [];
  }

  /** 固定の空口座を返す。 */
  override async accounts(): Promise<ZaimMaster[]> {
    return [];
  }

  /** 固定の明細を 1 ページで返す。 */
  override async *iterMoney(): AsyncGenerator<ZaimMoney[]> {
    this.#markIterStarted();
    if (this.#waitForMoney) await this.#waitForMoney;
    if (this.money.length > 0) yield this.money;
  }
}

beforeEach(async () => {
  await initializeOperations(env.DB);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mutation_gate"),
    env.DB.prepare("DELETE FROM edit_plans"),
  ]);
});

describe("replaceMirrorMoney", () => {
  it("通常列と raw を同時に upsert し、同期時刻を変更しない", async () => {
    await seedDatabase(env.DB);
    const before = await env.DB.prepare(
      "SELECT value FROM sync_meta WHERE key = 'synced_at'",
    ).first<{ value: string }>();
    const money: ZaimMoney = {
      id: 1,
      mode: "payment",
      date: "2026-08-02",
      amount: 9999,
      category_id: 102,
      genre_id: 1003,
      from_account_id: 11,
      name: "変更後の明細",
      place: "更新された店",
      comment: "更新メモ",
      currency_code: "JPY",
      receipt_id: 4_200_000_001,
      active: 1,
      created: "2026-08-02 10:00:00",
      place_uid: "place-1",
    };

    await replaceMirrorMoney(env.DB, money);

    const row = await env.DB.prepare(
      "SELECT id, mode, date, amount, category_id, genre_id, from_account_id, to_account_id, name, place, comment, currency_code, receipt_id, active, created, raw FROM transactions WHERE id = 1",
    ).first();
    expect(row).toMatchObject({
      id: 1,
      mode: "payment",
      date: "2026-08-02",
      amount: 9999,
      category_id: 102,
      genre_id: 1003,
      from_account_id: 11,
      name: "変更後の明細",
      place: "更新された店",
      comment: "更新メモ",
      currency_code: "JPY",
      receipt_id: 4_200_000_001,
      active: 1,
      created: "2026-08-02 10:00:00",
    });
    expect(JSON.parse(String(row?.raw))).toEqual(money);
    await expect(
      env.DB.prepare("SELECT value FROM sync_meta WHERE key = 'synced_at'").first(),
    ).resolves.toEqual(before);
  });

  it("ミラーに存在しない ID も追加する", async () => {
    await seedDatabase(env.DB);
    const money: ZaimMoney = {
      id: 99,
      mode: "income",
      date: "2026-08-03",
      amount: 5000,
    };

    await replaceMirrorMoney(env.DB, money);

    await expect(
      env.DB.prepare("SELECT id, mode, amount, raw FROM transactions WHERE id = 99").first(),
    ).resolves.toMatchObject({ id: 99, mode: "income", amount: 5000, raw: JSON.stringify(money) });
  });
});

describe("syncAll と共有ゲート", () => {
  it("同期が成功するとゲートを所有者付きで解放する", async () => {
    const client = new StubClient([{ id: 99, mode: "income", date: "2026-08-03", amount: 5000 }]);

    await expect(syncAll(env.DB, client)).resolves.toMatchObject({
      counts: { transactions: 1, categories: 0, genres: 0, accounts: 0 },
    });
    expect(client.verifyCallCount).toBe(1);
    await expect(getMutation(env.DB)).resolves.toBeNull();
  });

  it("同期中の別処理がゲートを取得できない", async () => {
    await expect(acquireMutation(env.DB, "edit-owner", "edit")).resolves.toBe(true);

    const client = new StubClient([{ id: 99, mode: "income", date: "2026-08-03", amount: 5000 }]);
    await expect(syncAll(env.DB, client)).rejects.toThrow(/処理中|ゲート|排他/);
    expect(client.verifyCallCount).toBe(0);
  });

  it("明細取得から差し替え完了まで同期がゲートを保持する", async () => {
    const waitForMoney = deferred();
    const client = new StubClient(
      [{ id: 99, mode: "income", date: "2026-08-03", amount: 5000 }],
      waitForMoney.promise,
    );
    const running = syncAll(env.DB, client);

    await client.iterStarted;
    await expect(getMutation(env.DB)).resolves.toMatchObject({ kind: "sync" });
    await expect(acquireMutation(env.DB, "edit-owner", "edit")).resolves.toBe(false);

    waitForMoney.resolve();
    await expect(running).resolves.toMatchObject({ counts: { transactions: 1 } });
    await expect(getMutation(env.DB)).resolves.toBeNull();
  });

  it("認証確認で失敗してもゲートを解放する", async () => {
    const client = new StubClient([{ id: 99, mode: "income", date: "2026-08-03", amount: 5000 }]);
    client.failVerify = true;

    await expect(syncAll(env.DB, client)).rejects.toThrow("意図した認証失敗");
    await expect(getMutation(env.DB)).resolves.toBeNull();
  });

  it.each(["sending", "unknown", "mirror_pending"] as const)(
    "未解決の編集計画 status=%s があると同期を保留する",
    async (status) => {
      await insertEditPlan(
        env.DB,
        `plan-${status}`,
        JSON.stringify({ items: [{ id: 1, status }] }),
        "2000-01-01T00:00:00.000Z",
      );
      const client = new StubClient([{ id: 99, mode: "income", date: "2026-08-03", amount: 5000 }]);

      await expect(syncAll(env.DB, client)).rejects.toThrow(/編集計画|未解決|同期/);
      expect(client.verifyCallCount).toBe(0);
      await expect(getMutation(env.DB)).resolves.toBeNull();
    },
  );
});
