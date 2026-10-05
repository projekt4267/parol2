const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
require('dotenv').config();

const config = {
  host: process.env.HOST || 'localhost',
  port: Number(process.env.PORT || 25565),
  username: process.env.USERNAME || 'MineBot',
  version: process.env.VERSION || '1.20.4',
  auth: (process.env.AUTH || 'offline').toLowerCase(),
  password: process.env.PASSWORD || undefined,
  autoSayHello: process.env.AUTO_SAY_HELLO === 'true',
  commandPrefix: process.env.COMMAND_PREFIX || '!',
  reconnectDelayMs: Number(process.env.RECONNECT_DELAY_MS || 5000),
  llmProvider: (process.env.LLM_PROVIDER || 'ollama').toLowerCase(),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.1:8b',
  openAiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini'
};

const TREE_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'log'
];
const ORE_NAMES = [
  'coal_ore', 'iron_ore', 'gold_ore', 'redstone_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore', 'copper_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_diamond_ore',
  'deepslate_emerald_ore', 'deepslate_lapis_ore', 'deepslate_copper_ore'
];

if (config.auth !== 'offline' && !config.password) {
  console.warn('[BOT] WARNING: AUTH is not offline, but PASSWORD is empty.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateAiReply(username, message) {
  const cleanedMessage = String(message || '').trim();

  if (!cleanedMessage) {
    return null;
  }

  if (config.llmProvider === 'ollama') {
    try {
      const response = await fetch(`${config.ollamaBaseUrl.replace(/\/$/, '')}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollamaModel,
          prompt: `Ты Minecraft-бот на русском. Отвечай кратко, живо и в стиле игрового помощника. Игрок ${username} говорит: ${cleanedMessage}`,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9
          }
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.response ? String(data.response).trim() : null;
    } catch (error) {
      console.error('[BOT] Ollama error:', error.message || error);
      return null;
    }
  }

  if (config.llmProvider === 'openai' && config.openAiKey) {
    try {
      const OpenAI = require('openai');
      const client = new OpenAI({ apiKey: config.openAiKey });
      const completion = await client.chat.completions.create({
        model: config.openAiModel,
        messages: [
          { role: 'system', content: 'Ты Minecraft-бот. Отвечай кратко и по-русски.' },
          { role: 'user', content: `Игрок ${username} пишет: ${cleanedMessage}` }
        ],
        temperature: 0.7,
        max_tokens: 180
      });

      return completion.choices?.[0]?.message?.content?.trim() || null;
    } catch (error) {
      console.error('[BOT] OpenAI error:', error.message || error);
      return null;
    }
  }

  return null;
}

function stopMovement(bot) {
  bot.setControlState('forward', false);
  bot.setControlState('back', false);
  bot.setControlState('left', false);
  bot.setControlState('right', false);
  bot.setControlState('jump', false);
  bot.setControlState('sprint', false);
}

function moveToward(bot, targetPos, { distance = 2, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();

    const tick = () => {
      if (!bot.entity) {
        stopMovement(bot);
        resolve();
        return;
      }

      const current = bot.entity.position;
      const dx = targetPos.x - current.x;
      const dz = targetPos.z - current.z;
      const d = Math.hypot(dx, dz);

      if (d <= distance || Date.now() - start > timeoutMs) {
        stopMovement(bot);
        resolve();
        return;
      }

      bot.lookAt(new Vec3(targetPos.x, targetPos.y, targetPos.z));
      bot.setControlState('forward', true);
      if (d > 5) {
        bot.setControlState('sprint', true);
      } else {
        bot.setControlState('sprint', false);
      }

      setTimeout(tick, 200);
    };

    tick();
  });
}

async function findNearestBlock(bot, names, maxDistance = 20, count = 8) {
  const positions = bot.findBlocks({
    matching: (block) => !!block && names.includes(block.name),
    maxDistance,
    count
  });

  if (!positions || positions.length === 0) {
    return null;
  }

  positions.sort((a, b) => {
    const da = bot.entity.position.distanceTo(new Vec3(a.x + 0.5, a.y + 0.5, a.z + 0.5));
    const db = bot.entity.position.distanceTo(new Vec3(b.x + 0.5, b.y + 0.5, b.z + 0.5));
    return da - db;
  });

  const pos = positions[0];
  return bot.blockAt(pos);
}

async function mineNearestBlock(bot, names, { maxDistance = 20, count = 8, label = 'resource' } = {}) {
  const block = await findNearestBlock(bot, names, maxDistance, count);

  if (!block) {
    return false;
  }

  const target = new Vec3(block.position.x + 0.5, block.position.y + 0.5, block.position.z + 0.5);
  await moveToward(bot, target, { distance: 2.2, timeoutMs: 30000 });
  bot.chat(`Иду добывать ${label}: ${block.name} в ${block.position.x}, ${block.position.y}, ${block.position.z}`);
  await bot.dig(block, true);
  return true;
}

async function chopTree(bot) {
  const logCount = bot.inventory.items().filter((item) => TREE_NAMES.includes(item.name) || item.name === 'log').length;
  if (logCount >= 8) {
    return false;
  }

  return mineNearestBlock(bot, TREE_NAMES, { maxDistance: 24, count: 10, label: 'дерево' });
}

async function mineOre(bot) {
  const itemCount = bot.inventory.items().filter((item) => item && item.count > 0).length;
  if (itemCount > 20) {
    return false;
  }

  return mineNearestBlock(bot, ORE_NAMES, { maxDistance: 18, count: 10, label: 'руду' });
}

async function attackNearestMob(bot) {
  const mobs = Object.values(bot.entities)
    .filter((entity) => entity.type === 'mob' && entity.position.distanceTo(bot.entity.position) < 10)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

  if (!mobs.length) {
    return false;
  }

  const target = mobs[0];
  bot.chat(`Атакую ${target.name} в ${Math.round(target.position.distanceTo(bot.entity.position))} блоках.`);
  await bot.lookAt(target.position.offset(0, 1, 0));
  bot.attack(target);
  return true;
}

async function buildSimplePlatform(bot) {
  const blockItem = bot.inventory.items().find((item) => ['dirt', 'cobblestone', 'stone', 'planks'].includes(item.name));

  if (!blockItem) {
    bot.chat('У меня нет блоков для строительства.');
    return false;
  }

  const reference = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  if (!reference) {
    bot.chat('Слишком близко к пустоте для постройки.');
    return false;
  }

  try {
    await bot.equip(blockItem, 'hand');
    await bot.placeBlock(reference, new Vec3(0, 1, 0));
    bot.chat('Поставил простой блок рядом.');
    return true;
  } catch (error) {
    console.error('[BOT] Build error:', error.message || error);
    return false;
  }
}

async function exploreArea(bot) {
  const direction = Math.random() > 0.5 ? 1 : -1;
  const turnSteps = [0, 90, -90, 180];
  const angle = turnSteps[Math.floor(Math.random() * turnSteps.length)];

  bot.look(bot.yaw + Math.PI / 180 * angle, bot.pitch);
  bot.setControlState('forward', true);
  await sleep(2500);
  stopMovement(bot);
  await sleep(300);
  return true;
}

function handleCustomCommand(bot, username, commandText) {
  const lower = commandText.trim().toLowerCase();

  if (lower === `${config.commandPrefix}help`) {
    bot.chat(`Команды: ${config.commandPrefix}help, ${config.commandPrefix}mine, ${config.commandPrefix}explore, ${config.commandPrefix}build, ${config.commandPrefix}attack, ${config.commandPrefix}status, ${config.commandPrefix}ai`);
    return;
  }

  if (lower === `${config.commandPrefix}status`) {
    bot.chat(`Я онлайн, ник: ${bot.username}. В игре: ${bot.game?.title || 'Minecraft'}.`);
    return;
  }

  if (lower === `${config.commandPrefix}mine`) {
    bot.chat('Начинаю добычу.');
    mineNearestBlock(bot, TREE_NAMES.concat(ORE_NAMES), { maxDistance: 24, count: 12, label: 'ресурс' });
    return;
  }

  if (lower === `${config.commandPrefix}explore`) {
    bot.chat('Начинаю исследование территории.');
    exploreArea(bot);
    return;
  }

  if (lower === `${config.commandPrefix}build`) {
    buildSimplePlatform(bot);
    return;
  }

  if (lower === `${config.commandPrefix}attack`) {
    bot.chat('Ищу ближайшего моба.');
    attackNearestMob(bot);
    return;
  }

  if (lower === `${config.commandPrefix}ai`) {
    generateAiReply(username, 'что ты умеешь?').then((reply) => {
      bot.chat(reply || 'Я умею исследовать, добывать ресурсы и отвечать в чате.');
    });
    return;
  }

  if (lower === `${config.commandPrefix}quit`) {
    bot.chat('Выключаюсь...');
    bot.quit();
    return;
  }
}

function createBot() {
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
    auth: config.auth,
    password: config.password,
    keepAlive: true,
    checkTimeoutInterval: 30000,
    reconnectInterval: 1000
  });

  const send = (message) => {
    if (bot && bot.chat) {
      bot.chat(message);
    }
  };

  async function autoRoutine() {
    while (true) {
      if (!bot.entity) {
        await sleep(1000);
        continue;
      }

      const worked = await chopTree(bot);
      if (worked) {
        await sleep(3000);
        continue;
      }

      const minedOre = await mineOre(bot);
      if (minedOre) {
        await sleep(3000);
        continue;
      }

      const attacked = await attackNearestMob(bot);
      if (attacked) {
        await sleep(2000);
        continue;
      }

      await exploreArea(bot);
      await sleep(1500);
    }
  }

  bot.on('connect', () => {
    console.log(`[BOT] Подключился к ${config.host}:${config.port}`);
  });

  bot.on('spawn', () => {
    console.log(`[BOT] Спавн произошёл. Ник: ${bot.username}`);
    if (config.autoSayHello) {
      send('Привет, мир! Я бот-исследователь и добытчик.');
    }
    autoRoutine().catch((error) => console.error('[BOT] autoRoutine error:', error.message || error));
  });

  bot.on('chat', async (username, message) => {
    console.log(`[CHAT] ${username}: ${message}`);

    if (username === bot.username) {
      return;
    }

    const text = message.trim();
    const lower = text.toLowerCase();

    if (text.startsWith(config.commandPrefix)) {
      handleCustomCommand(bot, username, text);
      return;
    }

    if (lower.includes('привет') || lower.includes('hi') || lower.includes('hello')) {
      send(`Привет, ${username}! Я бот, могу добывать, исследовать и строить.`);
      return;
    }

    if (lower.includes('копай') || lower.includes('mine') || lower.includes('добывай')) {
      mineNearestBlock(bot, TREE_NAMES.concat(ORE_NAMES), { maxDistance: 24, count: 12, label: 'ресурс' });
      return;
    }

    if (lower.includes('строй') || lower.includes('build')) {
      buildSimplePlatform(bot);
      return;
    }

    if (lower.includes('идем') || lower.includes('explore') || lower.includes('исследуй')) {
      exploreArea(bot);
      return;
    }

    const reply = await generateAiReply(username, text);
    if (reply) {
      send(reply);
    } else {
      send('Я бот-исследователь. Напиши !help, чтобы посмотреть команды.');
    }
  });

  bot.on('kicked', (reason, loggedIn) => {
    console.error(`[BOT] Кик: ${reason}`);
    console.error(`[BOT] loggedIn: ${loggedIn}`);
  });

  bot.on('error', (err) => {
    console.error(`[BOT] Ошибка: ${err.message || err}`);
  });

  bot.on('end', (reason) => {
    console.log(`[BOT] Отключился: ${reason}`);
    setTimeout(() => {
      console.log('[BOT] Переподключение...');
      createBot();
    }, config.reconnectDelayMs);
  });

  return bot;
}

const bot = createBot();

process.on('SIGINT', () => {
  console.log('[BOT] Завершение по SIGINT');
  bot.quit();
  process.exit(0);
});
