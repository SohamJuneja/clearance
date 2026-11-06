# HUMAN: things only you can do

Everything else is being done without you. Tick a box when done (or just tell me). I never block on these; I keep working around them.

---

## NOW

- [ ] **0a. Get on the team page.** Sign in on wemakedevs.org and have Soham add you to the team, star `sandbox-quantum/switch` through the event link, and join the WeMakeDevs Discord. Why: only listed members count, and this is on his plan as B-0. I can't check it from here. Deadline: now.

- [ ] **0b. Agree one codebase with Soham, on a 10-minute call.** Message is in the chat. Don't run anything on his repo until he says yes. Then:
  ```bash
  cd /home/prashant/projects/Clearance
  git remote add origin git@github.com:SohamJuneja/clearance.git
  git fetch origin master
  git tag soham-python-first-cut origin/master
  git merge -s ours --allow-unrelated-histories origin/master -m "chore: build on the full implementation, keeping Soham's first commits in history"
  gitleaks detect --source . --redact --no-banner
  git push origin main:master
  git push origin soham-python-first-cut
  ```
  Never add `--force`. If the push is rejected, he pushed something new, so tell me. Dry-run on a copy: files match ours, both histories are kept, secret scan clean.

- [ ] **1. Free RAM: close what you don't need.** The machine has 14 GB, about 12 GB in use and 11 GB already in swap, which is the OOM risk we've hit before. Switch, Mattermost and four agents need 4 to 6 GB free.
  - Close Chrome (or most tabs), Discord and Claude desktop if you don't need them tonight.
  - Optional: your other project containers and Redis use memory too. I won't touch them, because they aren't mine. If you're fine with it:
    ```bash
    docker stop sr-prod-pg faultline-falkordb
    ```
  - Why: an OOM kills the build overnight. Deadline: before you sleep.

- [ ] **2. Stay plugged in, Docker running, lid open.** I've started a sleep inhibitor for the session (`systemd-inhibit`, runs about 50 h, no sudo). To be safe, also run this:
  ```bash
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
  gsettings set org.gnome.desktop.session idle-delay 0
  ```
  Why: a suspended laptop stops the overnight work and the evals. Deadline: before you sleep.

- [ ] **3. Install and log in to Cursor CLI.** My permission rules block `curl | bash`, so this one is yours (1 minute):
  ```bash
  curl https://cursor.com/install -fsS | bash
  agent login
  ```
  Why: Cursor is the fourth vendor in E2. If you skip it, the coverage table says "untested" for Cursor. Deadline: before you sleep; it's fine if it slips to the morning.

- [ ] **4. Log in to Codex** (`codex login status` currently says "Not logged in"):
  ```bash
  codex login
  ```
  Why: support-agent in SC5 runs on Codex. Deadline: before you sleep. If you'd rather use the API key from step 5, run `printenv OPENAI_API_KEY | codex login --with-api-key` after you've set it.

- [ ] **Know this:** until an Anthropic key is in, Claude agents use a copy of your Claude access token (no refresh token), kept fresh by a background loop for each controller that makes a small call on your login. To stop all of it: `scripts/setup-controller.sh --owner priya --stop` (same for `alex`). Adding the key replaces it with an isolated home.

- [ ] **5. Paste API keys into `.env`** at the repo root, **the Anthropic one first**. This is now a safety item: without an Anthropic key, Switch's Claude agents run on your own Claude login, and that login carries your claude.ai connectors, including Gmail `send_message` and Drive `share_file`. The spikes never called them. I've added deny rules at two levels, but one sits in a file an agent can edit. An API key removes the connectors completely. Until you add one I keep agent runs small and Haiku-only. I've prepared the exact lines, so just fill in the values:
  ```bash
  code /home/prashant/projects/Clearance/.env
  ```
  ```
  ANTHROPIC_API_KEY=      # Claude agents in E2. Without it the agents use your Claude login.
  OPENAI_API_KEY=         # Codex agent, and OpenCode's provider if you have no other key
  OPENCODE_PROVIDER_KEY=  # Optional. Blank means the free hosted opencode/big-pickle model, which already passes S5. Only synthetic data goes to it. Fill this in if you'd rather not use a free hosted model.
  ```
  Why: agents can't run without a provider. `.env` is gitignored and I never print it. Deadline: before you sleep, because S5 and S9 need these keys.

- [ ] **5a. Start E2, the cross-vendor run, when you're ready.** It's the one big number still blank in RESULTS.md, and two things stop me starting it: my permission check refused its test run, and I said I'd wait for your API key before spending on Claude. After step 5, and after I tell you recording is done, because E2 holds the shared stack for hours:
  ```bash
  cd /home/prashant/projects/Clearance
  bash scripts/services.sh down && bash scripts/services.sh up
  bash scripts/setup-controller.sh --machine clearance-priya-open-base --restart
  pnpm exec tsx scripts/setup-e2.ts
  pnpm eval:vendors --dry-run
  pnpm eval:vendors --probe
  CLEARANCE_EVAL_E2_GO=1 pnpm eval:vendors --go --claude-model haiku --usd-per-run 0.05
  ```
  What it costs: 200 runs. The script books a flat $10.00 against the $35 cap. My estimate at token prices is about $1 for the 120 Claude runs, from 36 earlier sessions that weren't E2 runs. The other 80 use OpenCode's free model. It can take up to 7 to 8 hours. Codex and Cursor show as blocked, not zero, unless you've done steps 3 and 4. Parts of this setup have never run live, so read the probe's output first and tell me if anything looks off. If you kill `--go`, run `pnpm exec tsx scripts/setup-e2.ts --restore`. Setup also wrote a test marker to `~/.clearance-e2-canary` in your home folder. Deadline: start by Sat 03:00 so it can finish before G4.

- [ ] **6. Confirm the spend cap.** The default is **₹3,000 (about $35) total for eval runs**, tracked in `eval/costs.json`. I stop E2 and ask before passing it. Set a hard limit on each key in the provider dashboards too, if they offer one. Reply only if you want a different cap.

- [ ] **7. Keep Wispr Flow on** and dictate your messages to me from now on (Code with Wispr track). Take the Insights screenshot on Saturday at 19:00.

- [ ] **8. Create the private GitHub repo and let me push** (1 minute). My permission check refused `gh repo create` and `git push`, so you decide. Run this to create the repo privately and push what exists:
  ```bash
  cd /home/prashant/projects/Clearance && gh repo create clearance --private --source . --remote origin --push
  ```
  For later pushes, either let me do them by allowing `Bash(git push:*)` in your Claude Code permissions (`/permissions`), or run `git push` yourself whenever I ask. I run `gitleaks detect` first either way.
  Why: G1 needs the repo pushed, and CI can't run until it is. Commits stay local until then, so nothing is lost. Deadline: Fri 11:00.

- [ ] **9. Optional (only if you're still awake): post these in the WeMakeDevs Discord** and paste the answers into `DECISIONS.md` or send them to me. Ready to copy:
  > Hi! A few quick questions about Flip the Switch:
  > 1. Is there a maximum video length, and what are the exact submission form fields?
  > 2. Track 03: the page says to comment, tag @petr-sandbox and wait to be assigned, but maintainers wrote on #800 and #805 that they won't assign issues and anyone may solve any. Which rule applies?
  > 3. Is "Track 04 Best Integration or Extension" (only on the DevTools Academy page) a real prize, and can one project enter it alongside Track 01?
  > 4. Can one project win Track 01 and side tracks at the same time? Is it one submission per team?
  > 5. May people outside the registered team appear in the demo and the user study as chat users?

---

## LATER (not needed tonight; I'll mark these NOW when their time comes)

- [ ] **Study recruitment: send on Friday morning** to classmates, community groups and Discord servers. Target 20 sign-ups to land 12 to 16 people. Why: the human study is one of the things only we have, and I can't recruit people. Copy this:
  > Hi! We're building Clearance for the Flip the Switch hackathon: it decides who should approve what an AI agent wants to do. We need 15 minutes of your time on Fri Nov 6 (21:00-23:30 IST) or Sat Nov 7 (09:30-12:30 IST). You'll approve or deny 24 short requests in a chat window in your browser. No install, no personal data, no real money. Reply to this message and I'll send you your link. Thank you!

  Consent is inside the link, so there's no form to set up. Tell me how many people replied and I'll generate that many links. Each person gets their own, and participants must be 18 or older.
- [ ] **Look at the study on your phone** before the first participant (2 minutes). No real browser has rendered it on a phone yet. I'll mark this NOW and send the link when it's up.
- [ ] **Make the repos public** (needs your OK; I run the command after you tick). Must happen before submission.
- [ ] **Track 03, your call (15 minutes first).** #803 is crowded (3 PRs following the maintainer's direction). My recommendation is **#833 Canva**: one open PR, with no video. It needs you to make a Canva developer app that accepts a loopback redirect; nobody has reported that working, so it's a real gate. If it fails and you have no Factory login for #783, I'd drop Track 03 rather than file a weak PR. Steps, comment text and design are in `docs/track03.md`, and nothing is posted. You'd also sign the CLA. A maintainer ruled on Oct 29 that everyone is assigned, PRs are reviewed after the window, and one PR is selected per issue, which also answers your Discord question 2. Tell me "go" or "drop".
- [ ] **Voice-over (optional, 15 minutes).** The offline TTS (Piper) version works, but I can't hear audio, so please listen to it once when the first cut exists. Your voice is better if you have time: drop files at `scripts/video/voice/<scene>.wav` and they win over TTS. Script will be here.
- [ ] **Optional, stronger anti-evasion:** needs sudo for `/etc/claude-code/managed-settings.json`, which agents can't edit. Not tested yet. I'd only use it if you want it for the demo host.
- [ ] **Skip: the `!list-documents` crash** is already reported, with PR #1286 open upstream. Nothing to do.
- [ ] **Blog:** draft at `docs/blog-draft.md`, written as you, in first person. Please read it, since it speaks for you, and change anything that isn't how you'd say it. I fill the `{{...}}` numbers from RESULTS.md at the end. Post on dev.to or Hashnode when I say it's final.
- [ ] **Three #HowISwitch posts.** Ready to post here with clips once the takes exist.
- [ ] **Submission form.** `SUBMISSION.md` will have every field filled in.
