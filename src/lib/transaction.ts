/**
 * 明細を画面に出すための組み立て。
 *
 * 実データでは `name` と `place` の空きが多く（payment で 64% / 52%、
 * transfer ではほぼ全件）、逆に `comment` は 9 割の行に入っている。
 * どれか 1 つだけ埋まっている行が普通なので、素朴に「店舗名を出す」と
 * 空欄だらけの一覧になる。ここでフォールバックを一箇所に集める。
 */

import type { Transaction } from "../api/transactions";

/** 明細 1 件の表示テキスト。 */
export interface RowText {
  /** 主表示。店舗名・品名、無ければメモ、それも無ければ文脈。 */
  primary: string;
  /** 副表示。カテゴリ・ジャンル・口座。主表示に昇格したときは null。 */
  context: string | null;
  /** 補足。主表示に使わなかったメモ。 */
  note: string | null;
}

/** 主表示にも文脈にも出せるものが無いときの表示。 */
const EMPTY_LABEL = "（内容なし）";

/**
 * 空白だけの文字列を空と見なして整える。
 *
 * 実データのメモは `" #サブスクリプション"` のように先頭に空白が入る。
 *
 * @param value 元の値。
 * @returns 前後の空白を落とした文字列。中身が無ければ null。
 */
function clean(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * 明細の文脈（何に・どの口座で）を組み立てる。
 *
 * 振替はカテゴリを持たないので、口座の移動そのものが文脈になる。
 *
 * @param tx 明細。
 * @returns 文脈の文字列。組み立てられなければ null。
 */
function contextOf(tx: Transaction): string | null {
  if (tx.mode === "transfer") {
    return `${tx.from_account ?? "?"} → ${tx.to_account ?? "?"}`;
  }
  // 支出は出金元、収入は入金先に口座が入る
  const account = tx.mode === "income" ? tx.to_account : tx.from_account;
  const parts = [tx.category, tx.genre, account].map(clean).filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * 明細の表示テキストを組み立てる。
 *
 * @param tx 明細。
 * @returns 主表示・文脈・補足。
 */
export function rowText(tx: Transaction): RowText {
  const context = contextOf(tx);
  const comment = clean(tx.comment);

  // 店舗名と品名は「Microsoft の Azure」のように両方が意味を持つので、
  // 揃っていれば両方出す
  const label = [tx.place, tx.name]
    .map(clean)
    .filter((part) => part !== null)
    .join(" / ");

  if (label) return { primary: label, context, note: comment };
  if (comment) return { primary: comment, context, note: null };
  // 家賃の繰り返し登録のように 3 つとも空の行がある。
  // 文脈しか無いなら、それを主表示に上げて空行を作らない
  return { primary: context ?? EMPTY_LABEL, context: null, note: null };
}

/** 同じ日付の明細のまとまり。 */
export interface DateGroup {
  /** `YYYY-MM-DD` 形式の日付。 */
  date: string;
  /** その日の明細。API の並び順を保つ。 */
  items: Transaction[];
}

/**
 * 明細を日付ごとにまとめる。
 *
 * API は日付の降順で返し、同じ日に 5 件並ぶことも珍しくない。
 * 行ごとに日付を繰り返すより見出しでまとめた方が読める。
 *
 * ページをまたいで同じ日付が続くことがあるため、全ページを連結してから
 * 呼ぶこと。ページ単位でまとめると境界で見出しが二重に出る。
 *
 * @param items 日付の降順に並んだ明細。
 * @returns 日付ごとのまとまり。入力の順序を保つ。
 */
export function groupByDate(items: Transaction[]): DateGroup[] {
  const groups: DateGroup[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last?.date === item.date) {
      last.items.push(item);
    } else {
      groups.push({ date: item.date, items: [item] });
    }
  }
  return groups;
}
