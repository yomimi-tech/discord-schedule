import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { v4 as uuid } from "uuid";
import { openDb } from "./db.js";
import Holidays from "date-holidays";

// ★ 想定外の例外でプロセスごと落ちないようにする最終防衛ライン
//   （各ルート・各イベントハンドラでのtry/catchが本筋。これはあくまで保険）
process.on("unhandledRejection", (reason) => {
  console.error("[api.js] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[api.js] Uncaught Exception:", err);
});

const app = express();
app.use(express.json());
app.use(express.static("public"));

const hd = new Holidays("JP");

// ★ Discordに投稿するURLのホスト部分。スマホ等の別端末から開く場合は
//   .envのPUBLIC_BASE_URLをPCのLAN IP（例: http://192.168.1.10:3000）に変更する
const BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

// ★ 各ルートハンドラを try/catch で包み、例外発生時は500を返す（プロセスは落とさない）
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error(`[api.js] ${req.method} ${req.originalUrl} でエラー:`, err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "internal_error" });
      }
    });
  };
}

// ★ サーバーごとの候補日生成設定を取得（未設定ならデフォルト値）
async function getConfig(db, guildId) {
  const row = guildId ? await db.get("SELECT * FROM configs WHERE guild_id=?", guildId) : null;

  if (row) {
    return {
      days_ahead: row.days_ahead,
      weekdays: row.weekdays.split(",").filter(s => s !== "").map(Number),
      include_holidays: !!row.include_holidays,
      times: row.times.split(",").filter(s => s !== "")
    };
  }

  return { days_ahead: 30, weekdays: [0, 6], include_holidays: true, times: ["16:00", "20:00"] };
}

// ★ 設定に沿って候補日（YYYY-MM-DD）を生成する
function generateCandidateDates(startDate, config) {
  const start = new Date(startDate);
  const end = new Date(start);
  end.setDate(end.getDate() + config.days_ahead);

  const weekdaySet = new Set(config.weekdays);

  const dates = [];
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    const iso = d.toISOString().slice(0, 10);
    const isHoliday = config.include_holidays && hd.isHoliday(new Date(d));
    if (weekdaySet.has(day) || isHoliday) {
      dates.push(iso);
    }
  }
  return dates;
}

// スケジュール作成API
app.post("/schedule", asyncHandler(async (req, res) => {
  const db = await openDb();
  const { title, owner_id, channel_id, guild_id } = req.body;

  const id = uuid();
  const ownerToken = uuid(); // ★ Web側の管理操作用トークン（作成者だけに知らされる）
  const created = Date.now();
  const deadline = created + 7 * 24 * 60 * 60 * 1000;

  await db.run(
    "INSERT INTO schedules (id,title,owner_id,channel_id,guild_id,owner_token,created_at,deadline_at,final_date) VALUES (?,?,?,?,?,?,?,?,?)",
    id, title || "日程調整", owner_id || "unknown", channel_id || null, guild_id || null, ownerToken, created, deadline, null
  );

  // ★ サーバーごとの設定（期間・曜日・時刻）に沿って候補を自動生成
  const config = await getConfig(db, guild_id);
  const dates = generateCandidateDates(new Date(), config);
  for (const d of dates) {
    for (const t of config.times) {
      await db.run("INSERT INTO candidates (schedule_id,date) VALUES (?,?)", id, `${d} ${t}`);
    }
  }

  res.json({ id, url: `${BASE_URL}/schedule.html?id=${id}`, admin_token: ownerToken });
}));

// 回答まとめて保存API
app.post("/submit_votes", asyncHandler(async (req, res) => {
  const db = await openDb();
  const { schedule_id, user_id, user_name, votes, comment } = req.body;

  if (!user_name) {
    return res.json({ ok: false, message: "no_user_name" });
  }

  // ★ 既存の日付はUPDATEで上書きし、行の並び順（＝列の表示順）を保つ
  //   全削除→全挿入だと編集のたびに一番右へ移動してしまうため
  const existingRows = await db.all(
    "SELECT date FROM votes WHERE schedule_id=? AND user_id=?",
    schedule_id, user_id
  );
  const existingDates = new Set(existingRows.map(r => r.date));
  const newDates = new Set(votes.map(v => v.date));

  for (const v of votes) {
    if (existingDates.has(v.date)) {
      await db.run(
        "UPDATE votes SET value=? WHERE schedule_id=? AND user_id=? AND date=?",
        v.value, schedule_id, user_id, v.date
      );
    } else {
      await db.run(
        "INSERT INTO votes (schedule_id,user_id,user_name,date,value) VALUES (?,?,?,?,?)",
        schedule_id, user_id, user_name, v.date, v.value
      );
    }
  }

  // ★ 今回の回答に含まれなくなった日付（候補削除など）だけ削除
  for (const d of existingDates) {
    if (!newDates.has(d)) {
      await db.run(
        "DELETE FROM votes WHERE schedule_id=? AND user_id=? AND date=?",
        schedule_id, user_id, d
      );
    }
  }

  // ★ コメントも合わせて保存（空なら削除のみ＝コメントなし状態にする）
  await db.run(
    "DELETE FROM comments WHERE schedule_id=? AND user_id=?",
    schedule_id, user_id
  );
  if (comment && comment.trim()) {
    await db.run(
      "INSERT INTO comments (schedule_id,user_id,user_name,comment) VALUES (?,?,?,?)",
      schedule_id, user_id, user_name, comment.trim()
    );
  }

  res.json({ ok: true });
}));

// 候補追加（重複チェック付き）
app.post("/add_candidate", asyncHandler(async (req, res) => {
  const db = await openDb();
  const { schedule_id, date, admin_token } = req.body;

  // ★ 作成者用トークンが一致する場合のみ追加を許可
  const sched = await db.get("SELECT owner_token FROM schedules WHERE id=?", schedule_id);
  if (!sched || !admin_token || sched.owner_token !== admin_token) {
    return res.status(403).json({ ok: false, message: "forbidden" });
  }

  const exists = await db.get(
    "SELECT 1 FROM candidates WHERE schedule_id=? AND date=?",
    schedule_id, date
  );

  if (exists) {
    return res.json({ ok: false, message: "duplicate" });
  }

  await db.run(
    "INSERT INTO candidates (schedule_id, date) VALUES (?, ?)",
    schedule_id, date
  );

  res.json({ ok: true });
}));

// 候補削除
app.post("/remove_candidate", asyncHandler(async (req, res) => {
  const db = await openDb();
  const { schedule_id, date, admin_token } = req.body;

  // ★ 作成者用トークンが一致する場合のみ削除を許可
  const sched = await db.get("SELECT owner_token FROM schedules WHERE id=?", schedule_id);
  if (!sched || !admin_token || sched.owner_token !== admin_token) {
    return res.status(403).json({ ok: false, message: "forbidden" });
  }

  await db.run(
    "DELETE FROM candidates WHERE schedule_id=? AND date=?",
    schedule_id, date
  );

  res.json({ ok: true });
}));

// ★ 日程確定API（bot が「はい」を押したときに呼ぶ）
app.post("/finalize", asyncHandler(async (req, res) => {
  const db = await openDb();
  const { schedule_id, date } = req.body;

  await db.run(
    "UPDATE schedules SET final_date=? WHERE id=?",
    date, schedule_id
  );

  res.json({ ok: true });
}));

// ★ 候補日自動生成設定の取得
app.get("/config/:guild_id", asyncHandler(async (req, res) => {
  const db = await openDb();
  const config = await getConfig(db, req.params.guild_id);
  res.json({ config });
}));

// ★ 候補日自動生成設定の更新（送られてきた項目だけ上書き）
app.post("/config/:guild_id", asyncHandler(async (req, res) => {
  const db = await openDb();
  const guildId = req.params.guild_id;
  const { days_ahead, weekdays, include_holidays, times } = req.body;

  // ★ バリデーション
  if (days_ahead !== undefined && (!Number.isInteger(days_ahead) || days_ahead <= 0)) {
    return res.status(400).json({ ok: false, message: "invalid_days_ahead" });
  }
  if (weekdays !== undefined && (!Array.isArray(weekdays) || weekdays.some(w => !Number.isInteger(w) || w < 0 || w > 6))) {
    return res.status(400).json({ ok: false, message: "invalid_weekdays" });
  }
  if (times !== undefined) {
    const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!Array.isArray(times) || times.length === 0 || times.length > 4 || times.some(t => !timeRegex.test(t))) {
      return res.status(400).json({ ok: false, message: "invalid_times" });
    }
  }

  const current = await getConfig(db, guildId);
  const merged = {
    days_ahead: days_ahead !== undefined ? days_ahead : current.days_ahead,
    weekdays: weekdays !== undefined ? weekdays : current.weekdays,
    include_holidays: include_holidays !== undefined ? !!include_holidays : current.include_holidays,
    times: times !== undefined ? times : current.times
  };

  const existing = await db.get("SELECT guild_id FROM configs WHERE guild_id=?", guildId);
  if (existing) {
    await db.run(
      "UPDATE configs SET days_ahead=?, weekdays=?, include_holidays=?, times=? WHERE guild_id=?",
      merged.days_ahead, merged.weekdays.join(","), merged.include_holidays ? 1 : 0, merged.times.join(","), guildId
    );
  } else {
    await db.run(
      "INSERT INTO configs (guild_id, days_ahead, weekdays, include_holidays, times) VALUES (?,?,?,?,?)",
      guildId, merged.days_ahead, merged.weekdays.join(","), merged.include_holidays ? 1 : 0, merged.times.join(",")
    );
  }

  res.json({ ok: true, config: merged });
}));

// ★ サーバーメンバー一覧取得API（Bot除く）。名前選択用。
//   ※Discord Developer Portal で「SERVER MEMBERS INTENT」を有効にする必要あり
app.get("/guild_members/:guild_id", asyncHandler(async (req, res) => {
  const guildId = req.params.guild_id;

  const members = [];
  let after = "0";

  try {
    while (true) {
      const resp = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
        { headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` } }
      );

      if (!resp.ok) {
        return res.status(resp.status).json({ error: "discord_api_error" });
      }

      const batch = await resp.json();
      if (batch.length === 0) break;

      for (const m of batch) {
        if (!m.user.bot) {
          members.push({
            id: m.user.id,
            name: m.nick || m.user.global_name || m.user.username
          });
        }
      }

      after = batch[batch.length - 1].user.id;
      if (batch.length < 1000) break;
    }

    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: "fetch_failed" });
  }
}));

// ★ チャンネル内で最新のスケジュール取得API（/best のID省略時に使用）
app.get("/schedule/latest/:channel_id", asyncHandler(async (req, res) => {
  const db = await openDb();
  const channelId = req.params.channel_id;

  const sched = await db.get(
    "SELECT * FROM schedules WHERE channel_id=? ORDER BY created_at DESC LIMIT 1",
    channelId
  );

  if (!sched) {
    return res.json({ schedule: null });
  }

  delete sched.owner_token; // ★ 秘密トークンは絶対にレスポンスへ含めない

  const candidates = await db.all("SELECT date FROM candidates WHERE schedule_id=?", sched.id);
  const votes = await db.all("SELECT user_id,user_name,date,value FROM votes WHERE schedule_id=?", sched.id);

  res.json({ schedule: sched, candidates, votes });
}));

// ★ 確定した日程をiCal(.ics)形式でダウンロードできるようにする（iPhone標準カレンダー等）
app.get("/schedule/:id/calendar.ics", asyncHandler(async (req, res) => {
  const db = await openDb();
  const sched = await db.get("SELECT title, final_date FROM schedules WHERE id=?", req.params.id);

  if (!sched || !sched.final_date) {
    return res.status(404).send("Not found");
  }

  // ★ JST（日本時間）の "YYYY-MM-DD HH:MM" をUTCのiCal時刻文字列に変換
  const toUtcIcsString = (jstStr, addHours = 0) => {
    const [datePart, timePart] = jstStr.split(" ");
    const [y, m, d] = datePart.split("-").map(Number);
    const [hh, mm] = timePart.split(":").map(Number);
    const utcMs = Date.UTC(y, m - 1, d, hh - 9 + addHours, mm, 0); // ★ JST=UTC+9
    const dt = new Date(utcMs);
    const pad = n => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`;
  };

  const escapeIcsText = (str) =>
    String(str).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");

  const dtStamp = toUtcIcsString(sched.final_date);
  const dtStart = toUtcIcsString(sched.final_date);
  const dtEnd = toUtcIcsString(sched.final_date, 2); // ★ 所要時間は2時間と仮定

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//discord-schedule//JP",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${req.params.id}@discord-schedule`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(sched.title || "日程調整")}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="schedule.ics"');
  res.send(ics);
}));

// スケジュール取得API
app.get("/schedule/:id", asyncHandler(async (req, res) => {
  const db = await openDb();
  const id = req.params.id;
  const adminToken = req.query.admin_token;

  const sched = await db.get("SELECT * FROM schedules WHERE id=?", id);
  const candidates = await db.all("SELECT date FROM candidates WHERE schedule_id=?", id);
  const votes = await db.all("SELECT user_id,user_name,date,value FROM votes WHERE schedule_id=?", id);
  const comments = await db.all("SELECT user_id,user_name,comment FROM comments WHERE schedule_id=?", id);

  let schedOut = null;
  if (sched) {
    // ★ 秘密トークン自体は返さず、一致したかどうか（is_admin）だけを返す
    const isAdmin = !!(sched.owner_token && adminToken && sched.owner_token === adminToken);
    delete sched.owner_token;
    schedOut = { ...sched, is_admin: isAdmin };
  }

  res.json({ schedule: schedOut, candidates, votes, comments });
}));

// ★ 最終防衛ライン：ここまでで拾いきれなかった同期的な例外もここでキャッチする
app.use((err, req, res, next) => {
  console.error(`[api.js] Expressエラーハンドラ (${req.method} ${req.originalUrl}):`, err);
  if (!res.headersSent) {
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// ★ Railway等のPaaSは起動時にPORTを指定してくる。ローカルでは今まで通り3000番を使う
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
