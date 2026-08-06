-- ZaimViewer ミラー DB スキーマ
-- 方針: Zaim が唯一の正。このDBは使い捨てミラーで、同期のたび全再構築される。
--       独自データは一切持たない（編集は Zaim API 経由で行う）。

-- 明細（payment / income / transfer すべて）
CREATE TABLE transactions (
    id              INTEGER PRIMARY KEY,  -- Zaim の明細 ID
    mode            TEXT    NOT NULL,     -- payment / income / transfer
    date            TEXT    NOT NULL,     -- YYYY-MM-DD
    amount          INTEGER NOT NULL,
    category_id     INTEGER,
    genre_id        INTEGER,
    from_account_id INTEGER,
    to_account_id   INTEGER,
    name            TEXT,                 -- 品名
    place           TEXT,                 -- 店舗
    comment         TEXT,
    currency_code   TEXT,
    receipt_id      INTEGER,
    active          INTEGER,
    created         TEXT,                 -- Zaim 上の登録日時
    raw             TEXT    NOT NULL      -- API レスポンス原文（将来の列追加に備える）
);
CREATE INDEX idx_tx_date ON transactions (date);
CREATE INDEX idx_tx_mode_date ON transactions (mode, date);
CREATE INDEX idx_tx_category ON transactions (category_id);
CREATE INDEX idx_tx_from_account ON transactions (from_account_id);
CREATE INDEX idx_tx_to_account ON transactions (to_account_id);

-- カテゴリマスタ
CREATE TABLE categories (
    id     INTEGER PRIMARY KEY,
    mode   TEXT,
    name   TEXT,
    sort   INTEGER,
    active INTEGER,
    raw    TEXT NOT NULL
);

-- ジャンル（カテゴリ内訳）マスタ
CREATE TABLE genres (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER,
    name        TEXT,
    sort        INTEGER,
    active      INTEGER,
    raw         TEXT NOT NULL
);

-- 口座マスタ
CREATE TABLE accounts (
    id     INTEGER PRIMARY KEY,
    name   TEXT,
    sort   INTEGER,
    active INTEGER,
    raw    TEXT NOT NULL
);

-- 同期メタ情報
CREATE TABLE sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- 閲覧用 VIEW: マスタを JOIN 済みの明細
CREATE VIEW v_transactions AS
SELECT
    t.id,
    t.mode,
    t.date,
    t.amount,
    c.name  AS category,
    g.name  AS genre,
    fa.name AS from_account,
    ta.name AS to_account,
    t.name,
    t.place,
    t.comment,
    t.active,
    t.created
FROM transactions t
LEFT JOIN categories c  ON c.id  = t.category_id
LEFT JOIN genres g      ON g.id  = t.genre_id
LEFT JOIN accounts fa   ON fa.id = t.from_account_id
LEFT JOIN accounts ta   ON ta.id = t.to_account_id;
