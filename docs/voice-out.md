# Voice out and local STT

## Spoken answers (TTS)

`tts` config (OpenAI-compatible `/audio/speech`, any baseUrl) + per-chat
`/voice on`. Flow: the final text is sent in full as always; if the chat has
voice on and `tts.enabled` is true, the answer is markdown-stripped, capped at
`tts.maxChars` on a sentence boundary, POSTed as
`{ model, voice, input, response_format: "opus" }`, and the returned bytes go
out via `Channel.sendVoice` (Telegram sendVoice, OGG/Opus). Any failure —
unconfigured key, bad endpoint, send error — is a `log.warn`; the text is the
contract, the audio is best-effort. API keys are never sent over cleartext to
non-loopback hosts (same rule as transcription).

## Local STT (whisper.cpp)

`voice.engine: "whisper-cpp"` switches transcription to
`ffmpeg -i <in> -ar 16000 -ac 1 -c:a pcm_s16le <tmp.wav>` then
`whisper-cli -m <model> -f <wav> -nt -np [extraArgs…]`. Temp WAVs are removed
in `finally`; the input file is still removed by the bridge after
transcription. Errors flow into the existing "Couldn't transcribe…" path.
Flags are the standard whisper.cpp ones; verify against your binary's
`--help` if it differs. `isTranscriptionConfigured` understands both engines.
