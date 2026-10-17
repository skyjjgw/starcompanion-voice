// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors
import {
  VOICE_LIMITS,
  type AudioSegment, type CancelResult, type ChatChoice, type InspectResult,
  type NativeReceipt, type NativeSendEvent, type ReplyReceipt, type VoiceChoice,
  type VoiceDependencies, type VoiceError, type VoiceRequest, type VoiceResponse,
  type VoiceSnapshot, type VoiceTurnSnapshot, type VoiceValue,
} from "./protocol";

// The ToolPkg JavaScript runtime supplies these timers; the SDK's host-only library omits DOM types.
declare function setTimeout(handler: () => void, milliseconds: number): string;
declare function clearTimeout(handle: string): void;

class VoiceFault extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}
const fault = (code: string, message: string, retryable = false): never => { throw new VoiceFault(code, message, retryable); };
const stale = (): never => fault("STALE_RESULT", "本轮已结束，迟到结果已丢弃。");

/** Fixed diagnostics identify the SDK boundary without publishing provider error strings. */
function streamFailure(error: unknown, stage: "create" | "pull" | "event" | "subtitle" | "receipt"): VoiceFault {
  const messages: string[] = [];
  let candidate: unknown = error;
  for (let depth = 0; depth < 3 && candidate !== null && typeof candidate === "object"; depth++) {
    const failure = candidate as { message?: unknown; cause?: unknown };
    if (typeof failure.message === "string") messages.push(failure.message);
    candidate = failure.cause;
  }
  const message = messages.join("\n");
  const category = /execution state (?:is )?unavailable|execution.*context.*(released|unavailable)|active.*call/i.test(message) ? "CONTEXT"
    : /observation and disposal both failed/i.test(message) ? "DISPOSAL"
    : /unknown chat observation/i.test(message) ? "OBSERVATION"
    : /only one pending next/i.test(message) ? "CONCURRENT_PULL" : stage.toUpperCase();
  const code = `CHAT_STREAM_${category}_FAILED`;
  return new VoiceFault(code, `原会话回复的接收或完成确认失败（${code}）；请返回原聊天查看已保存内容，不会自动重复发送。`, true);
}

function publicError(error: unknown, stage: "request" | "chat" | "stt" | "tts" | "cancel" = "request"): VoiceError {
  if (error instanceof VoiceFault) return { code: error.code, message: error.message, retryable: error.retryable };
  // Provider errors may contain request URLs or credentials. Return only fixed, recognized explanations.
  const message = error instanceof Error ? error.message : "";
  if (stage === "stt") return { code: "STT_UNAVAILABLE", message: /config|selected|配置/i.test(message) ? "未选择可用的语音识别配置，请先在 Operit 中配置 STT。" : "语音识别失败，请检查识别配置或网络后重试。", retryable: true };
  if (stage === "tts") return { code: "TTS_UNAVAILABLE", message: /config|selected|配置/i.test(message) ? "当前声音未配置或已失效，请选择可用的 TTS 配置；文字回复仍保留。" : "语音合成失败，请检查声音配置或网络；文字回复仍保留。", retryable: true };
  if (stage === "cancel") return { code: "CANCEL_UNCONFIRMED", message: "本地已停止等待，但未确认原会话执行已取消。", retryable: true };
  if (/explicit execution participant|planned conversation/i.test(message)) return { code: "PARTICIPANT_REQUIRED", message: "此会话需要明确选择群组成员；当前通话入口仅支持单角色会话。", retryable: false };
  if (/in use|already.*active|execution.*active|busy/i.test(message)) return { code: "CHAT_BUSY", message: "原会话仍有执行未结束，请稍后重试。", retryable: true };
  return { code: stage === "chat" ? "CHAT_FAILED" : "HOST_UNAVAILABLE", message: stage === "chat" ? "原会话回复失败，请检查聊天模型及工具权限；不会自动重复发送本轮。" : "无法读取 Operit 当前配置，请稍后重试。", retryable: true };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fault("INVALID_REQUEST", "请求必须是 JSON 对象。");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return fault("INVALID_REQUEST", `${name} 格式无效。`);
  return value;
}
function chatId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > 256) return fault("INVALID_REQUEST", "请选择真实会话。");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > VOICE_LIMITS.maxTextCharacters) return fault("INVALID_TEXT", "文字不能为空，且不能超过 8000 个字符。");
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[], required: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fault("INVALID_REQUEST", "请求字段缺失或包含不支持的字段。");
}
function parse(payload: unknown): VoiceRequest {
  const value = object(payload);
  switch (value.op) {
    case "inspect":
      keys(value, ["op", "chatId", "listChats"], ["op"]);
      if (value.chatId !== undefined && value.chatId !== null) chatId(value.chatId);
      if (value.listChats !== undefined && typeof value.listChats !== "boolean") fault("INVALID_REQUEST", "listChats 必须是布尔值。");
      break;
    case "open":
      keys(value, ["op", "callId", "chatId", "ttsConfigId"], ["op", "callId", "chatId"]);
      identifier(value.callId, "callId"); chatId(value.chatId);
      if (value.ttsConfigId !== undefined && value.ttsConfigId !== null) chatId(value.ttsConfigId);
      break;
    case "transcribe": keys(value, ["op", "callId", "turnId", "wav"], ["op", "callId", "turnId", "wav"]); identifier(value.callId, "callId"); identifier(value.turnId, "turnId"); break;
    case "reply": keys(value, ["op", "callId", "turnId", "text"], ["op", "callId", "turnId", "text"]); identifier(value.callId, "callId"); identifier(value.turnId, "turnId"); text(value.text); break;
    case "speak": keys(value, ["op", "callId", "turnId", "text"], ["op", "callId", "turnId"]); identifier(value.callId, "callId"); identifier(value.turnId, "turnId"); if (value.text !== undefined) text(value.text); break;
    case "poll": keys(value, ["op", "callId"], ["op", "callId"]); identifier(value.callId, "callId"); break;
    case "cancel": case "close": keys(value, ["op", "callId", "turnId"], ["op", "callId"]); identifier(value.callId, "callId"); if (value.turnId !== undefined) identifier(value.turnId, "turnId"); break;
    default: return fault("INVALID_REQUEST", "不支持的通话操作。");
  }
  return value as unknown as VoiceRequest;
}

/** Checks actual RIFF chunks, not merely a WAV filename or a fabricated duration field. */
export function validateWav(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 44 || value.length > VOICE_LIMITS.maxWavBytes || !value.every(byte => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255)) return fault("INVALID_AUDIO", "录音必须是有效的 16kHz 单声道 PCM16 WAV，最长 15 秒。");
  const bytes = Uint8Array.from(value as number[]), view = new DataView(bytes.buffer);
  const label = (offset: number): string => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (label(0) !== "RIFF" || label(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) return fault("INVALID_AUDIO", "WAV 文件长度或文件头无效。");
  let offset = 12, formatSeen = false, dataSeen = false;
  while (offset + 8 <= bytes.length) {
    const kind = label(offset), length = view.getUint32(offset + 4, true), begin = offset + 8, end = begin + length;
    if (end > bytes.length) return fault("INVALID_AUDIO", "WAV 数据块不完整。");
    if (kind === "fmt ") {
      if (formatSeen || length < 16 || view.getUint16(begin, true) !== 1 || view.getUint16(begin + 2, true) !== 1 || view.getUint32(begin + 4, true) !== 16000 || view.getUint32(begin + 8, true) !== 32000 || view.getUint16(begin + 12, true) !== 2 || view.getUint16(begin + 14, true) !== 16) return fault("INVALID_AUDIO", "只支持 16kHz 单声道 PCM16 WAV 录音。");
      formatSeen = true;
    } else if (kind === "data") {
      if (dataSeen || length === 0 || length % 2 !== 0 || length > 480000) return fault("INVALID_AUDIO", "录音为空、格式无效或超过 15 秒。");
      dataSeen = true;
    }
    offset = end + (length % 2);
  }
  if (!formatSeen || !dataSeen || offset !== bytes.length) return fault("INVALID_AUDIO", "WAV 缺少有效音频数据。");
  return Array.from(bytes);
}

interface TurnState extends VoiceTurnSnapshot {
  sttStarted: boolean; replyStarted: boolean; ttsStarted: boolean;
  messageTimestamp: number | null; messageRevisions: Map<number, number>;
}
interface CallState {
  callId: string; chatId: string; generation: number; voiceMode: "global" | "manual";
  tts: VoiceChoice | null; ttsError: VoiceError | null; turn: TurnState | null;
}
interface ReplyJob {
  call: CallState; turn: TurnState; iterator: AsyncIterator<NativeSendEvent> | null;
  pending: Promise<IteratorResult<NativeSendEvent>> | null;
  terminal: boolean; settling: boolean; cleanup: Promise<void> | null;
  disposal: Promise<void> | null;
}

export function createHostService(dependencies: VoiceDependencies) {
  const calls = new Map<string, CallState>();
  const openings = new Map<string, { cancelled: boolean; chatId: string }>();
  const closedCalls = new Set<string>();
  const replies = new Map<string, ReplyJob>();
  let generation = 0;
  const timeouts = { inspect: 15000, stt: 60000, reply: 180000, tts: 60000, cancel: 10000, ...dependencies.timeouts };
  async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new VoiceFault("TIMEOUT", "等待超时，本地已停止等待；远端请求可能仍在结束中。", true)), milliseconds); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const selectedCall = (id: string): CallState => calls.get(id) ?? fault("CALL_CLOSED", "通话已关闭，请重新连接。");
  function snapshot(call: CallState): VoiceSnapshot {
    const turn = call.turn;
    return { callId: call.callId, chatId: call.chatId, generation: call.generation, voiceMode: call.voiceMode, tts: call.tts === null ? null : { ...call.tts }, ttsError: call.ttsError === null ? null : { ...call.ttsError }, replySettling: replies.get(call.chatId)?.call === call, turn: turn === null ? null : { turnId: turn.turnId, generation: turn.generation, phase: turn.phase, transcript: turn.transcript, subtitle: turn.subtitle, revision: turn.revision, replyText: turn.replyText, error: turn.error === null ? null : { ...turn.error } } };
  }
  const current = (call: CallState, turn: TurnState): boolean => calls.get(call.callId) === call && call.turn === turn && call.generation === turn.generation;
  function check(call: CallState, turn: TurnState): void { if (!current(call, turn)) stale(); }
  function turnFor(call: CallState, id: string): TurnState {
    if (call.turn?.turnId === id) {
      check(call, call.turn);
      if (call.turn.phase === "cancelled" || call.turn.phase === "error") return fault("TURN_ENDED", "此轮已结束，请开始新一轮。");
      return call.turn;
    }
    if (replies.has(call.chatId) || (call.turn !== null && ["transcribing", "replying", "synthesizing"].includes(call.turn.phase))) return fault("TURN_BUSY", "上一轮仍在处理，请先停止或等待结束。", true);
    call.generation = ++generation;
    call.turn = { turnId: id, generation: call.generation, phase: "recognized", transcript: "", subtitle: "", revision: 0, replyText: "", error: null, sttStarted: false, replyStarted: false, ttsStarted: false, messageTimestamp: null, messageRevisions: new Map() };
    return call.turn;
  }
  function failTurn(call: CallState, turn: TurnState, error: unknown, stage: "stt" | "tts" | "chat"): never {
    if (!current(call, turn)) return stale();
    const failure = publicError(error, stage);
    turn.phase = failure.code === "CANCELLED" ? "cancelled" : "error"; turn.error = failure;
    return fault(failure.code, failure.message, failure.retryable);
  }
  function voice(config: VoiceChoice): VoiceChoice {
    return { id: config.id, name: config.name, providerType: config.providerType, responseFormat: config.responseFormat };
  }
  async function findChat(id: string): Promise<ChatChoice> {
    const result = await bounded(dependencies.listChats({ chat_ids: [id], limit: 1 }), timeouts.inspect);
    const matches = result.chats.filter(chat => chat.id === id);
    if (matches.length !== 1) return fault("CHAT_NOT_FOUND", "指定会话不存在，请返回聊天后重新打开通话。");
    const chat = matches[0];
    return { id: chat.id, title: chat.title.slice(0, 256), isCurrent: chat.isCurrent };
  }
  async function inspect(request: Extract<VoiceRequest, { op: "inspect" }>): Promise<InspectResult> {
    const results = await Promise.allSettled([
      bounded(dependencies.listChats({ limit: request.listChats ? 20 : 1, sort_by: "updatedAt", sort_order: "desc" }), timeouts.inspect),
      bounded(dependencies.listTtsConfigs(), timeouts.inspect),
      bounded(dependencies.currentTtsConfigId(), timeouts.inspect),
      request.chatId === undefined || request.chatId === null ? Promise.resolve(null) : findChat(request.chatId),
    ] as const);
    const [chatList, configList, currentConfig, exactChat] = results;
    if (chatList.status === "rejected") throw chatList.reason;
    if (exactChat.status === "rejected") throw exactChat.reason;
    const configs = configList.status === "fulfilled" ? configList.value.configs.slice(0, 200).map(voice) : [];
    const id = currentConfig.status === "fulfilled" ? currentConfig.value.configId : null;
    const ttsError = configList.status === "rejected" || currentConfig.status === "rejected" || !configs.some(config => config.id === id) ? publicError(new Error("TTS config missing"), "tts") : null;
    return { chat: exactChat.value, currentChatId: chatList.value.currentChatId, chats: request.listChats ? chatList.value.chats.slice(0, 20).map(chat => ({ id: chat.id, title: chat.title.slice(0, 256), isCurrent: chat.isCurrent })) : [], ttsConfigs: configs, currentTtsConfigId: id, ttsError, limits: VOICE_LIMITS, scope: "foreground", promptMode: "CHAT", voiceProfile: "global-or-manual" };
  }
  async function open(request: Extract<VoiceRequest, { op: "open" }>): Promise<VoiceSnapshot> {
    const priorReply = replies.get(request.chatId);
    if (priorReply?.settling) settle(priorReply);
    if (closedCalls.has(request.callId)) return fault("CALL_CLOSED", "此通话已关闭，请使用新通话标识重新连接。");
    if (calls.has(request.callId) || openings.has(request.callId)) return fault("CALL_ALREADY_OPEN", "同一通话已连接，请先挂断再重连。");
    if ([...calls.values()].some(call => call.chatId === request.chatId) || [...openings.values()].some(call => call.chatId === request.chatId) || replies.has(request.chatId)) return fault("CHAT_BUSY", "此会话已有通话或仍有回复未结束，请先挂断并等待结束。", true);
    if (calls.size + openings.size >= VOICE_LIMITS.maxOpenCalls) return fault("CALL_LIMIT", "打开的通话过多，请先关闭旧通话。");
    if (replies.size >= VOICE_LIMITS.maxOpenCalls) return fault("CALL_LIMIT", "仍有旧会话执行正在结束，请稍后重试。", true);
    const opening = { cancelled: false, chatId: request.chatId }; openings.set(request.callId, opening);
    try {
    await findChat(request.chatId);
    if (opening.cancelled || closedCalls.has(request.callId)) return fault("CALL_CLOSED", "通话已关闭。");
    const manual = typeof request.ttsConfigId === "string";
    let selectedVoice: VoiceChoice | null = null, ttsError: VoiceError | null = null;
    try {
      const configs = await bounded(dependencies.listTtsConfigs(), timeouts.inspect);
      const id = manual ? request.ttsConfigId : (await bounded(dependencies.currentTtsConfigId(), timeouts.inspect)).configId;
      const matches = configs.configs.filter(config => config.id === id);
      if (matches.length !== 1) fault("TTS_UNAVAILABLE", "所选声音不存在或已失效，请重新选择 TTS 配置。", true);
      selectedVoice = voice(matches[0]);
    } catch (error) {
      if (manual) { const failure = publicError(error, "tts"); return fault(failure.code, failure.message, failure.retryable); }
      ttsError = publicError(error, "tts");
    }
    if (opening.cancelled || closedCalls.has(request.callId)) return fault("CALL_CLOSED", "通话已关闭。");
    const call: CallState = { callId: request.callId, chatId: request.chatId, generation: ++generation, voiceMode: manual ? "manual" : "global", tts: selectedVoice, ttsError, turn: null };
    calls.set(call.callId, call);
    return snapshot(call);
    } finally { if (openings.get(request.callId) === opening) openings.delete(request.callId); }
  }
  async function transcribe(request: Extract<VoiceRequest, { op: "transcribe" }>): Promise<VoiceValue> {
    const wav = validateWav(request.wav), call = selectedCall(request.callId), turn = turnFor(call, request.turnId);
    if (turn.sttStarted || turn.replyStarted || turn.ttsStarted) return fault("DUPLICATE_TURN", "本轮已经处理过录音，请开始新一轮。");
    turn.sttStarted = true; turn.phase = "transcribing";
    try {
      const result = await bounded(dependencies.transcribe({ audio: wav, fileName: "voice-turn.wav", contentType: "audio/wav" }), timeouts.stt);
      check(call, turn);
      if (typeof result.text !== "string" || !result.text.trim()) fault("NO_SPEECH", "未识别到文字，请重新说一遍。", true);
      turn.transcript = text(result.text.trim()); turn.phase = "recognized";
      return { text: turn.transcript, snapshot: snapshot(call) };
    } catch (error) { return failTurn(call, turn, error, "stt"); }
  }
  async function cancelOwned(job: ReplyJob): Promise<{ requested: boolean; error: VoiceError | null }> {
    if (replies.get(job.call.chatId) !== job) return { requested: false, error: null };
    try {
      const result = await bounded(dependencies.cancelChat(job.call.chatId), timeouts.cancel);
      if (result.chatId !== job.call.chatId) fault("CANCEL_UNCONFIRMED", "未确认原会话执行已取消。", true);
      return { requested: result.cancelRequested, error: null };
    } catch (error) { return { requested: false, error: publicError(error, "cancel") }; }
  }
  function dispose(job: ReplyJob): Promise<void> {
    if (job.disposal !== null) return job.disposal;
    job.disposal = (async () => {
      if (job.iterator?.return !== undefined) {
        try { await bounded(job.iterator.return(), timeouts.cancel); } catch { /* Disposal cannot confirm cancellation. */ }
      }
    })();
    return job.disposal;
  }
  function confirmed(job: ReplyJob): void {
    job.terminal = true;
    if (replies.get(job.call.chatId) === job) replies.delete(job.call.chatId);
    if (job.settling) { job.cleanup = dispose(job); }
  }
  function pull(job: ReplyJob): Promise<IteratorResult<NativeSendEvent>> {
    if (job.iterator === null) return Promise.reject(new VoiceFault("INVALID_STREAM", "回复流尚未打开。"));
    const pending = job.iterator.next(); job.pending = pending;
    // A real late terminal receipt releases the barrier, even after a local timeout or closed UI.
    pending.then(result => {
      if (!result.done && result.value.type === "completed" && result.value.result.chatId === job.call.chatId) {
        job.terminal = true;
        if (job.settling) confirmed(job);
      }
    }, () => { /* The bounded settlement path handles rejected observations explicitly. */ });
    return pending;
  }
  function settle(job: ReplyJob): void {
    job.settling = true;
    if (job.terminal) { confirmed(job); return; }
    if (job.cleanup !== null) return;
    // This is a tracked, finite cleanup drain, not a detached model task. If native work
    // remains unknown after the deadline, the per-chat barrier stays in place.
    const cleanup = (async () => {
      if (job.iterator === null) { confirmed(job); return; }
      const deadline = Date.now() + Math.min(30000, timeouts.reply);
      for (let reads = 0; reads < 64 && !job.terminal; reads++) {
        try {
          const next = await bounded(job.pending ?? pull(job), Math.max(1, deadline - Date.now()));
          job.pending = null;
          if (!next.done && next.value.type === "completed" && next.value.result.chatId === job.call.chatId) { confirmed(job); return; }
          const cancellation = await cancelOwned(job);
          // A false acknowledgement is authoritative only after the pending admission/read
          // has settled. It cannot release a first next() which might still admit later.
          if (cancellation.error === null && !cancellation.requested) { confirmed(job); return; }
          if (next.done || Date.now() >= deadline) return;
        } catch (error) {
          if (error instanceof VoiceFault && error.code === "TIMEOUT") return;
          const cancellation = await cancelOwned(job);
          if (cancellation.error === null && !cancellation.requested) confirmed(job);
          return;
        }
      }
    })();
    job.cleanup = cleanup;
    cleanup.then(() => { if (job.cleanup === cleanup) job.cleanup = null; }, () => { if (job.cleanup === cleanup) job.cleanup = null; });
  }
  async function reply(request: Extract<VoiceRequest, { op: "reply" }>): Promise<VoiceValue> {
    const call = selectedCall(request.callId), turn = turnFor(call, request.turnId);
    if (turn.phase === "transcribing" || turn.phase === "synthesizing" || replies.has(call.chatId)) return fault("TURN_BUSY", "本轮仍在处理，请稍后重试。", true);
    if (turn.replyStarted) return fault("DUPLICATE_TURN", "本轮已提交，不会自动重复发送。请开始新一轮。");
    turn.replyStarted = true; turn.phase = "replying";
    const job: ReplyJob = { call, turn, iterator: null, pending: null, terminal: false, settling: false, cleanup: null, disposal: null }; replies.set(call.chatId, job);
    const deadline = Date.now() + timeouts.reply;
    let terminal = false;
    let stage: "create" | "pull" | "event" | "subtitle" | "receipt" = "create";
    try {
      const iterable = dependencies.sendMessageStreaming({ kind: "submit", chatId: call.chatId, runtime: "main", input: { text: text(request.text), attachments: [], replyToMessageTimestamp: null }, turn: { kind: "execute" }, notifyReply: false });
      job.iterator = iterable[Symbol.asyncIterator]();
      while (true) {
        stage = "pull";
        const next = await bounded(pull(job), Math.max(1, deadline - Date.now()));
        stage = "event";
        job.pending = null;
        if (!current(call, turn)) { await cancelOwned(job); return stale(); }
        if (next.done) fault("MISSING_COMPLETION", "回复流未返回完成凭据；不会自动重复发送本轮。", true);
        const event = next.value;
        if (event.type === "part") {
          stage = "subtitle";
          if (event.chatId !== call.chatId || !Number.isSafeInteger(event.messageTimestamp) || event.messageTimestamp < 0 || !Number.isSafeInteger(event.revision) || event.revision < 0 || !Array.isArray(event.parts) || event.parts.length > 512 || event.parts.some((part: { content: string; sequence: number }) => typeof part.content !== "string" || !Number.isSafeInteger(part.sequence))) fault("INVALID_STREAM", "原会话返回了无效字幕事件。", true);
          const previous = turn.messageRevisions.get(event.messageTimestamp);
          if (previous !== undefined && event.revision <= previous) continue;
          if (previous === undefined) {
            if (turn.messageRevisions.size >= 128) fault("SUBTITLE_LIMIT", "本轮回复消息过多，已停止本地接收。", true);
            turn.messageTimestamp = event.messageTimestamp;
          }
          turn.messageRevisions.set(event.messageTimestamp, event.revision);
          // Revision belongs to one message. A new message may start at zero, while
          // a late update to an earlier message must not replace the current subtitle.
          if (turn.messageTimestamp !== event.messageTimestamp) continue;
          const content = [...event.parts].sort((left, right) => left.sequence - right.sequence).filter(part => part.kind === "markdown").map(part => part.content).join("\n");
          if (content.length > VOICE_LIMITS.maxSubtitleCharacters) fault("SUBTITLE_LIMIT", "本轮字幕过长，已停止本地接收。", true);
          turn.subtitle = content; turn.revision = event.revision;
        } else if (event.type === "completed") {
          stage = "receipt";
          terminal = true;
          const receipt = completed(event.result, call.chatId);
          turn.replyText = text(event.result.aiResponse); turn.subtitle = turn.replyText; turn.phase = "replied";
          if (replies.get(call.chatId) === job) replies.delete(call.chatId);
          return { receipt, snapshot: snapshot(call) };
        }
      }
    } catch (error) {
      if (!terminal) await cancelOwned(job);
      const failure = publicError(error, "chat");
      return failTurn(call, turn, failure.code === "CHAT_FAILED" ? streamFailure(error, stage) : error, "chat");
    } finally {
      if (terminal || job.terminal || job.iterator === null) { confirmed(job); await dispose(job); }
      else settle(job);
    }
  }
  async function speak(request: Extract<VoiceRequest, { op: "speak" }>): Promise<VoiceValue> {
    const call = selectedCall(request.callId);
    if (call.turn === null || call.turn.turnId !== request.turnId) return fault("TURN_NOT_FOUND", "找不到本轮已完成的回复。");
    const turn = call.turn; check(call, turn);
    if (turn.phase !== "replied") return fault("REPLY_NOT_READY", "请等待本轮原会话回复完成后朗读。");
    if (turn.ttsStarted) return fault("DUPLICATE_SPEECH", "本轮已经合成过语音，请开始新一轮。");
    if (call.tts === null) return fault("TTS_UNAVAILABLE", call.ttsError?.message ?? "当前声音不可用，文字回复仍保留。", true);
    const speech = request.text === undefined ? text(turn.replyText) : text(request.text);
    turn.ttsStarted = true; turn.phase = "synthesizing";
    try {
      const result = await bounded(dependencies.synthesize({ text: speech, configId: call.tts.id }), timeouts.tts);
      check(call, turn);
      const segments = validateSegments(result.segments);
      turn.phase = "spoken";
      return { segments, snapshot: snapshot(call) };
    } catch (error) {
      if (!current(call, turn)) return stale();
      // Synthesis failure must not erase an already committed chat reply or trigger a resend.
      const failure = publicError(error, "tts"); turn.phase = "replied"; turn.error = failure;
      return fault(failure.code, failure.message, failure.retryable);
    }
  }
  async function stop(request: Extract<VoiceRequest, { op: "cancel" | "close" }>): Promise<CancelResult> {
    const call = calls.get(request.callId);
    if (call === undefined) {
      if (request.op !== "close") return fault("CALL_CLOSED", "通话已关闭。");
      const opening = openings.get(request.callId); if (opening !== undefined) opening.cancelled = true;
      rememberClosed(request.callId);
      return { snapshot: null, cancelRequested: false, cancellationError: null, remoteSpeechMayContinue: true, closed: true };
    }
    if (request.turnId !== undefined && call.turn?.turnId !== request.turnId) return fault("STALE_TURN", "停止请求属于旧轮次，当前轮未被更改。");
    call.generation = ++generation;
    if (call.turn !== null) call.turn.phase = "cancelled";
    const job = replies.get(call.chatId);
    const cancellation = job?.call === call ? await cancelOwned(job) : { requested: false, error: null };
    if (job?.call === call && job.settling) settle(job);
    const state = snapshot(call), closed = request.op === "close";
    if (closed && calls.get(call.callId) === call) { calls.delete(call.callId); rememberClosed(call.callId); }
    return { snapshot: state, cancelRequested: cancellation.requested, cancellationError: cancellation.error, remoteSpeechMayContinue: true, closed };
  }
  function rememberClosed(id: string): void {
    closedCalls.add(id);
    if (closedCalls.size > 128) { const oldest = closedCalls.values().next(); if (!oldest.done) closedCalls.delete(oldest.value); }
  }
  return {
    async receive(payload: unknown): Promise<VoiceResponse> {
      try {
        const request = parse(payload);
        let value: VoiceValue;
        switch (request.op) {
          case "inspect": value = await inspect(request); break;
          case "open": value = await open(request); break;
          case "transcribe": value = await transcribe(request); break;
          case "reply": value = await reply(request); break;
          case "poll": {
            const call = selectedCall(request.callId), job = replies.get(call.chatId);
            if (job?.call === call && job.settling) settle(job);
            value = snapshot(call); break;
          }
          case "speak": value = await speak(request); break;
          case "cancel": case "close": value = await stop(request); break;
        }
        return { ok: true, value };
      } catch (error) { return { ok: false, error: publicError(error) }; }
    },
  };
}

function completed(receipt: NativeReceipt, expectedChat: string): ReplyReceipt {
  if (receipt.chatId !== expectedChat) return fault("INVALID_RECEIPT", "完成凭据不属于当前会话。");
  const outcome = receipt.outcome;
  if (outcome.type === "blocked") return fault("INPUT_BLOCKED", "本轮输入已被原会话插件阻止，未生成回复。");
  if (outcome.type === "consumed") return fault("INPUT_CONSUMED", "输入已由原会话插件接管，此入口尚未获得回复完成凭据。");
  if (outcome.status === "cancelled") return fault("CANCELLED", "本轮原会话执行已取消。");
  if (outcome.status !== "completed") return fault("INVALID_RECEIPT", "原会话未确认回复完成。");
  return { persistence: outcome.type, userMessageTimestamp: outcome.type === "committed" ? outcome.userMessageTimestamp ?? null : null, assistantMessageTimestamp: outcome.type === "committed" ? outcome.assistant?.messageTimestamp ?? null : null };
}
function validateSegments(value: AudioSegment[]): AudioSegment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > VOICE_LIMITS.maxAudioSegments) return fault("INVALID_SPEECH", "合成服务未返回可播放音频。");
  let total = 0;
  return value.map(segment => {
    if (!segment || typeof segment.contentType !== "string" || !/^(audio\/(wav|x-wav|mpeg|mp3|ogg|opus|flac|aac|mp4))(;[^\r\n]*)?$/i.test(segment.contentType) || !Array.isArray(segment.audio) || !segment.audio.length) return fault("UNSUPPORTED_AUDIO", "合成音频格式不可直接播放，请将 TTS 输出设为 WAV、MP3 或其他受支持编码；不支持未知格式的裸 PCM。");
    total += segment.audio.length;
    if (total > VOICE_LIMITS.maxAudioResponseBytes || !segment.audio.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return fault("INVALID_SPEECH", "合成音频为空、数据无效或超过大小限制。");
    return { audio: [...segment.audio], contentType: segment.contentType };
  });
}

/** A retained foreground screen owns this instance for its whole presentation lease. */
export function createDefaultHostService(): ReturnType<typeof createHostService> {
  return createHostService({
    listChats: params => Tools.Chat.listChats(params),
    listTtsConfigs: () => Tools.Tts.listConfigs(),
    currentTtsConfigId: () => Tools.Tts.getCurrentConfigId(),
    transcribe: request => Tools.Stt.transcribe(request),
    // Production deliberately uses one canonical send and its terminal receipt.
    // The real-device observation path failed after receiving part snapshots.
    // This local iterable only adapts the receipt protocol; it does not claim partial streaming.
    sendMessageStreaming: request => {
      let started = false;
      const iterator: AsyncIterableIterator<NativeSendEvent> = {
        [Symbol.asyncIterator]() { return this; },
        async next(): Promise<IteratorResult<NativeSendEvent>> {
          if (started) return { done: true, value: undefined };
          started = true;
          const result = await Tools.Chat.sendMessage(request);
          return { done: false, value: { type: "completed", result } };
        },
        async return(): Promise<IteratorResult<NativeSendEvent>> {
          return { done: true, value: undefined };
        },
      };
      return iterator;
    },
    cancelChat: id => Tools.Chat.cancel(id),
    synthesize: request => Tools.Tts.synthesize(request),
  });
}
