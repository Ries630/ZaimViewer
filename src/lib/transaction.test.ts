import { describe, expect, it } from "vitest";

import type { Transaction } from "../api/transactions";
import { commentSegments, detailFields, groupByDate, modeLabel, rowText } from "./transaction";

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

  it("振替の文脈は口座の移動", () => {
    const text = rowText(
      transaction({ mode: "transfer", from_account: "MetaMask", to_account: "Grvt" }),
    );
    expect(text.primary).toBe("MetaMask → Grvt");
    expect(text.context).toBeNull();
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

describe("modeLabel", () => {
  it("三つの種別を日本語にする", () => {
    expect([modeLabel("payment"), modeLabel("income"), modeLabel("transfer")]).toEqual([
      "支出",
      "収入",
      "振替",
    ]);
  });

  it("知らない種別はそのまま返す", () => {
    // Zaim が種別を増やしても、空欄になるより原文が見えた方が手がかりになる
    expect(modeLabel("unknown")).toBe("unknown");
  });
});

describe("detailFields", () => {
  it("店舗・品名・メモを畳まずに別々の項目として出す", () => {
    // 一覧では "Microsoft / Azure" に畳んでメモを補足へ回すが、
    // 詳細ではどれがどの項目か分かる形で出す
    const fields = detailFields(
      transaction({ place: "Microsoft", name: "Azure", comment: " #サブスクリプション" }),
    );
    expect(fields).toEqual([
      { key: "place", label: "店舗", value: "Microsoft" },
      { key: "name", label: "品名", value: "Azure" },
      { key: "comment", label: "メモ", value: "#サブスクリプション" },
    ]);
  });

  it("種別は含めない（見出しのバッジで出すため）", () => {
    expect(detailFields(transaction()).map((field) => field.key)).toEqual([]);
  });

  it("空の項目は落とす", () => {
    const fields = detailFields(transaction({ place: "いなほクリニック" }));
    expect(fields.map((field) => field.key)).toEqual(["place"]);
  });

  it("支出には出金元だけが出る", () => {
    const fields = detailFields(
      transaction({ category: "Medical", genre: "Prescription", from_account: "Triaカード残高" }),
    );
    expect(fields.map((field) => field.key)).toEqual(["category", "genre", "from_account"]);
  });

  it("収入には入金先だけが出る", () => {
    const fields = detailFields(
      transaction({ mode: "income", category: "Salary", to_account: "みんなの銀行" }),
    );
    expect(fields).toEqual([
      { key: "category", label: "カテゴリ", value: "Salary" },
      { key: "to_account", label: "入金先", value: "みんなの銀行" },
    ]);
  });

  it("振替には口座が両方出る", () => {
    const fields = detailFields(
      transaction({ mode: "transfer", from_account: "MetaMask", to_account: "Grvt" }),
    );
    expect(fields).toEqual([
      { key: "from_account", label: "出金元", value: "MetaMask" },
      { key: "to_account", label: "入金先", value: "Grvt" },
    ]);
  });
});

describe("commentSegments", () => {
  it("タグだけのメモは 1 つのタグになる", () => {
    expect(commentSegments("#サブスクリプション")).toEqual([
      { text: "#サブスクリプション", tag: true },
    ]);
  });

  it("平文のあとのタグを切り分ける", () => {
    expect(commentSegments("キャンペーン #サブスクリプション試用")).toEqual([
      { text: "キャンペーン ", tag: false },
      { text: "#サブスクリプション試用", tag: true },
    ]);
  });

  it("タグが複数続いても切り分ける", () => {
    // 実データにこの形がある（MUFG からの自動連携）
    expect(commentSegments("RTK LINE PAY 31-03-31 #MUFG取込 #振替変換待ち")).toEqual([
      { text: "RTK LINE PAY 31-03-31 ", tag: false },
      { text: "#MUFG取込", tag: true },
      { text: " ", tag: false },
      { text: "#振替変換待ち", tag: true },
    ]);
  });

  it("タグが無ければ平文ひとつになる", () => {
    expect(commentSegments("代理購入 ことら送金")).toEqual([
      { text: "代理購入 ことら送金", tag: false },
    ]);
  });

  it("タグのあとに平文が続く形も切り分ける", () => {
    expect(commentSegments("#MUFG取込 のぶん")).toEqual([
      { text: "#MUFG取込", tag: true },
      { text: " のぶん", tag: false },
    ]);
  });

  it("空なら空を返す", () => {
    expect(commentSegments("")).toEqual([]);
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
