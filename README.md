# Mind

A local mind map for your work and life – and every node can be an AI bot that works on it with **your own Claude or ChatGPT
subscription** (no API keys, no cloud backend). Runs on macOS.

- **You at the centre**, your areas as branches, details below.
- **Bots per node**: Claude (Claude Code) or ChatGPT (Codex) work on their branch: research, code, PDFs, drafts.
- **Realms**: each bot may do anything inside its own branch and its work folders – and nothing outside (sandboxed).
  Outside its realm it asks its chief bot, up to you.
- **"On OK I will …"**: every bot announces its next step; one click on OK lets it continue.
- **Cockpit**: everything that needs you – blockers, questions, OKs – in one place.
- Your data stays on your Mac (`~/Mind/data`).

## Install

The easiest way: open **Claude Code** (included in Claude Pro/Max – in the Claude desktop app choose "Code") or **Codex**
(included in ChatGPT Plus/Pro) and say:

> Install Mind for me: https://github.com/MartinLiteAndFog/mind – follow INSTALL-AGENT.md

The agent installs everything and then asks you a few setup questions (name, language, ground rules, areas, bots).
You can answer by voice.

Manual install:

```bash
curl -fsSL https://raw.githubusercontent.com/MartinLiteAndFog/mind/main/install.sh | bash
```

Requirements: macOS, a Claude Pro/Max or ChatGPT Plus/Pro subscription, Google Chrome (window and PDF export).
Node.js is installed automatically if missing.

## Update

Run the install command again – the code is replaced, your data stays.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/app.mind.server; rm ~/Library/LaunchAgents/app.mind.server.plist
rm -rf ~/Desktop/Mind.app ~/Mind/app      # ~/Mind/data holds your map – delete it only if you want it gone
```
