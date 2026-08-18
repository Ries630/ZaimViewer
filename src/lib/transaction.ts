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

/** 詳細に出す項目の識別子。表示の出し分けに使う。 */
export type DetailFieldKey =
  | "place"
  | "name"
  | "comment"
  | "category"
  | "genre"
  | "from_account"
  | "to_account";

/** 詳細に出す項目 1 つ。 */
export interface DetailField {
  /** どの項目か。メモだけタグを切り分けて出すので、ラベル文字列では判定しない。 */
  key: DetailFieldKey;
  /** 項目名。 */
  label: string;
  /** 値。空の項目は組み立ての時点で落とすので、必ず中身がある。 */
  value: string;
}

/** 種別の表示名。Zaim が返す `mode` をそのまま出すと英語だけが並ぶ。 */
const MODE_LABELS: Record<string, string> = {
  payment: "支出",
  income: "収入",
  transfer: "振替",
};

/**
 * 種別の表示名を返す。
 *
 * 知らない種別はそのまま返す。Zaim が種別を増やしたとき、空欄になるより
 * 原文が見えた方が手がかりになる。
 *
 * @param mode Zaim の `mode`。
 * @returns 表示名。
 */
export function modeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

/**
 * 明細の詳細に出す項目を組み立てる。
 *
 * 一覧の `rowText` と違い、フォールバックも省略もしない。切れた主表示の
 * 全文を読むのがこの表示の目的なので、店舗・品名・メモを畳まず別々に出す。
 *
 * 項目は Zaim の更新 API が受け付けるものに合わせてある。工程 ③ でこの表示が
 * 編集フォームになったとき、読める項目と直せる項目がずれないようにするため。
 * ただし日付・金額・種別はここには含めない。値が 1 つに定まる（自由入力でない）
 * ぶん見出しで出した方が読めるので、シート側が扱う。
 *
 * 口座は種別で分岐しない。実データでは支出に出金元だけ、収入に入金先だけ、
 * 振替に両方が入っており、関係の無い側は必ず空になる（本番の全 4,370 件で確認）。
 *
 * @param tx 明細。
 * @returns 中身のある項目だけを、表示順に並べたもの。
 */
export function detailFields(tx: Transaction): DetailField[] {
  const candidates: [DetailFieldKey, string, string | null][] = [
    // 切れて読めなかったのはこの 3 つなので先に置く
    ["place", "店舗", tx.place],
    ["name", "品名", tx.name],
    ["comment", "メモ", tx.comment],
    ["category", "カテゴリ", tx.category],
    ["genre", "ジャンル", tx.genre],
    ["from_account", "出金元", tx.from_account],
    ["to_account", "入金先", tx.to_account],
  ];

  return candidates.flatMap(([key, label, value]) => {
    const cleaned = clean(value);
    return cleaned === null ? [] : [{ key, label, value: cleaned }];
  });
}

/** メモを平文とタグに切り分けた一片。 */
export interface CommentSegment {
  /** 表示する文字列。タグなら先頭の `#` を含む。 */
  text: string;
  /** タグか。 */
  tag: boolean;
}

/**
 * タグ。`#` から空白までを 1 つと見なす。
 *
 * 実データのタグはすべて ASCII の `#` で、全角の `＃` は 0 件だった
 * （メモのある 3,959 件のうち 3,877 件がタグを含む）。`\S` は全角空白も
 * 区切りとして扱う。
 */
const TAG_PATTERN = /#\S+/g;

/**
 * メモを平文とタグに切り分ける。
 *
 * `RTK LINE PAY 31-03-31 #MUFG取込 #振替変換待ち` のように、平文のあとに
 * タグが複数続く形が実データにある。タグは自動連携の出どころや処理待ちを
 * 表しており、平文と同じ見た目だと埋もれる。
 *
 * 空白は平文の側に残す。タグの前後の間隔を表示側で作り直さずに済ませるため。
 *
 * @param comment メモ。
 * @returns 出現順に並べた一片。メモが空なら空配列。
 */
export function commentSegments(comment: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let index = 0;

  for (const match of comment.matchAll(TAG_PATTERN)) {
    if (match.index > index) {
      segments.push({ text: comment.slice(index, match.index), tag: false });
    }
    segments.push({ text: match[0], tag: true });
    index = match.index + match[0].length;
  }

  if (index < comment.length) {
    segments.push({ text: comment.slice(index), tag: false });
  }
  return segments;
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
