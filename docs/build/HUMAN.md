# HUMAN: things only you can do

Everything else is being done without you. Tick a box when done (or just tell me). I never block on these; I keep working around them.

---

## NOW

- [ ] **Record your voice and face (about 10 minutes).** The script is `~/Downloads/clearance-voiceover-script.md`: 26 lines, each read twice with 2 seconds of silence, looking at the lens, in one video saved as `~/Downloads/clearance-vo.mp4`. Then tell me, and one rebuild swaps the narrator for you: `python video/owner_takes.py ~/Downloads/clearance-vo.mp4`, then `VOICE=owner TAG=final bash video/rebuild.sh`. If there's no time, the narrator cut is complete as it is.

- [ ] **Upload the film to YouTube (unlisted or public), then send me the link.** The file is `~/Videos/clearance/clearance-<latest>.mp4` (1080p, -14 LUFS). Title, description, chapters and sources are in `video/YOUTUBE.md`; the thumbnail is `~/Videos/clearance/thumbnail.png`. Captions are burned in, so don't upload the .srt. With the link I add it to the README, the site and the submission text.

- [ ] **Soham: deploy the site from the repo.** Vercel, Add New Project, import `SohamJuneja/clearance`, framework Other, no build command, output directory `site/dist`. Every push to `master` then updates it. Your own Vercel copy (clearance-site-brown.vercel.app) is the older page and doesn't update by itself.

- [ ] **Decide on a licence notice for the site's playground.** `site/dist/playground.js` bundles zod, yaml and jsep (MIT and ISC licences), whose packages ship no licence text. MIT asks that its notice travel with copies. Your call whether to add a notices file; I haven't added one, as credits and notices are yours to write.

- [ ] **0a. Get on the team page, and rename the team `dellfargo` there.** The repo now says `dellfargo`, and the page has to match. Sign in on wemakedevs.org and have Soham add you to the team, star `sandbox-quantum/switch` through the event link, and join the WeMakeDevs Discord. Why: only listed members count, and this is on his plan as B-0. I can't check it from here. Deadline: now.

- [x] **0b. Pushed to Soham's repo.** `master` is on our code, with his 5 commits kept and his old code tagged `soham-python-first-cut`. Next: send Soham the message from the chat. Pushes from now on are `git push` from `main`, never `--force`.

- [ ] **Send Soham this, once the fixes are pushed.** His review found real breaks, and a second look at the fixes is worth more than anything else he could do before the freeze.
  > Your review was really useful, thanks. I reran every finding on current code, since you reviewed `43a468e`. H1 was already closed. H2, H3, M1, M2, M4, L1 and L2 are fixed, and they're re-checked in `pnpm eval:authority --group sixth-review`. M3 isn't real on Mattermost: Switch's adapter returns on anything but `posted` (`mattermost/adapter.py:2766`). The hook files are now read-only in the fence as well as denied, and we found one more ourselves, Claude's machine-wide settings file. REVIEW.md is on master under your name. Could you pull master and try to break the fixes? H2 and the fence matter most. `scripts/check-fence.sh --live` shows what's locked from inside, and the limits we kept are in `docs/threat-model.md`. Then please do your half of the E3 labels if you haven't.

- [ ] **Soham: clear the GitHub billing lock.** Confirmed on the push itself: CI ran no steps, and GitHub says "The job was not started because your account is locked due to a billing issue." That's about his account, not our code, and only he can see or fix it, under Settings, Billing and plans. I've taken the CI badge off the README until it's green, and it isn't a hackathon rule, so this doesn't block submitting. Once it's cleared, either of you can run `gh run rerun 42282158902 -R SohamJuneja/clearance`. Why: a green badge is proof a judge can see, and no rule requires it. Deadline: before Sat 19:00.

- [ ] **Study: Soham recruits, your laptop hosts.** Friday's slot has passed, so it's Sat 09:00-13:00 only. Target 20 sign-ups to land 12 to 16 people. Participants must be 18 or older. Consent is inside the link, so there's no form to set up. Why: the human study is one of the things only we have, and I can't recruit people. His recruitment text:
  > Hi! We're building Clearance for the Flip the Switch hackathon: it decides who should approve what an AI agent wants to do. We need 15 minutes of your time on Sat Nov 7, any time from 09:00 to 13:00 IST. You'll approve or deny 24 short requests in a chat window in your browser. No install, no personal data, no real money. Reply to this message and I'll send you your link. Thank you!

- [ ] **Open the study by Sat 08:45, and look at it on your phone first (5 minutes).** My permission check refused the public tunnel, so this one is yours. It only exposes the Lab, and each link is signed. For your own look, use rehearsal mode so nothing counts:
  ```bash
  cd ~/projects/Clearance
  STUDY_DRY_RUN=1 STUDY_RESULTS_DIR=/tmp/lab-rehearsal pnpm study:start      # terminal 1, leave it running
  cloudflared tunnel --no-autoupdate --url http://127.0.0.1:7950             # terminal 2, prints an https://...trycloudflare.com address
  pnpm study:links https://THAT-ADDRESS 20                                   # terminal 3, prints the links and sends nothing
  ```
  Open any link on your phone and go at least as far as a practice card. A whole run now passes at phone size in Chromium and in WebKit, which is close to Safari but isn't iOS. Only a real phone can show these, so look for them: does the keyboard cover Send on a typed card, does autocorrect leave a value like `kfin` alone, does the back button come back to the right card, and is a quick deliberate tap ever ignored? There's a 600 ms guard after each card appears, because a double tap was scoring a card nobody had read. For the real sessions, stop terminal 1, run plain `pnpm study:start`, and send Soham the links from `study:links`, one per person. Keep both terminals open until 13:00. If the tunnel restarts, its address changes, so rerun `study:links` with the new one and send those instead.

- [ ] **E3 labels, you and Soham, separately (about 30 minutes each).** The file is `eval/out/to-label.jsonl`, 200 real calls from E2, which is all the final code has produced so far, against PLAN's 300. I've sent it to you. Send Soham the same file, then each of you runs this and presses one key per call. The guide is `eval/classifier/LABELLING.md`.
  ```bash
  pnpm eval:classifier:label --name prashant --file eval/out/to-label.jsonl
  ```
  Label by hand, with no AI help and no looking at each other's answers. When you've both finished, send me the two `*.labels.jsonl` files. Soham needs the labelling tool, which is on GitHub only after the next push. Why: E3's recall and quiet-share numbers need two people's labels, and nothing else can produce them. Deadline: Sat 13:00.

- [ ] **Listen to the video once, 3 minutes.** `docs/media/raw/clearance-demo.mp4`, the 2:59 cut I sent you. I can read every frame but I can't hear anything, so the offline voice is unchecked by anyone. Tell me if a word is mispronounced, or if it sounds too robotic to use. The agents' words are real, so tell me about anything that reads wrong too, and I'll fix it or say why not.

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

- [x] **5. Anthropic key is in `.env`,** and agents now run on it, off your Claude login. Agents can read this key, so set a low spending limit on it in the Anthropic console. You pasted it into chat, so it's also in this session's log: replace it with a new one after judging. For Codex, `OPENAI_API_KEY` or `codex login` is still open in item 4.

- [ ] **5a. E2: I'm running it, on your word.** Claude's part first, then OpenCode's, one run at a time, about 3.5 hours by the probe's speed. It holds the stack while it runs, so please don't run `just demo`, scenes or `pnpm demo:reset` until I say it's done, and don't start heavy jobs in other projects: Shadow Run's video render filled the memory at 01:41 and got a Chrome process killed. If you ever stop it, run `pnpm exec tsx scripts/setup-e2.ts --restore`.

- [ ] **6. Confirm the spend cap.** The default is **₹3,000 (about $35) total for eval runs**, tracked in `eval/costs.json`. I stop E2 and ask before passing it. Set a hard limit on each key in the provider dashboards too, if they offer one. Reply only if you want a different cap.

- [ ] **7. Keep Wispr Flow on** and dictate your messages to me from now on (Code with Wispr track). Take the Insights screenshot on Saturday at 19:00.

- [ ] **9. Optional: post these in the WeMakeDevs Discord** and paste the answers into `DECISIONS.md` or send them to me. Ready to copy:
  > Hi! A few quick questions about Flip the Switch:
  > 1. Is there a maximum video length, and what are the exact submission form fields?
  > 2. Track 03: the page says to comment, tag @petr-sandbox and wait to be assigned, but maintainers wrote on #800 and #805 that they won't assign issues and anyone may solve any. Which rule applies?
  > 3. Is "Track 04 Best Integration or Extension" (only on the DevTools Academy page) a real prize, and can one project enter it alongside Track 01?
  > 4. Can one project win Track 01 and side tracks at the same time? Is it one submission per team?
  > 5. May people outside the registered team appear in the demo and the user study as chat users?

---

## LATER (I'll mark these NOW when their time comes)

- [ ] **The repo must be public when you submit.** Soham's already is. Only if he flips it private for now does this need doing again, and only he can do it, as admin.
- [ ] **Track 03 is with Soham now.** Nothing for you to do unless he hands it back. `docs/build/track03.md` has the code, the 15-minute Canva probe that decides go or drop, and the steps. Deadline: PR open by Sat 23:59 IST.
- [ ] **Voice-over (optional, 15 minutes).** Your voice is better than the offline one if you have time: drop files at `scripts/video/voice/<scene>.wav` and they win over it. The script is in `scripts/video/scenes.yaml`, one `voiceover` per scene.
- [ ] **Optional, stronger anti-evasion:** needs sudo for `/etc/claude-code/managed-settings.json`, which agents can't edit. Not tested yet. I'd only use it if you want it for the demo host.
- [ ] **Skip: the `!list-documents` crash** is already reported, with PR #1286 open upstream. Nothing to do.
- [ ] **Blog:** draft at `docs/build/blog-draft.md`, written as you, in first person. Please read it, since it speaks for you, and change anything that isn't how you'd say it. `pnpm numbers:fill` fills the `{{...}}` numbers from the eval results at the end. Post on dev.to or Hashnode when I say it's final.
- [ ] **Three #HowISwitch posts.** Text is in `docs/build/social-draft.md`, written as you, so change what isn't how you'd say it. The clips are `docs/media/social/post-1.mp4` and `post-2.mp4`. They're ready. Nothing gets posted until you do it or tick this.
- [ ] **Submission form.** Text is in `docs/build/submission-draft.md`. `pnpm numbers:fill` turns it into `SUBMISSION.md` with numbers and links filled in, once the repo has a remote. You add the team members, video link, blog link and Wispr screenshots.
