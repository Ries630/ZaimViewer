import { describe, expect, it } from "vitest";

import type { Transaction } from "../api/transactions";
import { groupByDate, rowText, shortAccountName } from "./transaction";

/**
 * 明細を組み立てる。
 *
 * 空文字が既定なのは実データに合わせるため。Zaim は未入力の項目を
 * NULL ではなく空文字で返す。
 *
 * @param overrides 上書きする項目。
 * @returns 明細。
 */
function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    mode: "payment",
    date: "2026-08-08",
    amount: 1000,
    category_id: null,
    category: null,
    genre_id: null,
    genre: null,
    from_account_id: null,
    from_account: null,
    to_account_id: null,
    to_account: null,
    name: "",
    place: "",
    comment: "",
    currency_code: "JPY",
    ...overrides,
  };
}

describe("rowText", () => {
  it("店舗名と品名が揃っていれば両方出す", () => {
    const text = rowText(
      transaction({ place: "Microsoft", name: "Azure", category: "Phone, Net" }),
    );
    expect(text.primary).toBe("Microsoft / Azure");
  });

  it("店舗名だけでも主表示になる", () => {
    expect(rowText(transaction({ place: "いなほクリニック" })).primary).toBe("いなほクリニック");
  });

  it("店舗名も品名も無ければメモを主表示に上げる", () => {
    const text = rowText(transaction({ comment: "懇親会", category: "Socializing" }));
    expect(text.primary).toBe("懇親会");
    expect(text.note).toBeNull();
  });

  it("メモの前後の空白を落とす", () => {
    // 実データのメモは " #サブスクリプション" のように空白で始まる
    expect(rowText(transaction({ comment: " #サブスクリプション" })).primary).toBe(
      "#サブスクリプション",
    );
  });

  it("主表示に使わなかったメモは補足に残す", () => {
    const text = rowText(transaction({ place: "pixivFANBOX", comment: " #サブスクリプション" }));
    expect(text.primary).toBe("pixivFANBOX");
    expect(text.note).toBe("#サブスクリプション");
  });

  it("支出の文脈はカテゴリ・ジャンル・出金元", () => {
    const text = rowText(
      transaction({
        place: "フラワー薬局",
        category: "Medical",
        genre: "Prescription",
        from_account: "Triaカード残高",
        to_account: "使わない方",
      }),
    );
    expect(text.context).toBe("Medical · Prescription · Triaカード残高");
  });

  it("収入の文脈には入金先が入る", () => {
    const text = rowText(
      transaction({
        mode: "income",
        place: "給与",
        category: "Salary",
        from_account: "使わない方",
        to_account: "みんなの銀行",
      }),
    );
    expect(text.context).toBe("Salary · みんなの銀行");
  });

  it("振替は口座の移動が主表示になる", () => {
    const text = rowText(
      transaction({ mode: "transfer", from_account: "MetaMask", to_account: "Grvt" }),
    );
    expect(text).toEqual({ primary: "MetaMask → Grvt", context: null, note: null });
  });

  it("振替はメモがあっても口座の移動が主表示のまま", () => {
    // メモに主表示を譲ると、メモの有無で口座が 1 行目と 2 行目を行き来する。
    // 実データの振替のメモはほぼ全件が取り込み元のタグで、譲る相手ではない（#34）
    const text = rowText(
      transaction({
        mode: "transfer",
        from_account: "MetaMask",
        to_account: "Triaカード残高",
        comment: "RTK ﾍﾟｲﾍﾟｲ #MUFG取込",
      }),
    );
    expect(text).toEqual({
      primary: "MetaMask → Triaカード残高",
      context: null,
      note: "RTK ﾍﾟｲﾍﾟｲ #MUFG取込",
    });
  });

  it("振替の店舗名・品名は文脈に回る", () => {
    // 実データでは 41 件が持っており、口座名と重複するか補足的な内容だった
    const text = rowText(
      transaction({
        mode: "transfer",
        place: "Amazon.co.jp",
        name: "Amazonギフトカード チャージタイプ",
        from_account: "みんなの銀行",
        to_account: "Amazonギフト券",
      }),
    );
    expect(text).toEqual({
      primary: "みんなの銀行 → Amazonギフト券",
      context: "Amazon.co.jp / Amazonギフトカード チャージタイプ",
      note: null,
    });
  });

  it("振替は口座名が引けなくても主表示を空にしない", () => {
    const text = rowText(transaction({ mode: "transfer" }));
    expect(text.primary).toBe("? → ?");
  });

  it("振替の口座名は短縮して出す", () => {
    const text = rowText(
      transaction({
        mode: "transfer",
        from_account: "三菱 UFJ 銀行 守山支店 普通 ****430",
        to_account: "みんなの銀行",
      }),
    );
    expect(text.primary).toBe("三菱 UFJ 銀行 → みんなの銀行");
  });

  it("短縮すると同名になる口座どうしの振替は正式名に戻す", () => {
    // ゆうちょ銀行 三一八店の「総合」と「定額定期」がこの形。
    // 「ゆうちょ銀行 → ゆうちょ銀行」では何も言っていないことになる
    const text = rowText(
      transaction({
        mode: "transfer",
        from_account: "ゆうちょ銀行 三一八店 総合 ****350",
        to_account: "ゆうちょ銀行 三一八店 定額定期 ****350",
      }),
    );
    expect(text.primary).toBe(
      "ゆうちょ銀行 三一八店 総合 ****350 → ゆうちょ銀行 三一八店 定額定期 ****350",
    );
  });

  it("支出の文脈でも口座名を短縮する", () => {
    // 振替と規則が違うと、同じ口座が行によって違う名前で出る
    const text = rowText(
      transaction({
        place: "フラワー薬局",
        category: "Medical",
        from_account: "三菱 UFJ 銀行 守山支店 普通 ****430",
      }),
    );
    expect(text.context).toBe("Medical · 三菱 UFJ 銀行");
  });

  it("三つとも空なら文脈を主表示に上げる", () => {
    // 繰り返し登録の家賃がこの形で入っている
    const text = rowText(
      transaction({ category: "Housing", genre: "Rent", from_account: "みんなの銀行" }),
    );
    expect(text.primary).toBe("Housing · Rent · みんなの銀行");
    expect(text.context).toBeNull();
  });

  it("手がかりが何も無ければ内容なしと出す", () => {
    expect(rowText(transaction()).primary).toBe("（内容なし）");
  });
});

describe("shortAccountName", () => {
  it("支店・種別・番号を落として銀行名まで縮める", () => {
    expect(shortAccountName("三菱 UFJ 銀行 守山支店 普通 ****430")).toBe("三菱 UFJ 銀行");
    expect(shortAccountName("三井住友銀行 オリーブECRU支店 残高別普通 *****725")).toBe(
      "三井住友銀行",
    );
  });

  it("銀行名に含まれる空白で切らない", () => {
    // 先頭から取る方式にすると「三菱」になってしまう
    expect(shortAccountName("三菱 UFJ 銀行 守山支店 普通 ****430")).not.toBe("三菱");
  });

  it("ニックネームの口座は素通りさせる", () => {
    // 本番の口座 36 件のうち 32 件がこちらに当たる
    for (const name of [
      "Triaカード残高",
      "三井住友カード Olive",
      "Amazon ギフトカード",
      "通勤用のモバイルTOICA定期券",
      "Amazon Mastercard Amazonマスター",
      "現金",
    ]) {
      expect(shortAccountName(name)).toBe(name);
    }
  });

  it("落とし切って空にはしない", () => {
    // 実データには無いが、規則が全部当たっても名前は残す
    expect(shortAccountName("普通 ****430")).toBe("普通");
  });

  it("知らない形式には何もしない", () => {
    expect(shortAccountName("よく分からない 口座 名前")).toBe("よく分からない 口座 名前");
  });

  it("伏字の番号で終わらない名前には、店で終わっても触れない", () => {
    // 番号を門にしているのはこのため。誤爆（間違った短縮）は騙されるまで
    // 気付けないが、未適用（長いまま出る）は見れば分かる
    expect(shortAccountName("お土産 山田商店")).toBe("お土産 山田商店");
    expect(shortAccountName("へそくり 普通")).toBe("へそくり 普通");
  });

  it("素の数字は伏字の番号と見なさない", () => {
    expect(shortAccountName("サブ口座 2")).toBe("サブ口座 2");
  });

  it("アスタリスクだけ・1 個だけのトークンは伏字の番号と見なさない", () => {
    // 実データの伏字は 4〜5 個 + 3 桁。3 個以上 + 数字必須まで締めてある
    expect(shortAccountName("メモ ***")).toBe("メモ ***");
    expect(shortAccountName("MetaMask *2")).toBe("MetaMask *2");
  });
});

describe("groupByDate", () => {
  it("同じ日付をまとめる", () => {
    const groups = groupByDate([
      transaction({ id: 1, date: "2026-08-08" }),
      transaction({ id: 2, date: "2026-08-08" }),
      transaction({ id: 3, date: "2026-08-07" }),
    ]);
    expect(groups.map((group) => group.date)).toEqual(["2026-08-08", "2026-08-07"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([1, 2]);
  });

  it("並び順を保つ", () => {
    const groups = groupByDate([
      transaction({ id: 1, date: "2026-08-08" }),
      transaction({ id: 2, date: "2026-08-07" }),
      transaction({ id: 3, date: "2026-08-08" }),
    ]);
    // 日付が飛び飛びなら見出しも分かれる。API は降順で返すので実際には起きないが、
    // 並べ替えずに素通しすることを固定しておく
    expect(groups.map((group) => group.date)).toEqual(["2026-08-08", "2026-08-07", "2026-08-08"]);
  });

  it("空なら空を返す", () => {
    expect(groupByDate([])).toEqual([]);
  });
});
