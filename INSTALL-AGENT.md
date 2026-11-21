# Installing Mind – instructions for the AI agent

You are an AI coding agent (Claude Code, Codex or similar) running on the user's Mac. The user wants Mind installed and set up.
Mind is a local mind map: the user sits at the centre, their areas of life and work are branches, and any node can become a bot
that works on it with the user's own Claude or ChatGPT subscription.

Follow these steps exactly. **Do not build, modify or "improve" the code** – the package is prebuilt and tested. Talk to the user
in short, friendly sentences; they may be using voice input, so ask one question at a time and keep answers brief.

## 1. Check the basics (say what you check, in one line)

- macOS is required. If this is not a Mac, stop and tell the user.
- Ask nothing yet – just run the installer.

## 2. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/MartinLiteAndFog/mind/main/install.sh | bash
```

It installs Node.js if needed (privately, no admin rights), downloads the prebuilt app to `~/Mind/app`, keeps data in
`~/Mind/data`, installs Claude Code if missing, creates `Mind.app` on the Desktop, sets up autostart and opens Mind.
If it prints that Claude Code is not logged in, ask the user to run `claude auth login` in Terminal (they choose their claude.ai
account; Mind never uses API keys). Report any error message verbatim and stop – do not patch files.

## 3. Setup interview

All setup goes through Mind's own tool `~/Mind/bin/mind` (it acts as the owner). Below, `mind` means `~/Mind/bin/mind`.

Ask these questions one by one and apply each answer right away:

1. **Name** – "What's your name?" → `mind owner "<name>"`
2. **Language** – "Should Mind speak English or German?" → `mind lang en` or `mind lang de`
3. **Ground rules** – run `mind rules`, then tell the user: "These are the current ground rules for all bots:" and summarise them
   in at most six very short bullet points (a few words each). Ask: "Keep them, or change something?"
   If they change something, write the full new rule list (one rule per line) with `mind set-rules "<rule 1>\n<rule 2>\n…"`.
4. **Main areas** – "Which main areas do you want in your map? For example work, projects, health, finances." For each:
   `mind add-child "<area>" --node owner` (the reply contains the new node id).
5. **Bots** – "Which of these areas should have a bot that works on its own?" For each chosen area, ask which subscription to use
   (Claude: `claude:sonnet` is a good default, `claude:opus` or `claude:fable` are stronger, `claude:haiku` is fastest;
   ChatGPT: `codex`) → `mind set-model <node-id> claude:sonnet`
6. **Work folders** – "Should a bot work in a folder on your Mac, e.g. a code project?" → `mind reich <node-id> --dirs "~/path/one,~/path/two"`.
   A bot may do anything inside its own branch and its work folders and nothing outside (enforced by a sandbox).
7. **Private areas** – "Is any area private, so other bots must not see it?" → `mind reich <node-id> --private on`
8. **Emails** – tell the user: bots draft emails but only send after an OK; this can be changed per bot later in Mind.

Finish with `mind setup-done`, then `mind tree` and read the tree back to the user in one or two sentences.

## 4. Hand over

Tell the user:
- Mind is on the Desktop (`Mind.app`) and starts automatically after login.
- Click a node to talk to its bot; the bot ends each answer with "On OK I will: …" – pressing OK lets it continue.
- The cockpit (top right) collects everything that needs them.

Do not change anything else on the system. If something fails, show the exact error and the log `~/Mind/mind.log`.
