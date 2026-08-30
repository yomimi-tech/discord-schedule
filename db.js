import sqlite3 from "sqlite3";
import { open } from "sqlite";

// ★ Railway等では永続ボリュームのパス（例: /data/data.db）をDB_PATHで指定する
//   未設定時はローカル開発時と同じ ./data.db を使う
const DB_PATH = process.env.DB_PATH || "./data.db";

export async function openDb() {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // スケジュール本体
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      title TEXT,
      owner_id TEXT,
      channel_id TEXT,  -- ★ /best でID省略時に「このチャンネルの最新」を引くために使用
      guild_id TEXT,    -- ★ サーバーメンバー一覧取得に使用
      owner_token TEXT, -- ★ Web側の管理操作（候補削除など）を作成者に限定するための秘密トークン
      created_at INTEGER,
      deadline_at INTEGER,
      final_date TEXT   -- ★確定した日時を保存
    );
  `);

  // ★ 既存DB向けマイグレーション（列が無ければ追加）
  const schedulesColumns = await db.all("PRAGMA table_info(schedules)");
  if (!schedulesColumns.some(c => c.name === "channel_id")) {
    await db.run("ALTER TABLE schedules ADD COLUMN channel_id TEXT");
  }
  if (!schedulesColumns.some(c => c.name === "guild_id")) {
    await db.run("ALTER TABLE schedules ADD COLUMN guild_id TEXT");
  }
  if (!schedulesColumns.some(c => c.name === "owner_token")) {
    await db.run("ALTER TABLE schedules ADD COLUMN owner_token TEXT");
  }

  // 日時候補
  await db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT,
      date TEXT
    );
  `);

  // 回答
  await db.exec(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT,
      user_id TEXT,
      user_name TEXT,
      date TEXT,
      value REAL
    );
  `);

  // ★ コメント（回答者1人につき1件）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id TEXT,
      user_id TEXT,
      user_name TEXT,
      comment TEXT
    );
  `);

  // ★ サーバーごとの /schedule 候補日自動生成設定
  await db.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      guild_id TEXT PRIMARY KEY,
      days_ahead INTEGER DEFAULT 30,
      weekdays TEXT DEFAULT '0,6',      -- getDay()の値をカンマ区切りで（0=日,...,6=土）
      include_holidays INTEGER DEFAULT 1,
      times TEXT DEFAULT '16:00,20:00'  -- カンマ区切り、最大4件
    );
  `);

  return db;
}
