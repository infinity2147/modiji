# API notes — verified 2026-10-04

Per the bootstrap rules, installed package types and official docs override `plan.md` §15. Every difference from the plan is recorded here.

Scope: facts the integration code depends on. Each item is marked **VERIFIED** (with source), **DIFFERS FROM PLAN** (plan claim vs reality), or **UNVERIFIED**.

Versions inspected (installed in a scratch dir, not in this repo):
`@elevenlabs/react@1.16.0` → `@elevenlabs/client@1.26.0` (+ `@elevenlabs/types@0.24.0`), `@elevenlabs/elevenlabs-js@2.70.0`, `@anthropic-ai/sdk@0.131.0`.
Paths like `react/dist/...` mean `node_modules/@elevenlabs/react/dist/...`; `client/dist/...` → `@elevenlabs/client`; `el-js/...` → `@elevenlabs/elevenlabs-js`; `anthropic/...` → `@anthropic-ai/sdk`.
ElevenLabs docs were read as raw markdown (`https://elevenlabs.io/docs/<page>.md`); Anthropic docs as `https://platform.claude.com/docs/en/<page>.md`.

## Top items for engineers

1. **Custom-LLM URL:** ElevenLabs adds `/chat/completions` to `custom_llm.url`. If you set `url: https://host/api/llm`, the handler must be `POST /api/llm/chat/completions` (see 4.1).
2. **`custom_llm.api_key` must be a reference, not a literal:** use `{secret_id}` or `{env_var_label}`. Create the secret first with `POST /v1/convai/secrets` (see 3.2).
3. **React `startSession()` returns `void` in 1.16, not a Promise.** Get the conversation id from `onConnect({conversationId})` or `getId()` (see 1.3).
4. **There is no `setMicMuted` on the React hooks.** Use `setMuted`, the `micMuted` option, or the controlled `isMuted` provider prop (see 1.5).
5. **`onMessage` with `role:"user"` only fires when the server sends a `user_transcript`.** The SDK does not echo `sendUserMessage` text locally. Whether the server sends a `user_transcript` for typed or control messages is UNVERIFIED (see 1.6).
6. **Things that can make the agent talk without our authorization:**
   - `turn.soft_timeout_config` (default is off, `-1`; keep it off).
   - `turn_timeout` re-engagement turns. These still go through the custom LLM, so the wrapper must `skip_turn` them.
   - `pre_tool_speech` on the `skip_turn` tool (default `auto`; set it to `"off"`).
   - `first_message` (set it to `""`).
7. **`conversation.max_duration_seconds` defaults to 600 s.** Raise it for interviews longer than 10 minutes (see 3.1).
8. **Use raw `fetch` (snake_case JSON) to create and update agents, not the elevenlabs-js SDK.**
   - SDK 2.70.0 checks enums strictly on the way out (`jsonOrThrow`, no `allowUnrecognizedEnumValues`).
   - The SDK enums are older than the API. `Llm` has no `claude-sonnet-5-5`. `TtsConversationalModel` has no `eleven_v4*`.
   - The SDK also silently drops unknown keys (`unrecognizedObjectKeys: "strip"`). Source: `el-js/api/resources/conversationalAi/resources/agents/client/Client.js:166-168`.
9. **Simulate-conversation is removed on 31 Oct 2026**, 27 days from now. Use the Agent Testing APIs (see 5).
10. **`claude-haiku-4-5-20251001` is Active, but its retirement date is "not sooner than October 15, 2026"**, 11 days from now. Source: `platform.claude.com/docs/en/about-claude/model-deprecations.md` line 90. This is a risk for a model we depend on.

---

## 1. `@elevenlabs/react` 1.x

### 1.1 Exports — VERIFIED
`react/dist/index.d.ts:1-20`:
- Components and hooks: `ConversationProvider`, `useConversation`, `useConversationClientTool`, `useConversationControls`, `useConversationStatus`, `useConversationInput`, `useConversationMode`, `useConversationFeedback`, `useRawConversation`, `useScribe`.
- Types: `UseConversationOptions`, `HookOptions`, `HookCallbacks`, `ClientTool(s)`, `ClientToolResult`, and others.
- It also does `export * from "@elevenlabs/client"` (line 1), so you don't need to install `@elevenlabs/client` separately.

### 1.2 `ConversationProvider` — VERIFIED
- `ConversationProvider(props: React.PropsWithChildren<HookOptions & { isMuted?: boolean; onMutedChange?: (b: boolean) => void }>)` — `react/dist/conversation/ConversationProvider.d.ts:4-5`.
- `HookOptions` is `Partial<SessionConfig & HookCallbacks & lifecycle & ClientToolsConfig & Input/Output/AudioWorklet/FormatConfig & { serverLocation? }>` — `react/dist/conversation/types.d.ts:6`.
- Any session config or callbacks given to the provider become the defaults for `startSession()`.

### 1.3 `useConversation` / `startSession` — VERIFIED; DIFFERS FROM PLAN/DOCS on the return value
- `useConversation(props?: HookOptions & { micMuted?: boolean; volume?: number })` — `react/dist/conversation/useConversation.d.ts:2-46`.
- It returns `startSession`, `endSession`, `status`, `message`, `isMuted`, `setMuted`, `mode`, `isSpeaking`, `isListening`, `canSendFeedback`, `sendFeedback`, `sendUserMessage`, `sendMultimodalMessage`, `uploadFile`, `sendContextualUpdate`, `sendUserActivity`, `sendMCPToolApprovalResult`, `setVolume`, `changeInput/OutputDevice`, `get*FrequencyData`, `getInput/OutputVolume`, and `getId`.
- **`startSession: (options?: HookOptions) => void`** (`useConversation.d.ts:19`, `ConversationControls.d.ts:4`).
  - The implementation fires `Conversation.startSession(...)` and returns nothing (`ConversationProvider.js:44-187`).
  - A second call while a session exists or is connecting is silently ignored (lines 45-50).
  - Start failures go to `onError(message, error)` (lines 176-184).
  - The React docs page (`eleven-agents/libraries/react.md`) still says it "returns a promise resolving a conversationId". **This is wrong for 1.16.** Use `onConnect({ conversationId })` or `getId()` instead.
- `status` in React is `"disconnected" | "connecting" | "connected" | "error"` (`ConversationStatus.d.ts:1`).

Starting with a WebRTC token — VERIFIED:
```ts
startSession({ conversationToken, connectionType: "webrtc" /* optional */ });
```
- `PrivateWebRTCSessionConfig = BaseSessionConfig & { conversationToken: string; connectionType?: "webrtc" }` — `client/dist/utils/BaseConnection.d.ts:134-140`.
- If `conversationToken` is present, the connection type is inferred as WebRTC (`client/dist/utils/ConnectionFactory.js:22-29`), so `connectionType` can be left out.
- Other useful `BaseSessionConfig` fields (`BaseConnection.d.ts:19-74`): `overrides.{agent:{prompt,firstMessage,language}, tts:{voiceId,speed,stability,similarityBoost}, asr:{keywords}, conversation:{textOnly}}`, `customLlmExtraBody`, `dynamicVariables`, `userId`, `textOnly`, `useWakeLock`.
- `customLlmExtraBody` is sent as `custom_llm_extra_body` in `conversation_initiation_client_data` (`client/dist/utils/overrides.js:28-30`). The agent must allow it with `platform_settings.overrides.custom_llm_extra_body: true` (`el-js/serialization/types/ConversationInitiationClientDataConfigInput.d.ts`).

### 1.4 Methods — VERIFIED
Signatures from `react/dist/conversation/ConversationControls.d.ts:3-24`; wire events from `client/dist/BaseConversation.js:583-598`.
- `sendUserMessage(text: string): void`
  - Sends `{type:"user_message", text}`.
  - The client class also accepts `options?: {richContentId}`, but the React wrapper only passes `text`.
  - Docs: "treated as a user message and will prompt the agent to take its turn" (react.md, client-to-server-events.md).
- `sendContextualUpdate(text: string, options?: { contextId?: string }): void`
  - Sends `{type:"contextual_update", text, context_id?}`. It does not trigger a response.
- `sendUserActivity(): void`
  - Sends `{type:"user_activity"}`, **throttled to at most one per 1000 ms** (`BaseConversation.js:7,43-47`).
  - Docs: "The agent will pause speaking for ~2 seconds" (react.md) and "Resets the turn timeout timer" (client-to-server-events.md).

### 1.5 Mute — DIFFERS FROM PLAN (naming only)
- The plan says `setMicMuted(true)`. The React hooks expose **`setMuted(isMuted: boolean)`** (`useConversation.d.ts:23`, `ConversationInput.d.ts:3`) and the controlled option `useConversation({ micMuted })`, which calls `setMuted` (`useConversation.js:52-56`).
- The provider also takes controlled `isMuted` / `onMutedChange` props (`ConversationInput.d.ts:5-10`).
- `setMicMuted(isMuted)` does exist, but only on the raw client `Conversation` object (`client/dist/BaseConversation.d.ts:115`), which you reach through `useRawConversation()`.

### 1.6 Callbacks — VERIFIED (types), with one UNVERIFIED behaviour
From `client/dist/types.d.ts:96-175`:
- `onConnect({ conversationId: string })`
- `onDisconnect(details)`. `details` is one of `{reason:"error",message,context,closeCode?,closeReason?}`, `{reason:"agent",...}`, or `{reason:"user"}` (lines 28-41).
- `onError(message: string, context?: any)`
- `onModeChange({ mode: "speaking" | "listening" })`
- `onVadScore({ vadScore: number })`. Value is 0..1 (client-events.md "vad_score").
- `onStatusChange({ status })`, `onInterruption`, `onAgentChatResponsePart`, `onAudioAlignment`, `onUnhandledClientToolCall`, `onIncomingEvent`, `onOutgoingEvent`, and others.

`onMessage(props: MessagePayload)`, defined at `types.d.ts:43-58`:
```ts
{ message: string; event_id: number; response_id?: string;
  source: "user" | "ai";   // deprecated
  role: "user" | "agent";
  attachments?: [...] }    // agent messages only
```
- `role:"agent"` comes only from the server `agent_response` event (final text, sent after the audio starts) — `BaseConversation.js:154-169`.
- `role:"user"` comes only from the server `user_transcript` event — `BaseConversation.js:174-183`. Tentative transcripts go to `onDebug`, not `onMessage`.
- **UNVERIFIED:** whether the server sends a `user_transcript` for text sent with `sendUserMessage`. The SDK does not echo it locally. Our control messages (`⟦ctl:…⟧`) **may or may not** come back through `onMessage(role:"user")`, so filter them on the client in either case. They also become user turns in the stored ElevenLabs transcript (they go into the conversation as user input).
- **Server-side event allow-list:** `conversation_config.conversation.client_events` decides which events reach the client.
  - Some events (`agent_chat_response_part` in voice, `agent_response_metadata`, `agent_response_complete`, `guardrail_triggered`, `agent_tool_response_full_payload`) "must be explicitly enabled" (client-events.md).
  - **UNVERIFIED:** whether `vad_score` is on by default. Check the created agent's `client_events` with GET agent, and include `vad_score` if you set the list explicitly.

### 1.7 Client tools — VERIFIED
Three ways to register them:
- `clientTools: { name: (params) => string|number|void|Promise<…> }` on `ConversationProvider`, `useConversation`, or `startSession` (`client/dist/BaseConversation.d.ts:44-46`).
- `useConversationClientTool<TTools>(name, handler)`. It registers while the component is mounted, and the handler always sees the latest closure (`react/dist/conversation/ConversationClientTools.d.ts:37`).
  - Registering the same name through both a hook and options throws (`ConversationClientTools.d.ts:5-9`).
- Results and errors:
  - A non-string result is JSON-stringified.
  - An `undefined` result becomes `"Client tool execution successful."`.
  - A thrown error goes back to the agent as `is_error:true`.
  - An unknown tool name triggers `onUnhandledClientToolCall` (`BaseConversation.js:208-251`).
- The agent side must also define the tool:
  - Create it with `POST /v1/convai/tools` `{ tool_config: { type:"client", name, description, expects_response, parameters, ... } }`.
  - Reference it with `conversation_config.agent.prompt.tool_ids` (client-tools.md; SDK `conversationalAi.tools.create`).
  - Use `expects_response: true` if the agent must wait for the result. `response_timeout_secs` is 1-120 (`el-js/api/types/ClientToolConfigInput.d.ts`).

## 2. Conversation token endpoint — VERIFIED

`GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<id>` with header `xi-api-key: <key>`.
- Optional query params: `participant_name`, `branch_id`, `version_id`, `environment`, `debug_events_request`.
- Response:
  ```json
  { "token": "string", "conversation_id": "string" }
  ```
- Sources: `docs/api-reference/conversations/get-webrtc-token.md`; `el-js/serialization/types/TokenResponseModel.d.ts` (Raw `{token, conversation_id}`); react.md WebRTC example.
- SDK: `client.conversationalAi.conversations.getWebrtcToken({ agentId })` → `{ token, conversationId }` (`el-js/api/resources/conversationalAi/resources/conversations/client/Client.d.ts`).
- The response already includes `conversation_id`, so the server knows the id before the client connects. Useful for binding a session to a conversation.

## 3. Agent create / update

### 3.1 Endpoints and paths — VERIFIED
- `POST /v1/convai/agents/create` with body `{ conversation_config, platform_settings?, workflow?, name?, tags? }`. Response: `{ agent_id }`.
- `PATCH /v1/convai/agents/{agent_id}?branch_id=` with the same body plus `version_description?` and `procedures?`.
- `branch_id` is a **query** param (`agents/client/Client.js:347-351`).
- SDK methods: `conversationalAi.agents.create` and `conversationalAi.agents.update` (`agents/client/Client.d.ts:62,115`).

Field paths (wire names from `el-js/serialization/types/*.d.ts` Raw interfaces, cross-checked with `docs/api-reference/agents/create.md`):

| Need | Path | Values / notes |
|---|---|---|
| LLM | `conversation_config.agent.prompt.llm` | `"custom-llm"` (`el-js/api/types/Llm.d.ts:56`) |
| Custom LLM | `conversation_config.agent.prompt.custom_llm` | `{ url, model_id?, api_key?, auth_connection?, request_headers?, api_version?, api_type? }` (`serialization/types/CustomLlm.d.ts`) |
| `api_key` | `custom_llm.api_key` | **`{ "secret_id": "..." }` or `{ "env_var_label": "..." }`, not a literal string** (`api/types/CustomLlm.d.ts:7`, `CustomLlmApiKey.d.ts`) |
| `api_type` | `custom_llm.api_type` | `chat_completions` (default) \| `responses` \| `websocket` |
| Temperature / tokens | `agent.prompt.temperature`, `agent.prompt.max_tokens` | temperature defaults to 0; null omits it from the LLM request (`PromptAgentApiModelInput.d.ts:13`) |
| System prompt | `agent.prompt.prompt` | |
| First message | `conversation_config.agent.first_message` | `""` means the agent waits for the user (create.md) |
| Language | `conversation_config.agent.language` | default `en` |
| Turn | `conversation_config.turn.turn_timeout` | double, default 7, **must be 1–30 s** (conversation-flow.md) |
| | `conversation_config.turn.turn_eagerness` | `patient` \| `normal` (default) \| `eager` (`api/types/TurnEagerness.d.ts`) |
| | `turn.soft_timeout_config.timeout_seconds` | default `-1` (off). **Keep it off**: it speaks filler such as "Hhmmmm...yeah." while waiting for the LLM |
| | `turn.silence_end_call_timeout` | default -1 |
| | `turn.turn_model` | `turn_v2` \| `turn_v3` (default) |
| | `turn.speculative_turn` | default false |
| TTS model | `conversation_config.tts.model_id` | `eleven_v3_conversational` is valid (`api/types/TtsConversationalModel.d.ts:11`). API also lists `eleven_v4`, `eleven_v4_turbo` (create.md), which are missing from the SDK 2.70 enum |
| Expressive | `conversation_config.tts.expressive_mode` | boolean, default true; "Automatically disabled for non-v3 models" |
| | `tts.suggested_audio_tags` | |
| Voice | `tts.voice_id` | |
| ASR | `conversation_config.asr.provider` | `scribe_realtime` (default) \| `elevenlabs` (deprecated) (`api/types/AsrProvider.d.ts`) |
| | `conversation_config.asr.keywords` | `string[]`; can also be overridden per session with `overrides.asr.keywords` |
| System tools | `conversation_config.agent.prompt.built_in_tools.{skip_turn,end_call,language_detection,...}` | each one is `{ type:"system", name, description:"", params:{ system_tool_type: "<same>" } }`. Optional `pre_tool_speech: "auto"|"force"|"off"`, `interruption_mode` (`api/types/SystemToolConfigInput.d.ts`, `BuiltInToolsInput.d.ts:12,14,18`) |
| Language detection | `language_detection.params.only_at_conversation_start?: boolean` | (`LanguageDetectionToolConfig.d.ts`) |
| Language presets | `conversation_config.language_presets` | `{ "<lang>": { overrides: { agent: { first_message?, language?, prompt? }, tts?: {...} }, first_message_translation? } }` (`serialization/types/LanguagePresetInput.d.ts`; language-detection.md) |
| Client tools | `conversation_config.agent.prompt.tool_ids: [id]` | Inline `prompt.tools` is deprecated ("use tool_ids instead") |
| Client events | `conversation_config.conversation.client_events` | list of event names (see 1.6) |
| Max duration | `conversation_config.conversation.max_duration_seconds` | **default 600** |
| Retention | `platform_settings.privacy` | `{ record_voice (default true), retention_days (int; -1 = no limit; docs: 0 = scheduled deletion), delete_transcript_and_pii, delete_audio, apply_to_existing_conversations, zero_retention_mode, conversation_history_redaction }` (`serialization/types/PrivacyConfigInput.d.ts:8-14`; create.md lines 320-325) |
| Allow extra body | `platform_settings.overrides.custom_llm_extra_body: true` | needed for `customLlmExtraBody` to reach the LLM |

Copy-paste create body (raw JSON; IDs are placeholders):
```json
{
  "name": "interviewer",
  "conversation_config": {
    "agent": {
      "first_message": "",
      "language": "en",
      "prompt": {
        "prompt": "(unused by custom LLM except as system message)",
        "llm": "custom-llm",
        "custom_llm": {
          "url": "https://YOUR_HOST/api/llm",
          "model_id": "interviewer-v1",
          "api_key": { "secret_id": "SECRET_ID_FROM_POST_/v1/convai/secrets" },
          "api_type": "chat_completions"
        },
        "built_in_tools": {
          "skip_turn":          { "type": "system", "name": "skip_turn",          "description": "", "pre_tool_speech": "off", "params": { "system_tool_type": "skip_turn" } },
          "end_call":           { "type": "system", "name": "end_call",           "description": "", "params": { "system_tool_type": "end_call" } },
          "language_detection": { "type": "system", "name": "language_detection", "description": "", "params": { "system_tool_type": "language_detection" } }
        },
        "tool_ids": []
      }
    },
    "turn": { "turn_eagerness": "patient", "turn_timeout": 10, "soft_timeout_config": { "timeout_seconds": -1 } },
    "tts": { "model_id": "eleven_v3_conversational", "expressive_mode": true, "voice_id": "VOICE_ID" },
    "asr": { "provider": "scribe_realtime", "keywords": ["CaseDesk"] },
    "conversation": { "max_duration_seconds": 3600 }
  },
  "platform_settings": {
    "privacy": { "retention_days": 30, "record_voice": true },
    "overrides": { "custom_llm_extra_body": true }
  }
}
```
Notes on this body:
- `pre_tool_speech: "off"` on `skip_turn` is a defensive choice based on the field's documented meaning. How it interacts with `skip_turn` is UNVERIFIED.
- If you set `conversation.client_events` explicitly, list every event the UI needs (`audio`, `interruption`, `user_transcript`, `agent_response`, `vad_score`, `client_tool_call`, …). It is UNVERIFIED whether setting the list replaces the defaults.

### 3.2 Workspace secret for `api_key` — VERIFIED
- `POST /v1/convai/secrets` with body `{ "type": "new", "name": "LLM_KEY", "value": "..." }`.
  - The SDK adds `type:"new"` itself (`el-js/api/resources/conversationalAi/resources/secrets/client/Client.js:169`).
- Response: `{ "type": "stored", "secret_id": "...", "name": "..." }` (`serialization/types/PostWorkspaceSecretResponseModel.d.ts`).
- SDK: `conversationalAi.secrets.create({ name, value })`.

### 3.3 Retention / ZRM — partly DIFFERS FROM PLAN
- Plan says "default 2 years". The retention guide says "By default, ElevenLabs retains conversation data for 2 years" (`customization/privacy/retention.md`). The API reference says the `retention_days` default is `-1` ("no retention limit") (create.md:321). **The two docs conflict.** Set `retention_days` explicitly.
- Plan says "deletion is whole-conversation". The API also has separate flags:
  - `delete_audio`
  - `delete_transcript_and_pii`
  - `record_voice: false` (no audio is saved; audio-saving.md)
  - `conversation_history_redaction` (PII redaction)
- Plan says "Zero Retention Mode = Enterprise". There is a **per-agent** `platform_settings.privacy.zero_retention_mode` (privacy/zrm.md, create.md:325). Which plan tiers can use it per agent is UNVERIFIED.
  - **With ZRM on, transcripts and recordings are not stored.** You must use post-call webhooks, and `GET /conversations/{id}` will not have the data (zrm.md).

## 4. Custom LLM protocol

### 4.1 Request — VERIFIED (with the noted inference)
- ElevenLabs POSTs an OpenAI Chat Completions request with `"stream": true`. The response **must be SSE** (`Content-Type: text/event-stream`), with `data: {json}\n\n` chunks ending in `data: [DONE]\n\n` (custom-llm.md "Custom LLM Server").
  - With `api_type: "responses"` it uses the Responses API instead, with `event: <type>\ndata: {...}` events. At minimum: `response.output_text.delta` and `response.completed`.
- **Path:** ElevenLabs' own provider guides set `url` to a base ending in `/v1` (Groq: `https://api.groq.com/openai/v1`; Together: `https://api.together.xyz/v1`; `custom-llm/groq-cloud.md:47`, `together-ai.md:50`). That only works if `/chat/completions` is appended.
  - Inference.net's ElevenLabs guide states it directly: "ElevenLabs appends `/chat/completions` automatically" (https://docs.inference.net/integrations/agent-platforms/elevenlabs).
  - **So with `url: https://host/api/llm`, serve `POST /api/llm/chat/completions`.** The custom-llm.md page itself does not spell this out, so serve both paths, or check in preflight.
- **Headers:** the key comes from the `api_key` secret, and the docs only show OpenAI-compatible providers that expect `Authorization: Bearer <key>`. `auth_connection` "only … auth connections that produce an Authorization Bearer token are supported" (create.md:902).
  - The exact header name for `api_key` is not stated in the docs. **UNVERIFIED-but-strongly-implied:** `Authorization: Bearer <secret value>`. Extra static headers can be added with `custom_llm.request_headers`.
- Example request body (custom-llm.md, "Example Request with System Tools" and "Example Request"):
  - `messages[]` with a `system` message first, plus `model` (= `model_id`), `temperature`, `max_tokens`, and `stream: true`.
  - `tools: [...]` with system tools as OpenAI function definitions (`end_call`, `language_detection`, `skip_turn`, …).
  - `elevenlabs_extra_body: {...}` when the client sends `customLlmExtraBody`.
  - `user_id` may appear. The docs' sample server renames it to `user` and pops `elevenlabs_extra_body` before forwarding to OpenAI.
- **`elevenlabs_extra_body`** — VERIFIED: an arbitrary JSON object the client supplies at session start (`customLlmExtraBody` in JS, `extra_body` in Python). It is forwarded on every LLM request and must be enabled with `platform_settings.overrides.custom_llm_extra_body`. Strip it before proxying to a strict upstream.

### 4.2 Staying silent with `skip_turn` — VERIFIED in principle; exact SSE shape UNVERIFIED
- "System tools … are automatically included in the `tools` parameter of your chat completion requests when configured in your agent." The LLM "responds with function calls in standard OpenAI format" (custom-llm.md "System tools integration").
  - So `skip_turn` must be configured in `built_in_tools` to appear in `tools`, and you invoke it by returning an OpenAI tool call named `skip_turn`.
- Docs function-call format (non-streamed object, custom-llm.md and skip-turn.md):
  ```json
  {"type":"function","function":{"name":"skip_turn","arguments":"{\"reason\": \"User requested time to think\"}"}}
  ```
  `reason` is optional.
- Effect: "After this tool is called, the assistant will not speak. It waits for the user to re-engage or for another turn-taking condition to be met" (skip-turn.md). The SDK type comment says it only informs "the backend that the current turn generation is complete" (`el-js/api/types/SkipTurnToolConfig.d.ts`).
- **There is no ElevenLabs example of a streamed tool call.** The standard OpenAI streaming shape, which we expect ElevenLabs to accept, is:
  ```
  data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1759600000,"model":"interviewer-v1","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_skip_1","type":"function","function":{"name":"skip_turn","arguments":"{\"reason\":\"no authorization\"}"}}]},"finish_reason":null}]}

  data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1759600000,"model":"interviewer-v1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

  data: [DONE]
  ```
  Make this a preflight test (the plan already has "`skip_turn` honoured by custom-LLM path").
- **UNVERIFIED:**
  - whether ElevenLabs calls the LLM again with a `tool` result message after `skip_turn`. Make the handler idempotent: answer any follow-up with `skip_turn` or empty.
  - what happens if the custom LLM returns an **empty completion** (no content, no tool call, `finish_reason:"stop"`). Nothing in the ElevenLabs docs covers it. Don't rely on it for silence; use `skip_turn`.
- Latency tip (docs): stream a first chunk ending in `"... "` (ellipsis plus space) as "buffer words".
- Reasoning: stream it in `delta.reasoning` / `delta.reasoning_content`, never in content (custom-llm.md "Reasoning summary").

## 5. Agent Testing APIs — VERIFIED

| Purpose | Request | Response | SDK method |
|---|---|---|---|
| Create a test | `POST /v1/convai/agent-testing/create`. Body is one of three variants (`api-reference/tests/create.md`): `type:"llm"` `{name, chat_history[], success_condition, success_examples[{response,type:"success"}], failure_examples[{response,type:"failure"}], dynamic_variables?}`; `type:"tool"` `{name, chat_history[], tool_call_parameters:{referenced_tool:{id,type:"system"\|"client"\|...}, parameters:[{path, eval}], verify_absence?}, check_any_tool_matches?}`; `type:"simulation"` `{name, simulation_scenario, success_conditions[], simulation_max_turns (default 5), tool_mock_config?, evaluation_model?, simulated_user_model?}`. `chat_history` items: `{role:"user"\|"agent", time_in_call_secs, message}` | `{ id }` | `conversationalAi.tests.create(body)` (`tests/client/Client.d.ts`) |
| Run tests | `POST /v1/convai/agents/{agent_id}/run-tests` with `{ tests:[{test_id}], agent_config_override?, branch_id?, repeat_count? }` | `{ id, test_runs:[{test_run_id, status:"pending"\|"passed"\|"failed", ...}], ... }` (async) | `conversationalAi.agents.runTests(agentId, { tests:[{testId}] })` (`agents/client/Client.d.ts:228`) |
| Poll results | `GET /v1/convai/test-invocations/{id}` | invocation with test run statuses | `conversationalAi.tests.invocations.get(id)` |

- Other test endpoints: `GET/PUT/DELETE /v1/convai/agent-testing/{test_id}` and `GET /v1/convai/agent-testing`.
- Simulate-conversation: `POST /v1/convai/agents/{id}/simulate-conversation[/stream]`. The docs say "**Deprecated. This endpoint will be removed on 31 Oct 2026.**" (`api-reference/agents/simulate-conversation.md:8`). The SDK marks `simulateConversation` `@deprecated` (`agents/client/Client.d.ts:159-187`). Matches the plan.
- **UNVERIFIED:** whether tool tests or simulations exercise our custom-LLM endpoint the same way live sessions do. Presumably yes (the agent's configured LLM), but not confirmed.

## 6. Procedures — VERIFIED (the path exists)

Base: `/v1/convai/agents/{agent_id}/branches/{branch_id}/procedures` (`agents/resources/procedures/client/Client.d.ts`; `customization/procedures.md` "Manage via the API").

| Action | Request | Response / notes | SDK method |
|---|---|---|---|
| List | `GET …/procedures` | | `conversationalAi.agents.procedures.list(agentId, branchId)` |
| Create | `POST …/procedures` with `{ name?, content?, type?: "free_form"\|"deterministic"\|"folder" (default free_form), trigger?, folder_parent_id? }` | `{ procedure_id }` | `conversationalAi.agents.procedures.create(agentId, branchId, {...})` |
| Update draft | `PATCH …/procedures/{procedure_id}/draft` with `{ name, content, type, trigger? }`. **Send name, content, and type every time**; type cannot change | | `conversationalAi.agents.procedures.drafts.update(agentId, branchId, procedureId, {...})` |
| Get / delete | `GET`/`DELETE …/{id}`, `…/{id}/draft` | | |
| Compile | `POST …/procedures/compile` | marked "legacy" | |

- Publish with `PATCH /v1/convai/agents/{id}?branch_id=…` (`version_description`; optional `procedures` map `{procedure_id:{procedure_id, version_id}}`). This publishes every changed draft on the branch (procedures.md "Publish the changes"; `UpdateAgentRequest.d.ts`).
- `branch_id` comes from `GET /v1/convai/agents/{id}` → `main_branch_id` / `branch_id` (`api/types/GetAgentResponseModel.d.ts:25-28`).
- Drafts are per user and per branch. Content is capped at 50,000 chars.

## 7. Conversation retrieval — VERIFIED
- `GET /v1/convai/conversations/{conversation_id}?format=json|opentelemetry` returns:
  - `{ agent_id, conversation_id, status: initiated|in-progress|processing|done|failed, transcript:[{role:"user"|"agent", time_in_call_secs, message, tool_calls, tool_results, source_medium: audio|dtmf|text|image|file, interrupted, contextual_update_info, ...}], metadata, has_audio, has_user_audio, has_response_audio, analysis, conversation_initiation_client_data, ... }`
  - Source: `api-reference/conversations/get.md`. SDK: `conversationalAi.conversations.get(id)`.
  - `source_medium: "text"` should identify `sendUserMessage` turns. Inferred, UNVERIFIED.
- `GET /v1/convai/conversations/{conversation_id}/audio` returns a binary stream. SDK: `conversationalAi.conversations.audio.get(id)` → `ReadableStream<Uint8Array>`. The audio container/MIME type isn't stated in the docs (UNVERIFIED; check `Content-Type` at runtime).
- Wait for `status: "done"` before reading the final transcript or analysis.

---

## 8. Anthropic structured outputs — VERIFIED
- Shape: `messages.create({ ..., output_config: { format: { type: "json_schema", schema } } })`.
  - `JSONOutputFormat { schema: {[k]:unknown}; type: 'json_schema' }` — `anthropic/resources/messages/messages.d.ts:1886-1894`.
  - `OutputConfig.format` — same file, lines 2108-2121.
  - `MessageCreateParamsBase.output_config` — line 3611.
- **GA, no beta header, non-beta `client.messages`.** Sources: the doc frontmatter `status: ga`, and the cURL example sends only `anthropic-version: 2023-06-01` (`build-with-claude/structured-outputs.md`). `output_format` is deprecated in favour of `output_config.format`.
- **`claude-haiku-4-5-20251001` is supported.** It is in the `supportedModels` list in the doc frontmatter, along with `claude-sonnet-5-5`, `claude-opus-5-5`, and others.
- Zod helper:
  ```ts
  import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
  const r = await client.messages.parse({ model, max_tokens, messages, output_config: { format: zodOutputFormat(Schema) } });
  r.parsed_output; // typed
  ```
  - `anthropic/helpers/zod.d.ts:12` defines it; `messages.parse` is at `messages.d.ts:52`.
  - The helper imports `zod/v4`, so the app needs `zod@^3.25 || ^4` (SDK optional peer dependency). Install it, because the SDK does not.
  - No-Zod alternative: `jsonSchemaOutputFormat(schema as const)` from `@anthropic-ai/sdk/helpers/json-schema`. It does not validate the response.
- Schema rules (structured-outputs.md "JSON Schema limitations"):
  - **Every object needs `additionalProperties: false`.**
  - Not supported: recursive schemas, `minimum`/`maximum`/`multipleOf`, `minLength`/`maxLength`, array constraints except `minItems` 0/1, complex enum members, external `$ref`, and `allOf` with `$ref`.
  - Supported: `enum`, `const`, `anyOf`, internal `$ref`/`$defs`, string formats (`date-time`, `email`, `uri`, `uuid`, …), and simple regex `pattern`.
  - The SDK helpers move unsupported constraints into descriptions and add `additionalProperties:false`.
- Other behaviour:
  - Required properties are emitted before optional ones.
  - The first use of a schema has compile latency; compiled grammars are cached for 24 h.
  - Changing `output_config.format` invalidates the prompt cache.
  - Check `stop_reason` for `refusal` and `max_tokens` before parsing.
- Haiku 4.5 caveats: it uses `thinking: {type:"enabled", budget_tokens}` (no adaptive thinking), and `output_config.effort` is "Not supported" (models overview, "Default effort" row).

## 9. Prompt caching — VERIFIED
- Placement:
  - `cache_control: { type: "ephemeral", ttl?: "5m" | "1h" }` (`messages.d.ts:926-940`).
  - It can go on any content block: system text blocks (`system` must be the array-of-blocks form), tool definitions, and message content blocks.
  - Or put a single **top-level** `cache_control` on the request for automatic caching (`MessageCreateParamsBase.cache_control`, `messages.d.ts:3587`; prompt-caching.md "Automatic caching").
  - Max 4 breakpoints. Order is tools → system → messages.
- Minimum cacheable prefix (prompt-caching.md "Cache limitations"):
  - `claude-opus-5-5`: **512**
  - `claude-sonnet-5-5`: **512**
  - `claude-haiku-4-5-20251001`: **4,096**
  - Shorter prefixes silently don't cache.
- Verify with `usage.cache_read_input_tokens` / `cache_creation_input_tokens`.

## 10. Model IDs and images — VERIFIED
- The model IDs exist, both in the SDK `Model` union (`messages.d.ts:2107`: `'claude-sonnet-5-5' | 'claude-opus-5-5' | … | 'claude-haiku-4-5' | 'claude-haiku-4-5-20251001'`) and in the models overview "Claude API ID" row:

  | ID | Price (in / out) | Context | Thinking | Retirement (not sooner than) |
  |---|---|---|---|---|
  | `claude-opus-5-5` | $4 / $20 | 1M | adaptive, always on; default effort `medium` | Sep 22 2027 |
  | `claude-sonnet-5-5` | $2 / $10 | 1M | adaptive | Sep 28 2027 |
  | `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`) | $1 / $5 | 200K, 64K output | extended | **Oct 15 2026** |

- Image tokens: `⌈width/28⌉ × ⌈height/28⌉` (vision.md "Resolution and token cost"). Limits by tier:

  | Tier | Models | Max long edge | Max visual tokens |
  |---|---|---|---|
  | High-resolution | "Claude 4.7 and later models", which includes Opus 5.5 and Sonnet 5.5 | **2576 px** | 4784 |
  | Standard | all others, **including Haiku 4.5** | **1568 px** | 1568 |

  - Larger images are downscaled. Hard limits are 8000×8000 px, and 2000 px per side if a request has more than 20 images. Max size is 10 MB base64 on the Claude API.
  - The plan's figure is right for Haiku: 1568×882 → 56×32 = 1,792 tokens, about $0.0018 at $1/MTok. A frame re-read by `claude-opus-5-5` can use up to 4,784 tokens unless you downscale it first.

---

## Summary of DIFFERS / UNVERIFIED

DIFFERS FROM PLAN:
- React `startSession` returns `void` (1.16). Get the conversation id from `onConnect` / `getId()`.
- `setMicMuted` is not on the React hooks. Use `setMuted` / `micMuted` / provider `isMuted`.
- `custom_llm.api_key` must be `{secret_id}` or `{env_var_label}`. Create the secret with `POST /v1/convai/secrets`.
- Custom-LLM route: ElevenLabs appends `/chat/completions` to `url`, so `/api/llm` means handling `POST /api/llm/chat/completions`.
- Retention: the "2 years" default conflicts with the API's `retention_days` default of -1. Set it explicitly. Per-field deletion flags exist (`delete_audio`, `delete_transcript_and_pii`, `record_voice`). Per-agent `zero_retention_mode` exists; tier availability is unverified, and with ZRM on the transcript is unavailable from GET conversation.
- `@elevenlabs/elevenlabs-js` 2.70 validates enums strictly and drops unknown keys. Use raw JSON to create and update agents.

UNVERIFIED:
- Exact streamed SSE `tool_calls` shape accepted for `skip_turn`.
- Whether a follow-up LLM call happens after `skip_turn`.
- Behaviour on an empty completion.
- Whether `Authorization: Bearer` is the header used for `api_key`.
- Whether the server echoes `user_transcript` for `sendUserMessage` text.
- Whether `vad_score` is in the default `client_events`, and whether an explicit list replaces the defaults.
- How `pre_tool_speech` interacts with `skip_turn`.
- Audio MIME type of `/audio`.
- Whether agent tests hit the custom LLM.
- Per-agent ZRM plan tier.

---

## 11. Toolchain — DIFFERS FROM DEFAULTS
- `typescript@latest` is 7.0.2, the native (Go) compiler. Its package exports only `lib/version.cjs` and `unstable/*` APIs, with no classic compiler JS API (`npm view typescript@7.0.2 exports`). Next.js type-checking, drizzle-kit, typescript-eslint and our oracle scanner all load that API, so the repo pins **typescript 6.0.3**.
- pnpm 12.8.1 blocks dependency build scripts by default. Allowed packages are listed under `allowBuilds` in `pnpm-workspace.yaml` (esbuild, better-sqlite3), managed with `pnpm approve-builds <pkg>`.
- Next.js 16 `next-env.d.ts` imports `.next/types/*`, so `apps/web` typecheck runs `next typegen && tsc`.
- pnpm does not forward SIGTERM to its child. The deploy start command must exec the server directly (`tsx server.ts`), not `pnpm start`.

## 12. Facts verified during P0b — ElevenLabs
- **LLM cascading and retries — VERIFIED** (eleven-agents/customization/llm/llm-cascading.md; agents/create.md):
  - Custom LLMs never fall back to hosted models.
  - On errors, timeouts **or empty responses**, ElevenLabs retries the *same* custom LLM, at least 3 attempts.
  - Consequences for `/api/llm`:
    1. Never send an empty completion; the skip path always streams the `skip_turn` tool call.
    2. A nonce is `issued → in_flight → used`. It returns to `issued` if the speech stream aborts before completing, so a retry inside the TTL can still speak, exactly once.
  - We also set `backup_llm_config.preference: "disabled"`.
- **Default voice expiry — VERIFIED** (help-center/…/what-are-default-voices.md):
  - The agents-platform default `tts.voice_id` is `cjVigY5qzO86Huf0OWal` (agents/create.md).
  - Default voices "expire on December 31, 2026 and are only available for accounts created before March 2026". `agents:sync` validates the voice with `GET /v1/voices/{id}` and stops if it is missing.
- **Workspace secrets — VERIFIED** (api-reference/workspace/secrets/list.md, create.md):
  - `GET /v1/convai/secrets` takes `page_size`, `search`, `cursor` and returns `{secrets:[{type:"stored",secret_id,name,used_by}], next_cursor?}`.
  - Sync names the secret `vashistha_custom_llm_<sha256[:12]>`, so it is idempotent without reading the value back.
- **Signed URL — VERIFIED:** a `wss://…&conversation_signature=…` URL, valid for 15 minutes. Over WebRTC, `audio` events are not sent because LiveKit carries the audio; over the WebSocket they are. Preflight's voice probe uses the WebSocket for this reason.
- **Client overrides and auth — VERIFIED** (create.md, react.md):
  - Override flags under `platform_settings.overrides.conversation_config_override` are booleans that default to false. We set `first_message` and `prompt.llm` false explicitly and check this as an invariant.
  - `auth.enable_auth: true` makes conversations require a signed URL or a conversation token.
- **PATCH agent publishes drafts — VERIFIED** (agents/update.md): if `procedures` is omitted, pending procedure drafts are used. This matters for the Procedure export in P8.

## 13. Railway — DIFFERS FROM DEFAULTS
- Config as Code (`railway.json`/`railway.toml`) is **deprecated**. New services cannot opt in, and existing files stop being read on 2026-12-01 (docs.railway.com/infrastructure-as-code, line 32–40 of the saved page). We use `.railway/railway.ts` with the `railway` TypeScript SDK 3.12.0 and `@railway/cli` 5.63.1, both root dev dependencies.
- The IaC engine ships in the CLI (≥ 5.42.1), not the SDK. `railway config plan` needs a linked, authenticated project, so the file is typechecked against the SDK types but not yet planned live.
- Railway's default deployment draining is 0 s. We set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`.
- Volumes are mounted as root. The image's entrypoint `chown`s `$DATA_DIR`, then drops to `node` via `setpriv`.

## 14. Playwright browser install — DIFFERS FROM DEFAULTS
- `@playwright/test` is pinned to **1.63.0** (Chromium headless shell revision **1243**, Chrome for Testing 153.0.8010.12).
- On this network `npx playwright install chromium` fails ("Download failure, code=1"). The Chrome-for-Testing file itself is reachable, so the headless shell was installed manually:
  ```sh
  D=~/.cache/ms-playwright/chromium_headless_shell-1243 && mkdir -p $D && cd $D
  curl -fL -o hs.zip https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip
  python3 -c "import zipfile;zipfile.ZipFile('hs.zip').extractall('.')" && rm hs.zip
  touch INSTALLATION_COMPLETE DEPENDENCIES_VALIDATED
  ```
- `ldd` showed every shared library present (Debian 13), so no system packages were needed. On a machine where the normal installer works, use `pnpm --filter @vashistha/web exec playwright install chromium`.
