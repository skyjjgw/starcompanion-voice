// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors

export const VOICE_LIMITS = {
  maxRecordingMs: 15000,
  sampleRate: 16000,
  maxWavBytes: 484096,
  maxTextCharacters: 8000,
  maxSubtitleCharacters: 65536,
  maxAudioResponseBytes: 8 * 1024 * 1024,
  maxAudioSegments: 32,
  maxOpenCalls: 4,
} as const;

export interface VoiceError { code: string; message: string; retryable: boolean }
export interface ChatChoice { id: string; title: string; isCurrent: boolean }
export interface VoiceChoice { id: string; name: string; providerType: string; responseFormat: string }
export type TurnPhase = "transcribing" | "recognized" | "replying" | "replied" | "synthesizing" | "spoken" | "cancelled" | "error";
export interface VoiceTurnSnapshot {
  turnId: string;
  generation: number;
  phase: TurnPhase;
  transcript: string;
  subtitle: string;
  revision: number;
  replyText: string;
  error: VoiceError | null;
}
export interface VoiceSnapshot {
  callId: string;
  chatId: string;
  generation: number;
  voiceMode: "global" | "manual";
  tts: VoiceChoice | null;
  ttsError: VoiceError | null;
  turn: VoiceTurnSnapshot | null;
  replySettling: boolean;
}
export interface InspectResult {
  chat: ChatChoice | null;
  currentChatId: string | null;
  chats: ChatChoice[];
  ttsConfigs: VoiceChoice[];
  currentTtsConfigId: string | null;
  ttsError: VoiceError | null;
  limits: typeof VOICE_LIMITS;
  scope: "foreground";
  promptMode: "CHAT";
  voiceProfile: "global-or-manual";
}
export interface AudioSegment { audio: number[]; contentType: string }
export interface ReplyReceipt {
  persistence: "committed" | "not_persisted";
  userMessageTimestamp: number | null;
  assistantMessageTimestamp: number | null;
}
export type VoiceRequest =
  | { op: "inspect"; chatId?: string | null; listChats?: boolean }
  | { op: "open"; callId: string; chatId: string; ttsConfigId?: string | null }
  | { op: "transcribe"; callId: string; turnId: string; wav: number[] }
  | { op: "reply"; callId: string; turnId: string; text: string }
  | { op: "poll"; callId: string }
  | { op: "speak"; callId: string; turnId: string; text?: string }
  | { op: "cancel" | "close"; callId: string; turnId?: string };
export interface CancelResult {
  snapshot: VoiceSnapshot | null;
  cancelRequested: boolean;
  cancellationError: VoiceError | null;
  remoteSpeechMayContinue: true;
  closed: boolean;
}
export type VoiceValue = InspectResult | VoiceSnapshot
  | { text: string; snapshot: VoiceSnapshot }
  | { receipt: ReplyReceipt; snapshot: VoiceSnapshot }
  | { segments: AudioSegment[]; snapshot: VoiceSnapshot }
  | CancelResult;
export type VoiceResponse = { ok: true; value: VoiceValue } | { ok: false; error: VoiceError };

/** The exact subset of SDK results consumed here; secrets are never part of the IPC protocol. */
export interface NativeChatList {
  currentChatId: string | null;
  chats: { id: string; title: string; isCurrent: boolean }[];
}
export interface NativeSubmitRequest {
  kind: "submit";
  chatId: string;
  runtime: "main";
  input: { text: string; attachments: []; replyToMessageTimestamp: null };
  turn: { kind: "execute" };
  notifyReply: false;
}
export interface NativeReceipt {
  chatId: string;
  aiResponse?: string | null;
  outcome:
    | { type: "committed"; status: "completed" | "cancelled"; userMessageTimestamp?: number | null; assistant?: { messageTimestamp: number } | null }
    | { type: "not_persisted"; status: "completed" | "cancelled" }
    | { type: "blocked"; message?: string | null }
    | { type: "consumed"; metadata: Record<string, unknown> };
}
export type NativeSendEvent =
  | { type: "part"; chatId: string; messageTimestamp: number; revision: number; parts: { kind: string; content: string; sequence: number }[] }
  | { type: "completed"; result: NativeReceipt };
export interface VoiceDependencies {
  listChats(params: { chat_ids?: string[]; limit: number; sort_by?: "updatedAt"; sort_order?: "desc" }): Promise<NativeChatList>;
  listTtsConfigs(): Promise<{ configs: VoiceChoice[] }>;
  currentTtsConfigId(): Promise<{ configId: string }>;
  transcribe(request: { audio: number[]; fileName: string; contentType: string; language?: string }): Promise<{ text: string }>;
  /** Receipt/event protocol seam. Production uses one Chat.sendMessage terminal receipt;
   * injected streams exercise optional event handling, not production partial subtitles. */
  sendMessageStreaming(request: NativeSubmitRequest): AsyncIterable<NativeSendEvent>;
  cancelChat(chatId: string): Promise<{ chatId: string; cancelRequested: boolean }>;
  synthesize(request: { text: string; configId: string }): Promise<{ segments: AudioSegment[] }>;
  /** Tests may shorten bounded waits without replacing service behavior. */
  timeouts?: Partial<{ inspect: number; stt: number; reply: number; tts: number; cancel: number }>;
}
