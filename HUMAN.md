# HUMAN: things only you can do

Everything else is being done without you. Tick a box when done (or just tell me). I never block on these; I keep working around them.

---

## NOW (about 15 minutes, then go to sleep)

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

- [ ] **5. Paste API keys into `.env`** at the repo root. I've prepared the exact lines, so just fill in the values:
  ```bash
  code /home/prashant/projects/Clearance/.env
  ```
  ```
  ANTHROPIC_API_KEY=      # Claude agents in E2. Without it the agents use your Claude login.
  OPENAI_API_KEY=         # Codex agent, and OpenCode's provider if you have no other key
  OPENCODE_PROVIDER_KEY=  # OpenCode has 0 credentials right now. Leave blank to reuse OPENAI_API_KEY.
  ```
  Why: agents can't run without a provider. `.env` is gitignored and I never print it. Deadline: before you sleep, because S5 and S9 need these keys.

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

- [ ] **Study recruitment** (send Friday morning; slots are Fri 21:00 to 23:30 and Sat 09:30 to 12:30 IST). Text and link will be here when the Approval Lab is ready.
- [ ] **Make the repos public** (needs your OK; I run the command after you tick). Must happen before submission.
- [ ] **Track 03 comment on #803 and the PR from a fork**, plus signing the CLA. Text will be here.
- [ ] **Voice-over (optional, 15 minutes).** I'll make a TTS version; your voice is better if you have time. Script will be here.
- [ ] **Blog and three #HowISwitch posts.** Ready to post here with clips.
- [ ] **Submission form.** `SUBMISSION.md` will have every field filled in.
