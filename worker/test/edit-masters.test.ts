/** 編集欄のマスタ選択肢を組み立てる純関数のテスト。 */

import { expect, it } from "vitest";

import { editMasterOptions } from "../../src/lib/edit-masters";

it("有効なマスタだけを編集先にし、削除済みの現在値は disabled で残す", () => {
  const options = [
    { id: 1, name: "有効", active: 1 },
    { id: 2, name: "削除済み", active: -1 },
    { id: 3, name: "状態不明", active: null },
  ];

  expect(editMasterOptions(options, 2)).toEqual([options[0], { ...options[1], disabled: true }]);
  expect(editMasterOptions(options, null)).toEqual([options[0]]);
});

it("active が null の現在値も表示だけを許可する", () => {
  const current = { id: 10, name: "現在の口座", active: null };
  const other = { id: 11, name: "有効な口座", active: 1 };

  expect(editMasterOptions([current, other], current.id)).toEqual([
    { ...current, disabled: true },
    other,
  ]);
});
