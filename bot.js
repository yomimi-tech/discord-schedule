import dotenv from "dotenv";
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField
} from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ★ Web側と同じくPUBLIC_BASE_URLを参照（.icsリンクの組み立てに使用）
const BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";

// ★ api.jsへの内部通信用。同じコンテナ内で動く前提なので127.0.0.1のまま、
//   ポート番号だけはapi.js側と揃うようPORT環境変数を参照する
const INTERNAL_API_URL = `http://127.0.0.1:${process.env.PORT || 3000}`;

// ★ 承認したサーバーだけで動かすための許可リスト（カンマ区切りのギルドID）
//   未設定の場合は安全側に倒して「どのサーバーでも許可しない」扱いにする
const ALLOWED_GUILD_IDS = new Set(
  (process.env.ALLOWED_GUILD_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);

function isGuildAllowed(guildId) {
  return !!guildId && ALLOWED_GUILD_IDS.has(guildId);
}

// ★ 未承認サーバーから退出する前に、投稿できそうなチャンネルへ理由を残す
const UNAPPROVED_MESSAGE =
  "このサーバーは承認されていないため、Botを使用することができません。\n" +
  "使用するにはBot作成者に連絡し承認を得てください。\n\n" +
  "作成者：yomimi\n" +
  "連絡先：yomimi0403";

async function notifyBeforeLeaving(guild) {
  try {
    let channel = guild.systemChannel;
    const canSend = (ch) =>
      ch?.isTextBased?.() &&
      ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages);

    if (!canSend(channel)) {
      channel = guild.channels.cache.find(canSend);
    }
    if (channel) {
      await channel.send(UNAPPROVED_MESSAGE);
    }
  } catch (e) {
    console.error(`[bot.js] 未承認サーバーへの通知送信に失敗しました (${guild.id}):`, e);
  }
}

async function leaveUnapprovedGuild(guild) {
  console.warn(`[bot.js] 未承認サーバーのため退出します: ${guild.name} (${guild.id})`);
  await notifyBeforeLeaving(guild);
  try {
    await guild.leave();
  } catch (e) {
    console.error("[bot.js] guild.leave()に失敗しました:", e);
  }
}

// ★ JST（日本時間）の "YYYY-MM-DD HH:MM" をGoogleカレンダー用のUTC時刻文字列に変換
function toUtcCalendarString(jstDateTimeStr, addHours = 0) {
  const [datePart, timePart] = jstDateTimeStr.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh - 9 + addHours, mm, 0); // ★ JST=UTC+9
  const dt = new Date(utcMs);
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`;
}

// ★ Googleカレンダーのクイック追加URLを組み立てる（所要時間は2時間と仮定）
function buildGoogleCalendarUrl(title, finalDate) {
  const start = toUtcCalendarString(finalDate);
  const end = toUtcCalendarString(finalDate, 2);
  return `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${start}/${end}`;
}

client.once("clientReady", async () => {
  console.log("Bot ready");

  // ★ 起動時点ですでに未承認サーバーに参加している場合も退出しておく
  for (const guild of client.guilds.cache.values()) {
    if (!isGuildAllowed(guild.id)) {
      await leaveUnapprovedGuild(guild);
    }
  }
});

// ★ 新しいサーバーに追加された瞬間に、承認済みかどうかをチェックする
client.on("guildCreate", async (guild) => {
  if (!isGuildAllowed(guild.id)) {
    await leaveUnapprovedGuild(guild);
  } else {
    console.log(`[bot.js] 承認済みサーバーに追加されました: ${guild.name} (${guild.id})`);
  }
});

// ★ 想定外の例外でBot全体が落ちないようにする最終防衛ライン
//   （各ハンドラでのtry/catchが本筋。これはあくまで保険）
process.on("unhandledRejection", (reason) => {
  console.error("[bot.js] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[bot.js] Uncaught Exception:", err);
});

client.on("error", (err) => {
  console.error("[bot.js] Discordクライアントエラー:", err);
});

// ★ interactionへのエラー通知（返信済みならfollowUp、未返信ならreply。それも失敗したらログのみ）
async function safeReply(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true });
    } else {
      await interaction.reply({ content: message, ephemeral: true });
    }
  } catch (e) {
    console.error("[bot.js] エラー通知の送信にも失敗しました:", e);
  }
}

// ★ 各interactionCreateハンドラをtry/catchで包み、1件のエラーでBot全体が落ちないようにする
//   ★ 加えて、承認リストにないサーバーからの操作はここで一律拒否する
function safeHandler(fn) {
  return async (interaction) => {
    try {
      if (!isGuildAllowed(interaction.guildId)) {
        console.warn(`[bot.js] 未承認サーバーからの操作を拒否しました: guildId=${interaction.guildId}`);
        await safeReply(interaction, "このサーバーではこのBotは利用できません。");
        return;
      }
      await fn(interaction);
    } catch (err) {
      console.error("[bot.js] Interaction処理中にエラーが発生しました:", err);
      await safeReply(interaction, "エラーが発生しました。しばらくしてからもう一度お試しください。");
    }
  };
}

// スラッシュコマンド登録
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("schedule")
      .setDescription("日程調整ページを作成します")
      .setDefaultMemberPermissions(0) // ★ デフォルトでは誰も使用不可。サーバー設定の「連携」からロール単位で許可する
      .addStringOption(opt =>
        opt.setName("title")
          .setDescription("タイトル（任意）")
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("best")
      .setDescription("最有力候補日を表示します")
      .setDefaultMemberPermissions(0) // ★ デフォルトでは誰も使用不可。サーバー設定の「連携」からロール単位で許可する
      .addStringOption(opt =>
        opt.setName("id")
          .setDescription("スケジュールID（省略時はこのチャンネルの最新の日程調整を使用）")
          .setRequired(false)
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("config")
      .setDescription("/schedule の候補日自動生成設定を変更します")
      .setDefaultMemberPermissions(0) // ★ デフォルトでは誰も使用不可。サーバー設定の「連携」からロール単位で許可する
      .addSubcommand(sub =>
        sub.setName("show")
          .setDescription("現在の設定を表示します")
      )
      .addSubcommand(sub =>
        sub.setName("period")
          .setDescription("今日から何日分の候補を生成するか設定します")
          .addStringOption(opt =>
            opt.setName("value")
              .setDescription("期間")
              .setRequired(true)
              .addChoices(
                { name: "0.5ヶ月（15日）", value: "15" },
                { name: "1ヶ月（30日）", value: "30" },
                { name: "2ヶ月（60日）", value: "60" },
                { name: "3ヶ月（90日）", value: "90" }
              )
          )
      )
      .addSubcommand(sub =>
        sub.setName("weekdays")
          .setDescription("候補に含める曜日・祝日を選択します")
      )
      .addSubcommand(sub =>
        sub.setName("times")
          .setDescription("各候補日に設定する時刻を設定します（最大4件、例: 16:00,18:30）")
      )
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

  if (process.env.DISCORD_GUILD_ID) {
    // ★ .envにDISCORD_GUILD_IDがある間は、そのサーバーにだけ即時反映（開発・動作確認用）
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID
      ),
      { body: commands }
    );
    console.log("Slash commands registered (guild-only / テスト用サーバーにのみ反映)");
  } else {
    // ★ 公開用：全サーバーに反映（反映まで最大1時間ほどかかる場合あり）
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log("Slash commands registered (global / 全サーバーに反映)");
  }
}

await registerCommands();

// ★ 確定操作は /schedule 実行者のみ許可する
async function ensureOwner(interaction, scheduleId) {
  const res = await fetch(`${INTERNAL_API_URL}/schedule/${scheduleId}`);
  const data = await res.json();

  if (!data.schedule || data.schedule.owner_id !== interaction.user.id) {
    await interaction.reply({
      content: "この操作は /schedule を実行した本人のみ行えます",
      ephemeral: true
    });
    return false;
  }
  return true;
}

// コマンド処理
client.on("interactionCreate", safeHandler(async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // -------------------------
  // /schedule
  // -------------------------
  if (interaction.commandName === "schedule") {
    const title = interaction.options.getString("title") || "日程調整";

    const res = await fetch(`${INTERNAL_API_URL}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        owner_id: interaction.user.id,
        channel_id: interaction.channelId,
        guild_id: interaction.guildId
      })
    });

    const data = await res.json();

    await interaction.reply(`【${title}】日程調整ページを作成しました： ${data.url}`);

    // ★ 候補日削除などの管理操作リンクは実行者だけに見える形で送る
    const adminUrl = `${data.url}&admin=${data.admin_token}`;
    await interaction.followUp({
      content: `【管理用リンク】候補日時の追加・削除はこちらから行えます（あなたにしか見えていません。他の人には共有しないでください）：\n${adminUrl}`,
      ephemeral: true
    });
  }

  // -------------------------
  // /best
  // -------------------------
  if (interaction.commandName === "best") {
    const specifiedId = interaction.options.getString("id");

    // ★ ID省略時はこのチャンネルの最新スケジュールを使う
    const res = await fetch(
      specifiedId
        ? `${INTERNAL_API_URL}/schedule/${specifiedId}`
        : `${INTERNAL_API_URL}/schedule/latest/${interaction.channelId}`
    );
    const data = await res.json();

    if (!data.schedule) {
      return interaction.reply(
        specifiedId
          ? "指定されたIDのスケジュールが見つかりませんでした"
          : "このチャンネルにはまだ日程調整がありません（先に /schedule を実行してください）"
      );
    }

    // ★ /best は /schedule を実行した本人のみ使用可能
    if (data.schedule.owner_id !== interaction.user.id) {
      return interaction.reply({
        content: "このコマンドは /schedule を実行した本人のみ使用できます",
        ephemeral: true
      });
    }

    const scheduleId = data.schedule.id;

    // ★ どの日程調整についての結果かがわかるように見出しを付ける
    const createdAt = new Date(data.schedule.created_at).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo"
    });
    const header = `【${data.schedule.title}】（作成日時: ${createdAt}）\n`;

    // ★ すでに確定済みならメッセージを返す
    if (data.schedule.final_date) {
      return interaction.reply(
        `${header}すでに日程確定済みです。\n確定した日時： **${data.schedule.final_date}**`
      );
    }

    const candidates = data.candidates.map(c => c.date);
    const votes = data.votes;

    // ★ 点数計算
    const scoreMap = {};

    for (const d of candidates) {
      let total = 0;
      for (const v of votes) {
        if (v.date === d && v.value !== null) {
          total += v.value;
        }
      }
      scoreMap[d] = total;
    }

    const scores = Object.values(scoreMap);
    const maxScore = Math.max(...scores);

    if (maxScore === 0) {
      return interaction.reply(`${header}まだ回答がありません`);
    }

    // ★ 最大点の候補をすべて抽出
    const bestDates = Object.keys(scoreMap).filter(d => scoreMap[d] === maxScore);

    // ★ 複数候補がある場合は選択式にする
    if (bestDates.length > 1) {
      // ★ Discordの上限：1行あたりボタン5個まで、1メッセージあたり行5つまで（最大25個）
      const limitedDates = bestDates.slice(0, 25);

      const buttons = limitedDates.map(d =>
        new ButtonBuilder()
          .setCustomId(`choose_${scheduleId}_${d}`)
          .setLabel(d)
          .setStyle(ButtonStyle.Primary)
      );

      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
      }

      return interaction.reply({
        content: `${header}候補日が2日以上あります。以下から選択ください：`,
        components: rows
      });
    }

    // ★ 候補が1つの場合（従来のはい／いいえ）
    const best = bestDates[0];

    const yesBtn = new ButtonBuilder()
      .setCustomId(`confirm_yes_${scheduleId}_${best}`)
      .setLabel("はい")
      .setStyle(ButtonStyle.Success);

    const noBtn = new ButtonBuilder()
      .setCustomId(`confirm_no_${scheduleId}`)
      .setLabel("いいえ")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(yesBtn, noBtn);

    await interaction.reply({
      content: `${header}最有力候補日は **${best}** です。\n日程を確定させて回答をロックしますか？`,
      components: [row]
    });
  }

  // -------------------------
  // /config
  // -------------------------
  if (interaction.commandName === "config") {
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      const res = await fetch(`${INTERNAL_API_URL}/config/${interaction.guildId}`);
      const data = await res.json();
      const c = data.config;

      const weekdayLabels = { 0: "日", 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土" };
      const weekdaysText = c.weekdays.slice().sort().map(w => weekdayLabels[w]).join("、") || "なし";

      return interaction.reply({
        content:
          `現在の設定:\n` +
          `・期間: 今日から${c.days_ahead}日先まで\n` +
          `・曜日: ${weekdaysText}${c.include_holidays ? "、祝日" : ""}\n` +
          `・時刻: ${c.times.join(", ")}`,
        ephemeral: true
      });
    }

    if (sub === "period") {
      const days = Number(interaction.options.getString("value"));

      const res = await fetch(`${INTERNAL_API_URL}/config/${interaction.guildId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days_ahead: days })
      });
      const data = await res.json();

      if (!data.ok) {
        return interaction.reply({ content: "設定の更新に失敗しました", ephemeral: true });
      }
      return interaction.reply({ content: `期間を「今日から${days}日先まで」に設定しました`, ephemeral: true });
    }

    if (sub === "weekdays") {
      // ★ テキスト入力ではなく、複数選択できるセレクトメニューを表示する
      const menu = new StringSelectMenuBuilder()
        .setCustomId("config_weekdays_select")
        .setPlaceholder("曜日・祝日を選択（複数選択可）")
        .setMinValues(1)
        .setMaxValues(8)
        .addOptions(
          { label: "月", value: "1" },
          { label: "火", value: "2" },
          { label: "水", value: "3" },
          { label: "木", value: "4" },
          { label: "金", value: "5" },
          { label: "土", value: "6" },
          { label: "日", value: "0" },
          { label: "祝日", value: "holiday" }
        );

      const row = new ActionRowBuilder().addComponents(menu);

      return interaction.reply({
        content: "候補に含める曜日・祝日を選択してください（複数選択可）",
        components: [row],
        ephemeral: true
      });
    }

    if (sub === "times") {
      // ★ 自由入力かつエラー時に再入力しやすいようモーダルで受け付ける
      const configRes = await fetch(`${INTERNAL_API_URL}/config/${interaction.guildId}`);
      const configData = await configRes.json();
      const currentTimes = (configData.config?.times || []).join(",");

      return interaction.showModal(buildTimesModal(currentTimes));
    }
  }
}));

// ★ 時刻入力用モーダルを組み立てる（初回・再入力どちらも共通）
function buildTimesModal(prefill) {
  const modal = new ModalBuilder()
    .setCustomId("config_times_modal")
    .setTitle("時刻の設定（最大4件）");

  const input = new TextInputBuilder()
    .setCustomId("value")
    .setLabel("カンマ区切りで指定（例: 16:00,18:30）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("16:00,18:30")
    .setValue(prefill || "");

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// -------------------------
// モーダル処理
// -------------------------
client.on("interactionCreate", safeHandler(async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== "config_times_modal") return;

  const raw = interaction.fields.getTextInputValue("value");
  const rawTimes = raw.split(/[,、]/).map(t => t.trim()).filter(Boolean);

  const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const invalid = rawTimes.filter(t => !timeRegex.test(t));

  const replyWithRetry = (message) => {
    const safeRaw = raw.length > 60 ? raw.slice(0, 60) : raw;
    const retryBtn = new ButtonBuilder()
      .setCustomId(`config_times_retry_${encodeURIComponent(safeRaw)}`)
      .setLabel("再入力")
      .setStyle(ButtonStyle.Primary);

    return interaction.reply({
      content: message,
      components: [new ActionRowBuilder().addComponents(retryBtn)],
      ephemeral: true
    });
  };

  if (invalid.length > 0) {
    return replyWithRetry(`時刻の形式が正しくありません: ${invalid.join(", ")}\n「HH:MM」形式で指定してください（例: 16:00 / 9:30）`);
  }

  // ★ 1桁時刻（9:00 等）を09:00形式に揃えたうえで重複を除去
  const times = [...new Set(rawTimes.map(t => t.padStart(5, "0")))];

  if (times.length === 0) {
    return replyWithRetry("最低1つは時刻を指定してください");
  }

  if (times.length > 4) {
    return replyWithRetry("時刻は最大4件までです");
  }

  const res = await fetch(`${INTERNAL_API_URL}/config/${interaction.guildId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ times })
  });
  const data = await res.json();

  if (!data.ok) {
    return replyWithRetry("設定の更新に失敗しました");
  }
  return interaction.reply({ content: `時刻設定を更新しました: ${times.join(", ")}`, ephemeral: true });
}));

// -------------------------
// セレクトメニュー処理
// -------------------------
client.on("interactionCreate", safeHandler(async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  // ★ /config weekdays の曜日・祝日選択
  if (interaction.customId === "config_weekdays_select") {
    const values = interaction.values; // 例: ["0","6","holiday"]
    const weekdays = values.filter(v => v !== "holiday").map(Number);
    const includeHolidays = values.includes("holiday");

    const res = await fetch(`${INTERNAL_API_URL}/config/${interaction.guildId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weekdays, include_holidays: includeHolidays })
    });
    const data = await res.json();

    if (!data.ok) {
      return interaction.update({ content: "設定の更新に失敗しました", components: [] });
    }

    const weekdayLabels = { 0: "日", 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土" };
    const text = weekdays.slice().sort().map(w => weekdayLabels[w]).join("、");
    const summary = [text, includeHolidays ? "祝日" : ""].filter(Boolean).join("、");

    return interaction.update({
      content: `曜日設定を更新しました: ${summary}`,
      components: []
    });
  }
}));

// -------------------------
// ボタン処理
// -------------------------
client.on("interactionCreate", safeHandler(async (interaction) => {
  if (!interaction.isButton()) return;

  // ★ /config times でエラーになった際の「再入力」ボタン → 同じ内容でモーダルを開き直す
  if (interaction.customId.startsWith("config_times_retry_")) {
    const prefill = decodeURIComponent(interaction.customId.slice("config_times_retry_".length));
    return interaction.showModal(buildTimesModal(prefill));
  }

  // -------------------------
  // 複数候補から選択された場合 → はい/いいえ確認へ
  // -------------------------
  if (interaction.customId.startsWith("choose_")) {
    const parts = interaction.customId.split("_");
    const scheduleId = parts[1];
    const bestDate = parts.slice(2).join("_");

    if (!(await ensureOwner(interaction, scheduleId))) return;

    const yesBtn = new ButtonBuilder()
      .setCustomId(`confirm_yes_${scheduleId}_${bestDate}`)
      .setLabel("はい")
      .setStyle(ButtonStyle.Success);

    const noBtn = new ButtonBuilder()
      .setCustomId(`confirm_no_${scheduleId}`)
      .setLabel("いいえ")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(yesBtn, noBtn);

    await interaction.update({
      content: `選択した候補日は **${bestDate}** です。\n日程を確定させて回答をロックしますか？`,
      components: [row]
    });

    return;
  }

  // -------------------------
  // 「はい」ボタン
  // -------------------------
  if (interaction.customId.startsWith("confirm_yes_")) {
    const parts = interaction.customId.split("_");
    const scheduleId = parts[2];
    const bestDate = parts.slice(3).join("_");

    if (!(await ensureOwner(interaction, scheduleId))) return;

    // ★ 先に応答してタイムアウト防止
    await interaction.update({
      content: `日程を確定中…`,
      components: []
    });

    // ★ finalize API（非同期）
    fetch(`${INTERNAL_API_URL}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule_id: scheduleId, date: bestDate })
    }).then(async () => {
      const schedRes = await fetch(`${INTERNAL_API_URL}/schedule/${scheduleId}`);
      const schedData = await schedRes.json();

      const createdAt = new Date(schedData.schedule.created_at).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo"
      });

      // ★ 確定日に〇/△と回答した人だけを対象にする（重複除去）
      const attendeeNames = [...new Set(
        schedData.votes
          .filter(v => v.date === bestDate && (v.value === 2 || v.value === 1))
          .map(v => v.user_name)
      )];

      // ★ 名前からDiscordの実IDを引く（サーバーメンバー一覧に存在する人のみ＝「その他」入力者は対象外）
      let mentionIds = [];
      if (schedData.schedule.guild_id && attendeeNames.length > 0) {
        try {
          const memRes = await fetch(`${INTERNAL_API_URL}/guild_members/${schedData.schedule.guild_id}`);
          const memData = await memRes.json();
          if (memData.members) {
            const nameToId = new Map(memData.members.map(m => [m.name, m.id]));
            mentionIds = attendeeNames.map(name => nameToId.get(name)).filter(Boolean);
          }
        } catch (e) {
          console.error("メンバー特定に失敗しました", e);
        }
      }

      const mentionText = mentionIds.length > 0
        ? mentionIds.map(id => `<@${id}>`).join(" ") + "\n"
        : "";

      // ★ カレンダー追加用のリンクボタン
      const gcalUrl = buildGoogleCalendarUrl(schedData.schedule.title, bestDate);
      const icsUrl = `${BASE_URL}/schedule/${scheduleId}/calendar.ics`;

      const gcalBtn = new ButtonBuilder()
        .setLabel("📅 Googleカレンダーに追加")
        .setStyle(ButtonStyle.Link)
        .setURL(gcalUrl);

      const icsBtn = new ButtonBuilder()
        .setLabel("📥 iCalで保存（iPhone等）")
        .setStyle(ButtonStyle.Link)
        .setURL(icsUrl);

      const calendarRow = new ActionRowBuilder().addComponents(gcalBtn, icsBtn);

      await interaction.followUp({
        content: `${mentionText}【${schedData.schedule.title}】（作成日時: ${createdAt}）\n日程が確定しました： **${bestDate}**`,
        allowedMentions: { users: mentionIds },
        components: [calendarRow]
      });
    }).catch(async (err) => {
      // ★ .then()内のエラーはsafeHandlerでは捕まえられないため、ここで個別に処理する
      console.error("[bot.js] 日程確定処理でエラーが発生しました:", err);
      await safeReply(interaction, "日程確定処理中にエラーが発生しました。もう一度お試しください。");
    });

    return;
  }

  // -------------------------
  // 「いいえ」ボタン
  // -------------------------
  if (interaction.customId.startsWith("confirm_no_")) {
    const parts = interaction.customId.split("_");
    const scheduleId = parts[2];

    if (!(await ensureOwner(interaction, scheduleId))) return;

    await interaction.update({
      content: `キャンセルしました`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("disabled_cancel")
            .setLabel("キャンセル済み")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        )
      ]
    });
  }
}));

client.login(process.env.DISCORD_BOT_TOKEN);
