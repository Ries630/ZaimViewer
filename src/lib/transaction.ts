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
  /** 主表示。店舗名・品名、無ければメモ、それも無ければ文脈。振替は口座の移動で固定。 */
  primary: string;
  /** 副表示。カテゴリ・ジャンル・口座。振替では店舗名・品名。無ければ null。 */
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
 * 口座名の末尾に付く種別。
 *
 * 銀行の口座名は Zaim 側で「<銀行> <支店> <種別> <番号>」の並びになる。
 * ここに無い種別は知らないものとして扱い、短縮せずそのまま出す。
 */
const ACCOUNT_TYPES = new Set(["普通", "総合", "当座", "貯蓄", "定期", "定額定期", "残高別普通"]);

/** 伏字の口座番号（`****430`、`*****725`）。 */
const MASKED_NUMBER = /^\*+\d*$/;

/**
 * 口座名を一覧向けに短縮する。
 *
 * 一覧で見たいのは銀行名までで、支店・種別・番号は場所を食うだけになる。
 * 本番の口座 36 件のうち、この規則が実際に効くのは銀行口座の 4 件だけで、
 * 残りはニックネーム（`Triaカード残高`、`三井住友カード Olive`）なので素通りする。
 *
 * **末尾から順に落とす。** 先頭から取る方式にすると `三菱 UFJ 銀行` が
 * `三菱` になってしまう（銀行名自体が空白を含む）。
 *
 * 短縮の結果が空にならないよう、トークンは必ず 1 つ残す。知らない形式の
 * 名前には何もしないので、規則が当たらなくても現状表示に倒れるだけで済む。
 *
 * @param name 口座名。
 * @returns 短縮した口座名。
 */
export function shortAccountName(name: string): string {
  const tokens = name.split(/\s+/).filter((token) => token !== "");

  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1] ?? "";
    // 番号 → 種別 → 支店 の順に現れるので、末尾から剥がすと銀行名が残る
    const droppable = MASKED_NUMBER.test(last) || ACCOUNT_TYPES.has(last) || last.endsWith("店");
    if (!droppable) break;
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * 振替の口座の移動を組み立てる。
 *
 * 振替はカテゴリもジャンルも持たないので、これが明細の中身そのものになる。
 * 口座名が引けなくても穴を空けず `?` を置く。片側だけ消えた振替は
 * 「どこかへ移した」という情報自体が残らないと読めないため。
 *
 * @param tx 振替の明細。
 * @returns 「A → B」の文字列。
 */
function accountMovement(tx: Transaction): string {
  const from = tx.from_account ?? "?";
  const to = tx.to_account ?? "?";
  const shortFrom = shortAccountName(from);
  const shortTo = shortAccountName(to);

  // 短縮すると同名になる口座がある（ゆうちょ銀行 三一八店の「総合」と「定額定期」）。
  // 「A → A」は何も言っていないので、その組み合わせのときだけ正式名に戻す
  return shortFrom === shortTo ? `${from} → ${to}` : `${shortFrom} → ${shortTo}`;
}

/**
 * 明細の文脈（何に・どの口座で）を組み立てる。
 *
 * 振替は `rowText` が先に処理するのでここには来ない。口座の移動は
 * 文脈ではなく主表示になる（`accountMovement`）。
 *
 * 口座名は `shortAccountName` で短縮する。振替の主表示と同じ規則にしないと、
 * 同じ口座が行によって違う名前で出る。
 *
 * @param tx 支出または収入の明細。
 * @returns 文脈の文字列。組み立てられなければ null。
 */
function contextOf(tx: Transaction): string | null {
  // 支出は出金元、収入は入金先に口座が入る
  const account = clean(tx.mode === "income" ? tx.to_account : tx.from_account);
  const parts = [
    clean(tx.category),
    clean(tx.genre),
    account === null ? null : shortAccountName(account),
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * 明細の表示テキストを組み立てる。
 *
 * 支出・収入と振替で規則が違う。振替には店舗に当たるものが無く、
 * 口座の移動が明細の中身そのものだから（#34）。
 *
 * @param tx 明細。
 * @returns 主表示・文脈・補足。
 */
export function rowText(tx: Transaction): RowText {
  const comment = clean(tx.comment);

  // 店舗名と品名は「Microsoft の Azure」のように両方が意味を持つので、
  // 揃っていれば両方出す
  const label = [tx.place, tx.name]
    .map(clean)
    .filter((part) => part !== null)
    .join(" / ");

  // 振替は口座の移動を主表示に固定する。下の規則に通すと、振替の `place` と
  // `name` はほぼ空（495 件中 454 件）なのでメモの有無が分かれ目になり、
  // 口座が 1 行目と 2 行目を行き来する。しかも振替のメモはほぼ全件が
  // 取り込み元のタグ（`#MUFG取込` など）で、主表示を譲る相手ではない
  if (tx.mode === "transfer") {
    return { primary: accountMovement(tx), context: label || null, note: comment };
  }

  const context = contextOf(tx);
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
