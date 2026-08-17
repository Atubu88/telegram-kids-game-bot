export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return json({ ok: true, service: 'telegram-kids-game-bot' });
      }

      if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
        await maybeRunWeeklyReset(env);
        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return json({ ok: true });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('fetch error', error);
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  },

  async scheduled(_event, env) {
    try {
      await runWeeklyReset(env);
    } catch (error) {
      console.error('scheduled error', error);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  const callbackQuery = update.callback_query;

  if (callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    if (!chatId) return;

    await answerCallbackQuery(callbackQuery.id, env);
    await routeAction({
      chatId,
      data: callbackQuery.data,
      env,
    });
    return;
  }

  if (!message?.chat?.id || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/start') {
    await clearSession(chatId, env);
    await sendMainMenu(chatId, env, 'Добро пожаловать в семейную игру ⭐️🏆');
    return;
  }

  if (text === '/reset_week') {
    await runWeeklyReset(env);
    await sendMessage(chatId, 'Недельный сброс выполнен ✅', mainMenuKeyboard(), env);
    return;
  }

  const session = await getSession(chatId, env);
  if (session && (session.state === 'await_add_reason' || session.state === 'await_remove_reason')) {
    await completePointsFlow(chatId, session, text, env);
    return;
  }

  await sendMainMenu(chatId, env, 'Используй кнопки ниже 👇');
}

async function routeAction({ chatId, data, env }) {
  if (!data) return;

  if (data === 'menu:main') {
    await clearSession(chatId, env);
    await sendMainMenu(chatId, env);
    return;
  }

  if (data === 'menu:history') {
    await sendGlobalHistory(chatId, env);
    return;
  }

  if (data === 'menu:shop') {
    await sendShopOverview(chatId, env);
    return;
  }

  if (data.startsWith('player:')) {
    const [, code] = data.split(':');
    await sendPlayerMenu(chatId, code, env);
    return;
  }

  if (data.startsWith('player_action:')) {
    const [, code, action, extra] = data.split(':');
    await handlePlayerAction(chatId, code, action, extra, env);
    return;
  }

  if (data.startsWith('shop_buy:')) {
    const [, code, itemIdRaw] = data.split(':');
    await handlePurchase(chatId, code, Number(itemIdRaw), env);
    return;
  }
}

async function handlePlayerAction(chatId, code, action, extra, env) {
  const player = await getPlayerByCode(code, env);
  if (!player) {
    await sendMessage(chatId, 'Игрок не найден', undefined, env);
    return;
  }

  if (action === 'view') {
    await sendPlayerMenu(chatId, code, env);
    return;
  }

  if (action === 'balance') {
    await sendMessage(chatId, formatPlayerSummary(player), playerMenuKeyboard(code), env);
    return;
  }

  if (action === 'history') {
    await sendPlayerHistory(chatId, player, env);
    return;
  }

  if (action === 'shop') {
    await sendPlayerShop(chatId, player, env);
    return;
  }

  if (action === 'remove_apply') {
    const lockShop = extra === 'lock';
    await applyRemoveWithOptionalLock(chatId, player, lockShop, env);
    return;
  }

  if (action === 'lock_shop') {
    await env.DB.prepare(`UPDATE players SET shop_locked = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(player.id).run();
    await sendPlayerMenu(chatId, code, env, '🎁 Магазин закрыт для игрока');
    return;
  }

  if (action === 'unlock_shop') {
    await env.DB.prepare(`UPDATE players SET shop_locked = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(player.id).run();
    await sendPlayerMenu(chatId, code, env, '🎁 Магазин открыт для игрока');
    return;
  }

  if (action === 'add' || action === 'remove') {
    const presets = [5, 10, 15, 20];
    await sendMessage(
      chatId,
      `${player.name}: выбери количество ${action === 'add' ? 'для начисления' : 'для снятия'}`,
      inlineKeyboard([
        presets.map((value) => ({
          text: `${action === 'add' ? '➕' : '➖'} ${value}`,
          callback_data: `player_action:${code}:${action}_pick:${value}`,
        })),
        [{ text: '⬅️ Назад', callback_data: `player:${code}` }],
      ]),
      env
    );
    return;
  }

  if (action === 'add_pick' || action === 'remove_pick') {
    const delta = Number(extra);
    const state = action === 'add_pick' ? 'await_add_reason' : 'await_remove_reason';
    await setSession(chatId, state, { playerCode: code, delta }, env);
    await sendMessage(
      chatId,
      `${player.name}: напиши причину ${action === 'add_pick' ? 'начисления' : 'снятия'} ${Math.abs(delta)} ⭐️ одним сообщением.`,
      undefined,
      env
    );
    return;
  }
}

async function completePointsFlow(chatId, session, reason, env) {
  const code = session.payload?.playerCode;
  const deltaBase = Number(session.payload?.delta || 0);
  const player = await getPlayerByCode(code, env);
  if (!player) {
    await clearSession(chatId, env);
    await sendMessage(chatId, 'Игрок не найден', undefined, env);
    return;
  }

  const isAdd = session.state === 'await_add_reason';

  if (isAdd) {
    const delta = Math.abs(deltaBase);
    const nextWeeklyStars = Math.max(0, player.weekly_stars + delta);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE players
         SET weekly_stars = ?,
             lifetime_progress = lifetime_progress + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(nextWeeklyStars, delta, player.id),
      env.DB.prepare(
        `INSERT INTO point_events (player_id, delta, reason, event_type)
         VALUES (?, ?, ?, 'add')`
      ).bind(player.id, delta, reason),
    ]);

    await clearSession(chatId, env);
    const updated = await getPlayerByCode(code, env);
    await sendMessage(
      chatId,
      `✅ Начислено ${delta} ⭐️\nПричина: ${reason}\n\n${formatPlayerSummary(updated)}`,
      playerMenuKeyboard(code),
      env
    );
    return;
  }

  await setSession(chatId, 'await_remove_confirm', {
    playerCode: code,
    delta: Math.abs(deltaBase),
    reason,
  }, env);

  await sendMessage(
    chatId,
    `Снять ${Math.abs(deltaBase)} ⭐️ за: ${reason}\n\nЗакрыть магазин тоже?`,
    inlineKeyboard([
      [
        { text: 'Да, закрыть', callback_data: `player_action:${code}:remove_apply:lock` },
        { text: 'Нет', callback_data: `player_action:${code}:remove_apply:keep` },
      ],
      [{ text: '⬅️ Назад', callback_data: `player:${code}` }],
    ]),
    env
  );
}

async function applyRemoveWithOptionalLock(chatId, player, lockShop, env) {
  const session = await getSession(chatId, env);
  if (!session || session.state !== 'await_remove_confirm') {
    await sendMessage(chatId, 'Нет ожидающего снятия. Попробуй ещё раз.', playerMenuKeyboard(player.code), env);
    return;
  }

  const delta = -Math.abs(Number(session.payload?.delta || 0));
  const reason = session.payload?.reason || 'Без причины';
  const nextStars = Math.max(0, player.weekly_stars + delta);
  const nextLocked = lockShop ? 1 : player.shop_locked;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE players
       SET weekly_stars = ?,
           shop_locked = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(nextStars, nextLocked, player.id),
    env.DB.prepare(
      `INSERT INTO point_events (player_id, delta, reason, event_type)
       VALUES (?, ?, ?, 'remove')`
    ).bind(player.id, delta, reason),
  ]);

  if (lockShop && !player.shop_locked) {
    await insertPointEvent(player.id, 0, 'Магазин закрыт после штрафа', 'recovery_on', env);
  }

  await clearSession(chatId, env);
  const updated = await getPlayerByCode(player.code, env);
  await sendMessage(
    chatId,
    `✅ Снято ${Math.abs(delta)} ⭐️\nПричина: ${reason}${lockShop ? '\nМагазин: закрыт 🔒' : '\nМагазин: без изменений'}\n\n${formatPlayerSummary(updated)}` ,
    playerMenuKeyboard(player.code),
    env
  );
}

async function handlePurchase(chatId, code, itemId, env) {
  const player = await getPlayerByCode(code, env);
  if (!player) return;

  if (player.shop_locked) {
    await sendMessage(chatId, `${player.name}: магазин сейчас закрыт 🔒`, playerMenuKeyboard(code), env);
    return;
  }

  const item = await env.DB.prepare(`SELECT * FROM shop_items WHERE id = ? AND active = 1`).bind(itemId).first();
  if (!item) {
    await sendMessage(chatId, 'Товар не найден', playerMenuKeyboard(code), env);
    return;
  }

  if (player.weekly_stars < item.price) {
    await sendMessage(chatId, `${player.name}: не хватает ⭐️ для покупки ${item.emoji} ${item.name}`, playerMenuKeyboard(code), env);
    return;
  }

  const nextWeeklyStars = player.weekly_stars - item.price;

  await env.DB.batch([
    env.DB.prepare(`UPDATE players SET weekly_stars = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nextWeeklyStars, player.id),
    env.DB.prepare(`INSERT INTO purchases (player_id, shop_item_id, price_paid) VALUES (?, ?, ?)`).bind(player.id, item.id, item.price),
    env.DB.prepare(`INSERT INTO point_events (player_id, delta, reason, event_type) VALUES (?, ?, ?, 'purchase')`).bind(
      player.id,
      -item.price,
      `Покупка: ${item.emoji} ${item.name}`
    ),
  ]);

  const updated = await getPlayerByCode(code, env);
  await sendMessage(
    chatId,
    `🛍 ${player.name} купил: ${item.emoji} ${item.name}\nСписано: ${item.price} ⭐️\n\n${formatPlayerSummary(updated)}`,
    playerMenuKeyboard(code),
    env
  );
}

async function sendMainMenu(chatId, env, intro) {
  const players = await listPlayers(env);
  const lines = [intro || 'Главное меню'];
  for (const player of players) {
    lines.push(`${player.name}: ${player.weekly_stars} ⭐️ · ${player.lifetime_progress} 🏆 · ${getLevelInfo(player.weekly_stars).label}`);
  }
  await sendMessage(chatId, lines.join('\n'), mainMenuKeyboard(), env);
}

async function sendPlayerMenu(chatId, code, env, intro) {
  const player = await getPlayerByCode(code, env);
  if (!player) {
    await sendMessage(chatId, 'Игрок не найден', undefined, env);
    return;
  }

  const text = [intro, formatPlayerSummary(player)].filter(Boolean).join('\n\n');
  await sendMessage(chatId, text, playerMenuKeyboard(code), env);
}

async function sendPlayerHistory(chatId, player, env) {
  const events = await env.DB.prepare(
    `SELECT delta, reason, event_type, created_at
     FROM point_events
     WHERE player_id = ?
     ORDER BY id DESC
     LIMIT 12`
  ).bind(player.id).all();

  const rows = events.results || [];
  const lines = [`📜 История: ${player.name}`];

  if (!rows.length) {
    lines.push('Пока пусто');
  } else {
    for (const row of rows) {
      const sign = row.delta > 0 ? '+' : '';
      lines.push(`• ${sign}${row.delta} ⭐️ — ${row.reason} (${formatDate(row.created_at)})`);
    }
  }

  await sendMessage(chatId, lines.join('\n'), playerMenuKeyboard(player.code), env);
}

async function sendGlobalHistory(chatId, env) {
  const snapshots = await env.DB.prepare(
    `SELECT ws.week_key, p.name, ws.ending_stars, ws.lifetime_progress, ws.recovery_mode
     FROM weekly_snapshots ws
     JOIN players p ON p.id = ws.player_id
     ORDER BY ws.week_key DESC, p.id ASC
     LIMIT 20`
  ).all();

  const rows = snapshots.results || [];
  const lines = ['📜 Недельная история'];

  if (!rows.length) {
    lines.push('Пока нет сохранённых итогов недель');
  } else {
    for (const row of rows) {
      lines.push(`• ${row.week_key} — ${row.name}: ${row.ending_stars} ⭐️ на конец недели, ${row.lifetime_progress} 🏆${row.recovery_mode ? ', 🔒 восстановление' : ''}`);
    }
  }

  await sendMessage(chatId, lines.join('\n'), mainMenuKeyboard(), env);
}

async function sendShopOverview(chatId, env) {
  const items = await listShopItems(env);
  const players = await listPlayers(env);
  const lines = ['🎁 Общий магазин', ''];

  for (const player of players) {
    lines.push(`${player.name}: ${player.shop_locked ? '🔒 закрыт' : '🔓 открыт'} · ${player.weekly_stars} ⭐️`);
  }

  lines.push('', 'Товары:');
  for (const item of items) {
    lines.push(`• ${item.emoji} ${item.name} — ${item.price} ⭐️`);
  }

  await sendMessage(chatId, lines.join('\n'), mainMenuKeyboard(), env);
}

async function sendPlayerShop(chatId, player, env) {
  const items = await listShopItems(env);
  const lines = [
    `🎁 Магазин для ${player.name}`,
    player.shop_locked ? 'Статус: 🔒 закрыт' : 'Статус: 🔓 открыт',
    `Баланс: ${player.weekly_stars} ⭐️`,
    '',
    'Товары:',
  ];

  for (const item of items) {
    lines.push(`• ${item.emoji} ${item.name} — ${item.price} ⭐️`);
  }

  const keyboardRows = [];
  for (const item of items) {
    keyboardRows.push([{ text: `${item.emoji} ${item.name} · ${item.price}⭐️`, callback_data: `shop_buy:${player.code}:${item.id}` }]);
  }
  keyboardRows.push([
    { text: player.shop_locked ? '🔓 Открыть магазин' : '🔒 Закрыть магазин', callback_data: `player_action:${player.code}:${player.shop_locked ? 'unlock_shop' : 'lock_shop'}` },
  ]);
  keyboardRows.push([{ text: '⬅️ Назад', callback_data: `player:${player.code}` }]);

  await sendMessage(chatId, lines.join('\n'), inlineKeyboard(keyboardRows), env);
}

function formatPlayerSummary(player) {
  const level = getLevelInfo(player.weekly_stars);
  const shopText = player.shop_locked ? '🎁 Магазин: закрыт' : '🎁 Магазин: открыт';

  return [
    `${player.name}`,
    `⭐️ Баланс: ${player.weekly_stars}`,
    `🏆 Общий прогресс: ${player.lifetime_progress} / ${player.long_term_goal}`,
    `🎮 Уровень: ${level.label}`,
    `⬆️ До следующего уровня: ${level.toNext}`,
    shopText,
  ].join('\n');
}

function getLevelInfo(stars) {
  const tiers = [
    { min: 0, max: 19, label: 'Новичок' },
    { min: 20, max: 39, label: 'Стабильный' },
    { min: 40, max: 59, label: 'Молодец' },
    { min: 60, max: 79, label: 'Герой недели' },
    { min: 80, max: 1000, label: 'Легенда недели' },
  ];

  const tier = tiers.find((item) => stars >= item.min && stars <= item.max) || tiers[0];
  const nextTier = tiers.find((item) => item.min > tier.min);
  return {
    label: tier.label,
    toNext: nextTier ? `${Math.max(0, nextTier.min - stars)} ⭐️` : 'Максимум',
  };
}

function mainMenuKeyboard() {
  return inlineKeyboard([
    [
      { text: '👦 Аи', callback_data: 'player:player1' },
      { text: '👧 Сиси', callback_data: 'player:player2' },
    ],
    [
      { text: '🎁 Магазин', callback_data: 'menu:shop' },
      { text: '📜 История', callback_data: 'menu:history' },
    ],
  ]);
}

function playerMenuKeyboard(code) {
  return inlineKeyboard([
    [
      { text: '⭐️ Баланс', callback_data: `player_action:${code}:balance` },
      { text: '🏆 Прогресс', callback_data: `player_action:${code}:view` },
    ],
    [
      { text: '➕ Добавить', callback_data: `player_action:${code}:add` },
      { text: '➖ Снять', callback_data: `player_action:${code}:remove` },
    ],
    [
      { text: '🎁 Магазин', callback_data: `player_action:${code}:shop` },
      { text: '📜 История', callback_data: `player_action:${code}:history` },
    ],
    [
      { text: '🏠 Главное меню', callback_data: 'menu:main' },
    ],
  ]);
}

function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

async function sendMessage(chatId, text, replyMarkup, env) {
  return telegram(
    'sendMessage',
    {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    env
  );
}

async function answerCallbackQuery(callbackQueryId, env) {
  return telegram(
    'answerCallbackQuery',
    {
      callback_query_id: callbackQueryId,
    },
    env
  );
}

async function telegram(method, payload, env) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API ${method} failed: ${response.status} ${text}`);
  }

  return response.json();
}

async function listPlayers(env) {
  const goal = Number(env.LONG_TERM_GOAL || 1000);
  const result = await env.DB.prepare(`SELECT * FROM players ORDER BY id ASC`).all();
  return (result.results || []).map((player) => ({ ...player, long_term_goal: goal }));
}

async function getPlayerByCode(code, env) {
  const goal = Number(env.LONG_TERM_GOAL || 1000);
  const player = await env.DB.prepare(`SELECT * FROM players WHERE code = ?`).bind(code).first();
  return player ? { ...player, long_term_goal: goal } : null;
}

async function listShopItems(env) {
  const result = await env.DB.prepare(`SELECT * FROM shop_items WHERE active = 1 ORDER BY price ASC, id ASC`).all();
  return result.results || [];
}

async function insertPointEvent(playerId, delta, reason, eventType, env) {
  await env.DB.prepare(`INSERT INTO point_events (player_id, delta, reason, event_type) VALUES (?, ?, ?, ?)`).bind(playerId, delta, reason, eventType).run();
}

async function getSession(chatId, env) {
  const row = await env.DB.prepare(`SELECT state, payload_json FROM parent_sessions WHERE chat_id = ?`).bind(String(chatId)).first();
  if (!row) return null;
  return {
    state: row.state,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
  };
}

async function setSession(chatId, state, payload, env) {
  await env.DB.prepare(
    `INSERT INTO parent_sessions (chat_id, state, payload_json, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE SET
       state = excluded.state,
       payload_json = excluded.payload_json,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(String(chatId), state, JSON.stringify(payload || null)).run();
}

async function clearSession(chatId, env) {
  await env.DB.prepare(`DELETE FROM parent_sessions WHERE chat_id = ?`).bind(String(chatId)).run();
}

function formatDate(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

function getCurrentWeekKey() {
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function maybeRunWeeklyReset(env) {
  const currentWeekKey = getCurrentWeekKey();
  const row = await env.DB.prepare(`SELECT value FROM bot_state WHERE key = 'last_weekly_reset_key'`).first();
  const lastKey = row?.value || '';
  if (lastKey !== currentWeekKey) {
    await runWeeklyReset(env, currentWeekKey);
  }
}

async function runWeeklyReset(env, currentWeekKey = getCurrentWeekKey()) {
  const row = await env.DB.prepare(`SELECT value FROM bot_state WHERE key = 'last_weekly_reset_key'`).first();
  const lastKey = row?.value || '';
  if (lastKey === currentWeekKey) return;

  const players = await listPlayers(env);
  const weeklyStart = Number(env.WEEKLY_START_STARS || 30);

  for (const player of players) {
    if (lastKey) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO weekly_snapshots (player_id, week_key, ending_stars, lifetime_progress, recovery_mode, shop_locked)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(player.id, lastKey, player.weekly_stars, player.lifetime_progress, player.recovery_mode, player.shop_locked).run();
    }

    await env.DB.batch([
      env.DB.prepare(`UPDATE players SET weekly_stars = weekly_stars + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(weeklyStart, player.id),
      env.DB.prepare(`INSERT INTO point_events (player_id, delta, reason, event_type) VALUES (?, ?, ?, 'weekly_reset')`).bind(
        player.id,
        0,
        `Новый недельный цикл: начислен недельный бонус +${weeklyStart} ⭐️`
      ),
    ]);
  }

  await env.DB.prepare(
    `INSERT INTO bot_state (key, value, updated_at)
     VALUES ('last_weekly_reset_key', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).bind(currentWeekKey).run();
}
