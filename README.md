# Hermes Watch

Talk to [Hermes Agent](https://github.com/NousResearch/hermes-agent) from an Amazfit watch. Tap **TALK**,
speak, and read the answer on your wrist, with no phone in your hand. That includes approving the code
changes Hermes hands to Claude Code.

Built for the Amazfit Active 2 (Zepp OS); other round Zepp OS 4 watches should need only small changes.

## What it does

- **Voice in, text out.** The watch records Opus audio; your PC transcribes it with Whisper and asks Hermes.
- **Long conversations.** Every question continues the same Hermes session until 6 idle hours pass, or you
  tap **New chat** or say "start new session".
- **Approve / Deny on the watch.** When Hermes asks for approval (for example Claude Code wanting to edit
  files or build something), the watch shows a card with **Approve**, **Deny** and **Reply**.
- **Builds finish in the background.** After Approve you can close the app: the result is posted to your
  Telegram (which buzzes the watch), and reopening the app shows it.
- **Survives the screen timing out.** The app saves its screen and reopens where you left off, including
  answers that arrived while it was closed.
- **Safe actions.** Texts, car commands and a PC restart are recognised in plain code, never by the model,
  and only run after you tap **Yes**.
- **Quick local answers.** "PC health check" is answered by the relay itself in a few seconds.

## How it works

```
watch app (Zepp OS)
  -> Zepp app on the phone (side service)
  -> https://<your-pc>.<tailnet>.ts.net:8453   (Tailscale, tailnet only)
  -> relay.js on the PC (127.0.0.1:8796)
       -> stt/stt_worker.py (127.0.0.1:8797, faster-whisper)
       -> Hermes Agent API server (127.0.0.1:8642), streamed, one "watch-..." session
```

Hermes turns are streamed so the relay can see `approval.request` events and turn them into watch cards; the
choice goes back with `POST /v1/runs/{run_id}/approval`. Answers that take longer than 12 s become a job the
watch polls, because the phone's network calls drop replies that take 20 s or more.

## Requirements

- Amazfit Active 2 (or similar Zepp OS 4 watch) and the Zepp app on your phone
- A Windows PC running [Hermes Agent](https://github.com/NousResearch/hermes-agent) with its API server on
- Node.js 20+, Python 3.10+
- [Tailscale](https://tailscale.com) on the PC and the phone
- The [Zeus CLI](https://docs.zepp.com/docs/guides/tools/cli/) (`npm i -g @zeppos/zeus-cli`) and a Zepp
  developer account
- Optional: local MCP servers for texts and a Tesla (`WATCH_TEXT_MCP`, `WATCH_TESLA_MCP`), Hermes MCP tools for
  Gmail and Claude Code (the prompt in `lib/watch-prompt.js` names the tools this was built with; rename them
  to match yours)

## Setup

1. **Config.** Copy `config.example.json` to `config.json` and fill it in. `token` is any long random string;
   the watch app and the relay share it. Never commit `config.json`.
2. **Speech-to-text.**
   ```
   python -m venv stt\.venv
   stt\.venv\Scripts\pip install -r stt\requirements.txt
   stt\.venv\Scripts\python stt\stt_worker.py
   ```
3. **Relay.** Put Hermes' `API_SERVER_KEY` in `%LOCALAPPDATA%\hermes\.env` (the relay reads it from there,
   along with `TELEGRAM_BOT_TOKEN` / `TELEGRAM_HOME_CHANNEL` for build results), then:
   ```
   node relay.js
   tailscale serve --bg --https=8453 http://127.0.0.1:8796
   ```
4. **Watch app.** Register an app in the Zepp developer console and put its id in `zepp-app/app.json`, then:
   ```
   cd zepp-app
   npm ci
   node build.mjs
   zeus preview -t "Amazfit Active 2 (Round)"
   ```
   Scan the QR code in the Zepp app.

Run the PC parts as scheduled tasks if you want them to start with Windows.

## Relay API

All but `/health` need `Authorization: Bearer <token>`.

- `POST /watch/ask` `{audio_b64}` or `{text}` -> `{ok, heard, kind: answer|confirm|working, text, id?, job?, approve?}`
- `POST /watch/confirm` `{id, yes}` -> the next reply (Yes/No cards last 60 s, Approve cards ~5 min)
- `GET /watch/result?job=` -> `{kind: working}` until a slow answer (or the next Approve card) is ready
- `GET /watch/last` -> the latest reply plus `ago_ms`, for a watch that closed mid-question
- `GET /health` -> `{ok, stt, hermes}`

## Security notes

- The relay listens on `127.0.0.1` only; Tailscale `serve` (not `funnel`) keeps it inside your tailnet.
- Every request needs the shared token. The token is written into the watch app at build time
  (`zepp-app/app-side/token.js`, git-ignored).
- Hermes is told never to call text/car tools itself; those run only through the relay's Yes cards.
- Approvals are always "once": nothing is approved for the rest of a session from the watch.

## Troubleshooting

- **"The phone isn't answering" / "shake timeout"**: Bluetooth is up but iOS put the Zepp app to sleep. Open
  Zepp on the phone; turn on Background App Refresh for it. The watch already retries for 30 s.
- **Nothing reaches the PC**: check that the phone is connected to Tailscale (`tailscale ping <phone>`).
- **Logs**: `relay.log` (every request), `stt/stt.log`.

## Tests

```
node --test "test/*.test.js"
cd zepp-app && node --test test/*.test.mjs
stt\.venv\Scripts\python -m unittest stt/test_stt_worker.py
```

## License

MIT
