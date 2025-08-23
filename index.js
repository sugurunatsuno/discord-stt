// index.js (verbose logging + ffprobe fallback + delete WAV after STT)
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, EndBehaviorType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';

const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token || token.split('.').length !== 3) {
  console.error('[BOOT] ❌ DISCORD_TOKEN invalid. Check .env (no "Bot ", no quotes).');
  process.exit(1);
}

const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID || '';
const DEBUG = process.env.DEBUG_AUDIO === '1';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase(); // 'debug' | 'info' | 'warn' | 'error'
const LOG_FILE = process.env.LOG_FILE || 'app.log';
const MIN_DUR_SEC = parseFloat(process.env.MIN_DUR_SEC || '0.6');
const MIN_TEXT_CHARS = parseInt(process.env.MIN_TEXT_CHARS || '3', 10);
const DEDUP_WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS || '30000', 10);

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
process.on('exit', () => logStream.end());

// ★ 削除ポリシー
const DELETE_WAV = process.env.DELETE_WAV === '1';                 // STT後にWAV削除
const DELETE_WAV_ON_SKIP = (process.env.DELETE_WAV_ON_SKIP ?? '1') === '1'; // スキップ時も削除
const KEEP_WAV_ON_ERROR = (process.env.KEEP_WAV_ON_ERROR ?? '1') === '1';   // エラー時は保持

const ffmpegBin = ffmpegPath || 'ffmpeg';
function getFFprobeBin() { return 'ffprobe'; } // システムのffprobeを期待

function now() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, msg, meta = {}) {
  if ((levels[level] ?? 999) < (levels[LOG_LEVEL] ?? 20)) return;
  const line = `[${now()}] [${level.toUpperCase()}] ${msg}`;
  if (Object.keys(meta).length) console.log(line, JSON.stringify(meta));
  else console.log(line);
  logStream.write(line + (Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '') + '\n');
}

if (!TEXT_CHANNEL_ID) {
  log('warn', 'DISCORD_TEXT_CHANNEL_ID not set. Will SKIP posting to Discord.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.GuildMember],
});

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('今いるVCに参加'),
  new SlashCommandBuilder().setName('leave').setDescription('VCから退出'),
  new SlashCommandBuilder().setName('start').setDescription('録音開始'),
  new SlashCommandBuilder().setName('stop').setDescription('録音停止'),
].map(c => c.toJSON());

client.once('clientReady', async () => {
  log('info', `Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
  }
  log('info', 'Slash commands registered');
});

// ===== State =====
/** guildId -> { receiver, subs:Map<userId,Sub>, isRecording:boolean, onSpeakingStart:fn } */
const recordingState = new Map();
/** userKey -> { text, ts } (dedup) */
const recentTextCache = new Map();
const nameCache = new Map();

async function getDisplayName(guild, userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  try {
    const m = await guild.members.fetch(userId);
    const name = (m.nickname || m.user.globalName || m.user.username || userId);
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    nameCache.set(userId, safe);
    return safe;
  } catch {
    return userId;
  }
}
function tsCompact() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  const gid = i.guild?.id;

  try {
    if (i.commandName === 'join') {
      const member = await i.guild.members.fetch(i.user.id);
      const vc = member.voice.channel;
      if (!vc) return i.reply({ content: 'まずボイスチャンネルに入ってください。', ephemeral: true });
      const conn = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator,
        selfDeaf: false, selfMute: true,
      });
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      log('info', '/join: connected', { guildId: gid, channelId: vc.id });
      i.reply('参加しました！ `/start` で録音を開始できます。');

    } else if (i.commandName === 'leave') {
      hardStop(gid);
      const conn = getVoiceConnection(gid);
      if (conn) { conn.destroy(); log('info', '/leave: destroyed connection', { guildId: gid }); }
      i.reply('退出しました！');

    } else if (i.commandName === 'start') {
      const conn = getVoiceConnection(gid);
      if (!conn) return i.reply({ content: '`/join` で先に参加してください。', ephemeral: true });
      const state = recordingState.get(gid);
      if (state?.isRecording) return i.reply({ content: 'すでに録音中です。`/stop` で停止してください。', ephemeral: true });
      startRecording(i);

    } else if (i.commandName === 'stop') {
      hardStop(gid);
      i.reply('録音を完全に停止しました！（リスナー解除・処理中断）');
    }
  } catch (e) {
    console.error(e);
    if (i.replied || i.deferred) i.followUp('エラーが発生しました。コンソールをご確認ください。');
    else i.reply('エラーが発生しました。コンソールをご確認ください。');
  }
});

function startRecording(i) {
  const gid = i.guild.id;
  const conn = getVoiceConnection(gid);
  const receiver = conn.receiver;

  // detach old listener if any
  const prev = recordingState.get(gid);
  if (prev?.onSpeakingStart) {
    try { receiver.speaking.off('start', prev.onSpeakingStart); } catch {}
    log('debug', 'Detached previous speaking listener', { guildId: gid });
  }

  const subs = new Map();
  const state = { receiver, subs, isRecording: true, onSpeakingStart: null };
  recordingState.set(gid, state);

  state.onSpeakingStart = async (userId) => {
    if (!state.isRecording) { log('debug', 'speaking ignored (not recording)', { guildId: gid, userId }); return; }
    if (subs.has(userId)) { log('debug', 'already recording this user, skip', { userId }); return; }

    const who = await getDisplayName(i.guild, userId);
    const today = new Date().toISOString().slice(0,10);
    const userDir = path.join('recordings', today, who);
    fs.mkdirSync(userDir, { recursive: true });

    const chunkId = `${who}-${tsCompact()}`;
    const filename = path.join(userDir, `${chunkId}.wav`);
    log('info', 'start chunk', { chunkId, userId, file: filename });

    // subscribe opus
    const opusStream = state.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 3000 }
    });

    const { opus } = await import('prism-media');
    const decoder = new opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });

    const pcmTap = new PassThrough();
    const ff = spawn(ffmpegBin, [
      '-hide_banner',
      '-f', 's16le', '-ar', '48000', '-ac', '1',
      '-i', 'pipe:0',
      '-c:a', 'pcm_s16le',
      filename
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    ff.on('spawn', () => log('debug', 'ffmpeg spawned', { chunkId, ffmpeg: ff.spawnfile }));
    ff.stderr.on('data', d => DEBUG && process.stderr.write(`[ffmpeg][${chunkId}] ${d}`));
    ff.on('error', (e) => log('error', 'ffmpeg error', { chunkId, err: String(e) }));

    opusStream.on('error', (e) => log('error', 'opusStream error', { chunkId, err: String(e) }));
    decoder.on('error', (e) => log('error', 'decoder error', { chunkId, err: String(e) }));

    // Wire pipes
    opusStream.pipe(decoder).pipe(pcmTap).pipe(ff.stdin);

    const closeSafely = () => {
      log('debug', 'closeSafely called', { chunkId });
      try { pcmTap.unpipe(ff.stdin); } catch {}
      try { ff.stdin.end(); } catch {}
    };
    opusStream.once('end', () => { log('debug', 'opusStream end', { chunkId }); closeSafely(); });
    opusStream.once('close', () => { log('debug', 'opusStream close', { chunkId }); closeSafely(); });

    ff.on('close', async (code) => {
      log('info', 'ffmpeg closed', { chunkId, code, file: filename });
      subs.delete(userId);

      try {
        const stat = fs.statSync(filename);
        log('debug', 'file stat', { chunkId, size: stat.size });
        if (stat.size < 200) {
          fs.unlinkSync(filename);
          log('warn', 'deleted tiny file (<200B)', { chunkId });
          return;
        }
        enqueueSTT({ file: filename, user: who, chunkId, channelId: TEXT_CHANNEL_ID });
      } catch (e) {
        log('error', 'file stat failed', { chunkId, err: String(e) });
      }
    });

    const rotateTimer = setTimeout(() => {
      log('info', 'rotation timeout: closing ffmpeg', { chunkId });
      closeSafely();
      subs.delete(userId);
    }, 5 * 60 * 1000);

    subs.set(userId, { ff, filename, rotateTimer, chunkId });
  };

  state.receiver.speaking.on('start', state.onSpeakingStart);
  log('info', '/start: recording enabled', { guildId: gid });
  i.reply('録音開始！（詳細ログON）');
}

function hardStop(guildId) {
  const state = recordingState.get(guildId);
  if (!state) { log('debug', 'hardStop: no state', { guildId }); return; }
  state.isRecording = false;

  if (state.onSpeakingStart) {
    try { state.receiver.speaking.off('start', state.onSpeakingStart); } catch {}
    log('debug', 'speaking listener removed', { guildId });
    state.onSpeakingStart = null;
  }

  for (const [_, sub] of state.subs) {
    clearTimeout(sub.rotateTimer);
    try { sub.ff.stdin.end(); } catch {}
    log('debug', 'ended ffmpeg stdin for active sub', { guildId, chunkId: sub.chunkId });
  }
  state.subs.clear();
  recordingState.delete(guildId);
  log('info', 'recording disabled', { guildId });
}

// ===== STT queue =====
const sttQueue = [];
let sttBusy = false;

function enqueueSTT(job) {
  log('info', 'enqueue STT', { chunkId: job.chunkId, file: job.file });
  sttQueue.push(job);
  if (!sttBusy) runNextSTT();
}

async function runNextSTT() {
  if (sttQueue.length === 0) { sttBusy = false; return; }
  sttBusy = true;
  const job = sttQueue.shift();
  const { file, user, channelId, chunkId } = job;

  try {
    const dur = await probeDuration(file, chunkId);
    if (dur != null) {
      log('debug', 'duration check', { chunkId, duration: dur, threshold: MIN_DUR_SEC });
      if (dur < MIN_DUR_SEC) {
        log('info', 'skip: too short duration', { chunkId, dur, MIN_DUR_SEC });
        if (DELETE_WAV && DELETE_WAV_ON_SKIP) safeDeleteWav(file, chunkId, 'short-duration');
        return;
      }
    } else {
      log('info', 'duration unknown -> do STT and decide by text', { chunkId });
    }

    const text = await runSTT(file, chunkId);
    const normalized = normalizeText(text);
    log('debug', 'STT result', { chunkId, len: text.length, normLen: normalized.length });

    // 無音/短文スキップ
    if (!normalized || normalized.length < MIN_TEXT_CHARS) {
      log('info', 'skip: empty/short text', { chunkId, MIN_TEXT_CHARS });
      if (DELETE_WAV && DELETE_WAV_ON_SKIP) safeDeleteWav(file, chunkId, 'short-text');
      return;
    }

    // 重複スキップ
    const key = `${user}`;
    const last = recentTextCache.get(key);
    const nowMs = Date.now();
    if (last && last.text === normalized && (nowMs - last.ts) < DEDUP_WINDOW_MS) {
      log('info', 'skip: dedup window', { chunkId, windowMs: DEDUP_WINDOW_MS });
      if (DELETE_WAV && DELETE_WAV_ON_SKIP) safeDeleteWav(file, chunkId, 'dedup');
      return;
    }
    recentTextCache.set(key, { text: normalized, ts: nowMs });

    // 投稿（チャンネル未設定でもSTT自体は成功なので削除対象にできる）
    if (channelId) {
      const chan = await client.channels.fetch(channelId).catch((e) => {
        log('error', 'fetch channel failed', { chunkId, err: String(e) });
        return null;
      });
      if (chan && chan.isTextBased()) {
        const jst = now();
        await chan.send(`${jst} JST\n🎙️ **${user}**\n> ${text.replace(/\n+/g, ' ')}`);
        log('info', 'posted to discord', { chunkId, channelId });
      } else {
        log('warn', 'channel not text-based or null; skipping post', { chunkId, channelId });
      }
    } else {
      log('warn', 'no channelId; skipping post', { chunkId });
    }

    // ★ STT成功（投稿の成否は問わず）→ WAV削除
    if (DELETE_WAV) safeDeleteWav(file, chunkId, 'stt-done');

  } catch (e) {
    log('error', 'STT job failed', { chunkId, err: String(e) });
    if (DELETE_WAV && !KEEP_WAV_ON_ERROR) safeDeleteWav(file, chunkId, 'error');
    // 失敗時は簡易リトライ
    job.retries = (job.retries || 0) + 1;
    if (job.retries <= 2) {
      log('warn', 'retrying STT', { chunkId, attempt: job.retries });
      sttQueue.unshift(job);
    }
  } finally {
    runNextSTT();
  }
}

function runSTT(filepath, chunkId) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      WHISPER_MODEL: process.env.WHISPER_MODEL || 'large-v3-turbo',
      WHISPER_DEVICE: process.env.WHISPER_DEVICE || 'cpu',
      WHISPER_PRECISION: process.env.WHISPER_PRECISION || 'int8',
      WHISPER_LANG: process.env.WHISPER_LANG || 'ja',
      WHISPER_VAD_MS: process.env.WHISPER_VAD_MS || '600',
    };
    log('debug', 'exec stt.py', { chunkId, file: filepath });
    execFile('python3', ['stt.py', filepath], { cwd: process.cwd(), env }, (err, stdout, stderr) => {
      if (stderr && LOG_LEVEL === 'debug') process.stderr.write(`[stt.py][${chunkId}] ${stderr}\n`);
      if (err) {
        log('error', 'stt.py error', { chunkId, err: String(err) });
        return reject(err);
      }
      try {
        const raw = (stdout || '').toString().trim();
        if (LOG_LEVEL === 'debug') log('debug', 'stt.py stdout', { chunkId, raw });
        const j = JSON.parse(raw || '{}');
        if (!j.ok) return reject(new Error(j.error || 'unknown'));
        resolve((j.text || '').trim());
      } catch (e) {
        log('error', 'stt.py parse failed', { chunkId, err: String(e) });
        reject(e);
      }
    });
  });
}

// WAV duration estimate fallback (48kHz / mono / 16bit PCM, header ~44B)
function estimateWavDurationPCM(file) {
  try {
    const stat = fs.statSync(file);
    const header = 44;
    const bytes = Math.max(0, stat.size - header);
    const bytesPerSec = 48000 * 2 * 1; // sampleRate * bytesPerSample(16bit=2) * channels(1)
    const dur = bytes / bytesPerSec;
    return isFinite(dur) ? dur : null;
  } catch {
    return null;
  }
}

async function probeDuration(file, chunkId) {
  // 1) try ffprobe
  try {
    const ffprobe = getFFprobeBin();
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '-i', file];
    const p = spawn(ffprobe, args);
    let out = '', err = '';
    const code = await new Promise((res) => {
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => err += d);
      p.on('close', res);
      p.on('error', () => res(-1));
    });
    const v = parseFloat(out);
    if (isFinite(v) && v > 0) {
      log('debug', 'ffprobe ok', { chunkId, duration: v });
      return v;
    } else {
      if (code !== 0) log('warn', 'ffprobe failed', { chunkId, code, err: err?.toString().slice(0,200) });
      else log('warn', 'ffprobe returned 0/NaN', { chunkId, raw: out.trim() });
    }
  } catch (e) {
    log('warn', 'ffprobe spawn error', { chunkId, err: String(e) });
  }
  // 2) fallback: estimate from WAV size
  const est = estimateWavDurationPCM(file);
  if (est != null) {
    log('debug', 'duration estimated by size', { chunkId, duration: est });
    return est;
  }
  // 3) unknown -> return null to allow STT run
  log('warn', 'duration unknown, will run STT anyway', { chunkId });
  return null;
}

function normalizeText(s) {
  if (!s) return '';
  return s
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[。、．，・!！?？…—\-\(\)\[\]{}"'「」『』:：;；、｡､・〜~^]/g, '')
    .trim()
    .toLowerCase();
}

// 安全にWAV削除
function safeDeleteWav(wavPath, chunkId, reason) {
  try { fs.unlinkSync(wavPath); log('debug', 'wav deleted', { chunkId, wav: wavPath, reason }); }
  catch (e) { log('warn', 'wav delete failed', { chunkId, err: String(e) }); }
}

client.login(token);
