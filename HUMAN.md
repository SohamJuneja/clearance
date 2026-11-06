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

- [ ] **Study recruitment: send this morning** to classmates, community groups and Discord servers. Target 20 sign-ups to land 12 to 16 people. Why: the human study is one of the things only we have, and I can't recruit people. Copy this:
  > Hi! We're building Clearance for the Flip the Switch hackathon: it decides who should approve what an AI agent wants to do. We need 15 minutes of your time on Fri Nov 6 (21:00-23:30 IST) or Sat Nov 7 (09:30-12:30 IST). You'll approve or deny 24 short requests in a chat window in your browser. No install, no personal data, no real money. Reply to this message and I'll send you your link. Thank you!

  Consent is inside the link, so there's no form to set up. Tell me how many people replied. Each person gets their own, and participants must be 18 or older.

- [ ] **Open the study to people, and look at it on your phone first (5 minutes).** My permission check refused the public tunnel, so this one is yours. It only exposes the Lab, and each link is signed. For your own look, use rehearsal mode so nothing counts:
  ```bash
  cd /home/prashant/projects/Clearance
  STUDY_DRY_RUN=1 STUDY_RESULTS_DIR=/tmp/lab-rehearsal pnpm study:start      # terminal 1, leave it running
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:7950             # terminal 2, prints an https://...trycloudflare.com address
  pnpm study:links https://THAT-ADDRESS 20                                   # terminal 3, prints the links and sends nothing
  ```
  Open any link on your phone and go at least as far as a practice card. A whole run now passes at phone size in Chromium and in WebKit, which is close to Safari but isn't iOS. Only a real phone can show these, so look for them: does the keyboard cover Send on a typed card, does autocorrect leave a value like `kfin` alone, does the back button come back to the right card, and is a quick deliberate tap ever ignored? There's a 600 ms guard after each card appears, because a double tap was scoring a card nobody had read. For the real sessions, stop terminal 1 and run plain `pnpm study:start`, then send one link per person from what `study:links` printed. Keep both terminals open during sessions (Fri 21:00-23:30, Sat 09:30-12:30). If the tunnel restarts, its address changes, so rerun `study:links` with the new one.

- [ ] **Listen to the video once, 3 minutes.** `docs/media/raw/clearance-demo.mp4`, the 2:44 cut I sent you. I can read every frame but I can't hear anything, so the offline voice is unchecked by anyone. Tell me if a word is mispronounced, or if it sounds too robotic to use. The agents' words are real, so tell me about anything that reads wrong too, and I'll fix it or say why not.

- [ ] **Clear our leftover test folders from `/tmp` (1 minute, please do this before anything else).** Our tests left over 13,000 folders there, about 6 GB in RAM-backed storage, which is why the machine ran out of memory at 14:31. The leak is fixed, but my permission check refused the cleanup because `/tmp` is shared. This only removes folders named `clearance-*` that you own and that are over 5 minutes old:
  ```bash
  find /tmp -maxdepth 1 -type d -name 'clearance-*' -user "$USER" -mmin +5 -prune -exec rm -rf {} +
  df -h /tmp
  ```

- [ ] **1. Free RAM: close what you don't need.** The machine has 14 GB, about 12 GB in use and 11 GB already in swap, which is the OOM risk we've hit before. Switch, Mattermost and four agents need 4 to 6 GB free.
  - Close Chrome (or most tabs), Discord and Claude desktop if you don't need them while recording, E2 or the study runs. VS Code alone is holding about 5 GB, and the machine ran out of memory once already, at 14:31 on Friday, so close spare windows.
  - Optional: your other project containers and Redis use memory too. I won't touch them, because they aren't mine. If you're fine with it:
    ```bash
    docker stop sr-prod-pg faultline-falkordb
    ```
  - Why: running out of memory kills whatever is running. Deadline: before E2 or the study starts.

- [ ] **2. Stay plugged in, Docker running, lid open.** I've started a sleep inhibitor for the session (`systemd-inhibit`, runs about 50 h, no sudo). To be safe, also run this:
  ```bash
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
  gsettings set org.gnome.desktop.session idle-delay 0
  ```
  Why: a suspended laptop stops the evals and the study's tunnel. Deadline: now, and until we submit.

- [ ] **3. Install and log in to Cursor CLI.** My permission rules block `curl | bash`, so this one is yours (1 minute):
  ```bash
  curl https://cursor.com/install -fsS | bash
  agent login
  ```
  Why: Cursor is the fourth vendor in E2. If you skip it, the coverage table says "untested" for Cursor, which is fine and honest. Deadline: before E2 starts, to be in it.

- [ ] **4. Log in to Codex** (`codex login status` currently says "Not logged in"):
  ```bash
  codex login
  ```
  Why: support-agent in SC5 runs on Codex, and it's the scene the video is missing. Deadline: before E2 starts, then I'll record SC5. If you'd rather use the API key from step 5, run `printenv OPENAI_API_KEY | codex login --with-api-key` after you've set it.

- [ ] **Know this:** until an Anthropic key is in, Claude agents use a copy of your Claude access token (no refresh token), kept fresh by a background loop for each controller that makes a small call on your login. To stop all of it: `scripts/setup-controller.sh --owner priya --stop` (same for `alex`). Adding the key replaces it with an isolated home.

- [ ] **5. Paste API keys into `.env`** at the repo root, **the Anthropic one first**. This is now a safety item: without an Anthropic key, Switch's Claude agents run on your own Claude login, and that login carries your claude.ai connectors, including Gmail `send_message` and Drive `share_file`. The spikes never called them. I've added deny rules at two levels, but one sits in a file an agent can edit. An API key removes the connectors completely. Until you add one I keep agent runs small and Haiku-only. I've prepared the exact lines, so just fill in the values:
  ```bash
  code /home/prashant/projects/Clearance/.env
  ```
  ```
  ANTHROPIC_API_KEY=      # Claude agents in E2. Without it the agents use your Claude login.
  OPENAI_API_KEY=            # Codex agent.
  CLEARANCE_OPENCODE_MODEL=  # Optional, as provider/model, like anthropic/claude-haiku-5-5. Blank means just demo tries OpenCode's free models and uses the first that answers and can call a tool. They change and run out, so it may find none, and then only the OpenCode scene is lost. Only synthetic data goes to them.
  OPENCODE_PROVIDER_KEY=     # Optional, and only with a model above, for that model's provider. It goes in the fenced home of the two OpenCode machines, and an agent there can read it, so use a key with a low limit.
  ```
  Run `just demo` again after changing either OpenCode line. It updates the running agents, so not during a recording.
  Why: it replaces your login for agents, and E2's Claude runs wait for it. `.env` is gitignored and I never print it. Deadline: today, so E2 can finish before G4.

- [ ] **5a. Start E2 now, the cross-vendor run. It's ready, on the fixed code, and only you can start it.** My permission check refused its test run, twice now, so I won't try again or look for another way. It's the one big number still blank in `RESULTS.md`. Run OpenCode's part now, since it needs no key and doesn't touch your Claude login. Clear `/tmp` first, and tell me before you start, so nothing else is using the stack:
  ```bash
  cd /home/prashant/projects/Clearance
  just demo                                            # makes sure the stack is on the latest code
  pnpm eval:vendors --dry-run --vendor opencode
  pnpm eval:vendors --probe --vendor opencode          # about 4 short runs. Read what it prints, and tell me if anything looks off
  CLEARANCE_EVAL_E2_GO=1 pnpm eval:vendors --go --vendor opencode --usd-per-run 0
  ```
  That's 80 runs on OpenCode's free model, up to about 3 hours, and it holds the stack the whole time, so keep the terminal open. The free model can run out partway: those runs are counted as errors, not as prevented, so a low count of real runs is what to tell me about. It also behaves inconsistently, declining by itself in some runs, so the results name the model. After your Anthropic key is in, run Claude's part the same way:
  ```bash
  CLEARANCE_EVAL_E2_GO=1 pnpm eval:vendors --go --vendor claude --claude-model haiku --usd-per-run 0.05
  ```
  That's 120 runs. The script books a flat $6.00 against the $35 cap, and I estimate about $1 at token prices, from sessions that weren't E2 runs. If you kill either one, run `pnpm exec tsx scripts/setup-e2.ts --restore`. Setup also wrote a test marker to `~/.clearance-e2-canary` in your home folder. Deadline: finished by Sat 13:00.

- [ ] **6. Confirm the spend cap.** The default is **₹3,000 (about $35) total for eval runs**, tracked in `eval/costs.json`. I stop E2 and ask before passing it. Set a hard limit on each key in the provider dashboards too, if they offer one. Reply only if you want a different cap.

- [ ] **7. Keep Wispr Flow on** and dictate your messages to me from now on (Code with Wispr track). Take the Insights screenshot on Saturday at 19:00.

- [ ] **8. If you and Soham haven't settled on his repo by tonight, create yours** (1 minute). Use 0b if he agrees, and this if not, because CI can't run until something is pushed. My permission check refused `gh repo create` and `git push`, so you run it:
  ```bash
  cd /home/prashant/projects/Clearance && gh repo create clearance --private --source . --remote origin --push
  ```
  For later pushes, either let me do them by allowing `Bash(git push:*)` in your Claude Code permissions (`/permissions`), or run `git push` yourself whenever I ask. I run `gitleaks detect` first either way.
  Why: G1 needs the repo pushed, and that deadline has passed. Commits stay local until then, so nothing is lost, but a CI failure stays hidden.

- [ ] **9. Optional: post these in the WeMakeDevs Discord** and paste the answers into `DECISIONS.md` or send them to me. Ready to copy:
  > Hi! A few quick questions about Flip the Switch:
  > 1. Is there a maximum video length, and what are the exact submission form fields?
  > 2. Track 03: the page says to comment, tag @petr-sandbox and wait to be assigned, but maintainers wrote on #800 and #805 that they won't assign issues and anyone may solve any. Which rule applies?
  > 3. Is "Track 04 Best Integration or Extension" (only on the DevTools Academy page) a real prize, and can one project enter it alongside Track 01?
  > 4. Can one project win Track 01 and side tracks at the same time? Is it one submission per team?
  > 5. May people outside the registered team appear in the demo and the user study as chat users?

---

## LATER (I'll mark these NOW when their time comes)

- [ ] **Make the repos public** (needs your OK; I run the command after you tick). Must happen before submission.
- [ ] **Track 03, your call (15 minutes decides it).** I've built the Canva connector locally for #833, in `/home/prashant/projects/switch-track03`, with nothing pushed or posted. It hinges on one thing: an open PR reports Canva's MCP server answering `500` to developer apps, which would make the required video impossible. To find out, make a Canva developer app and run the probe, `spikes/track03/canva-gate.mjs`; `docs/track03.md` has the exact steps. If it fails, drop Track 03, which costs you only those 15 minutes. If it works, the rest takes about 1.5 to 2 hours, and the demo stack has to be stopped for the hand QA, so tell me first. Do this only after E2 and the study are out of the way. Deadline: PR open by Sat 23:59 IST.
- [ ] **Voice-over (optional, 15 minutes).** Your voice is better than the offline one if you have time: drop files at `scripts/video/voice/<scene>.wav` and they win over it. The script is in `scripts/video/scenes.yaml`, one `voiceover` per scene.
- [ ] **Optional, stronger anti-evasion:** needs sudo for `/etc/claude-code/managed-settings.json`, which agents can't edit. Not tested yet. I'd only use it if you want it for the demo host.
- [ ] **Skip: the `!list-documents` crash** is already reported, with PR #1286 open upstream. Nothing to do.
- [ ] **Blog:** draft at `docs/blog-draft.md`, written as you, in first person. Please read it, since it speaks for you, and change anything that isn't how you'd say it. `pnpm numbers:fill` fills the `{{...}}` numbers from the eval results at the end. Post on dev.to or Hashnode when I say it's final.
- [ ] **Three #HowISwitch posts.** Text is in `docs/social-draft.md`, written as you, so change what isn't how you'd say it. The clips are `docs/media/social/post-1.mp4` and `post-2.mp4`. They're ready. Nothing gets posted until you do it or tick this.
- [ ] **Submission form.** Text is in `docs/submission-draft.md`. `pnpm numbers:fill` turns it into `SUBMISSION.md` with numbers and links filled in, once the repo has a remote. You add the team members, video link, blog link and Wispr screenshots.
