# HUMAN: things only you can do

Everything else is being done without you. Tick a box when done (or just tell me). I never block on these; I keep working around them.
The deadline is Sat Nov 7, 23:59 IST. NOW is in the order I'd do it.

---

## NOW

- [x] **Recorded your voice and face.** It's in the film: `~/Videos/clearance/clearance-final.mp4` (and `-720p`), 3:57.

- [ ] **Upload the film to YouTube (unlisted or public), then send me the link.** The file is `~/Videos/clearance/clearance-<latest>.mp4` (1080p, -14 LUFS). Title, description, chapters and sources are in `video/YOUTUBE.md`; the thumbnail is `~/Videos/clearance/thumbnail.png`. Captions are burned in, so don't upload the .srt. With the link I add it to the README, the site and the submission text.

- [ ] **Submission form.** Text is in `docs/build/submission-draft.md`. `pnpm numbers:fill` turns it into `SUBMISSION.md` with numbers and links filled in; I rerun it once the video link is in. You add the team members, video link, blog link and Wispr screenshots. Deadline: 23:59 IST tonight.

- [ ] **Get on the team page, and rename the team `dellfargo` there.** The repo says `dellfargo`, and the page has to match. Sign in on wemakedevs.org and have Soham add you to the team, star `sandbox-quantum/switch` through the event link, and join the WeMakeDevs Discord. Why: only listed members count. I can't check it from here.

- [ ] **Soham: deploy the site from the repo.** Vercel, Add New Project, import `SohamJuneja/clearance`, framework Other, no build command, output directory `site/dist`. Every push to `master` then updates it. Your own Vercel copy (clearance-site-brown.vercel.app) is the older page and doesn't update by itself.
  **Soham, also fill in the repo's About box** (it's blank, and only an admin can set it; I have write access, not admin). Put the site's address after `--homepage`:
  ```bash
  gh repo edit SohamJuneja/clearance --description "Whoever asks an AI agent to act can't approve it. An approval layer for people and agents, built on Switch." --homepage "https://clearance-site-brown.vercel.app" --add-topic switch,flip-the-switch,ai-agents,approval-workflow,separation-of-duties,mattermost,mcp
  ```

- [ ] **Get the YouTube link to me by about 23:30.** The README's video slot is empty on `master`, and adding the link is a commit. The rules page says submissions close at 23:59 IST and doesn't say whether later commits count, so the link should land before then.

- [ ] **Your call: your `confirm-gate-mcp` repo.** It's public, from Oct 21, on PyPI, and works on the same problem (confirm before an agent acts). Clearance doesn't use it, shares no code with it (Python vs TypeScript), and never mentions it. The rules allow existing libraries, so the risk is low. Whether to say anything about it in the form is yours to decide; I haven't written it anywhere.

- [ ] **Decide on a licence notice for the site's playground.** `site/dist/playground.js` bundles zod, yaml and jsep (MIT and ISC licences), whose packages ship no licence text. MIT asks that its notice travel with copies. Your call whether to add a notices file; I haven't added one, as credits and notices are yours to write.

- [ ] **Wispr Insights screenshot** for the Code with Wispr track, as late as you can before submitting.

- [ ] **Keep the laptop plugged in, Docker running, lid open until we submit.** The film renders here. A sleep inhibitor is running for the session; to be safe, also run:
  ```bash
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
  gsettings set org.gnome.desktop.session idle-delay 0
  ```

- [ ] **Clear our leftover test folders from `/tmp` (1 minute).** About 6 GB of old test folders sit in RAM-backed storage, which is the OOM risk we've hit before. My permission check refused the cleanup because `/tmp` is shared. This only removes folders named `clearance-*` that you own and that are over 5 minutes old:
  ```bash
  find /tmp -maxdepth 1 -type d -name 'clearance-*' -user "$USER" -mmin +5 -prune -exec rm -rf {} +
  df -h /tmp
  ```

- [x] **Pushed to Soham's repo.** `master` is on our code, with his 5 commits kept and his old code tagged `soham-python-first-cut`. Pushes are `git push` from `main`, never `--force`.

- [x] **Anthropic key is in `.env`,** and agents ran on it. You pasted it into chat, so it's also in this session's log: replace it with a new one after judging.

---

## LATER (only if you want them, or after the deadline)

- [ ] **The repo must be public when you submit.** Soham's already is. Only he can change it, as admin.
- [ ] **Blog:** draft at `docs/build/blog-draft.md`, written as you, in first person. Please read it, since it speaks for you, and change anything that isn't how you'd say it. `pnpm numbers:fill` fills the numbers. Post on dev.to or Hashnode when you're happy with it.
- [ ] **Three #HowISwitch posts.** Text is in `docs/build/social-draft.md`, written as you. The clips are `docs/media/social/post-1.mp4` and `post-2.mp4`. Nothing gets posted until you do it or tick this.
- [ ] **Soham: clear the GitHub billing lock.** CI runs no steps: "The job was not started because your account is locked due to a billing issue." Only he can fix it, under Settings, Billing and plans. Not a hackathon rule. Once cleared: `gh run rerun 42282158902 -R SohamJuneja/clearance`.
- [ ] **Ask Soham to try to break the fixes again.** His review found real breaks, all now fixed and re-checked in `pnpm eval:authority --group sixth-review`. `scripts/check-fence.sh --live` shows what's locked from inside, and the limits we kept are in `docs/threat-model.md`.
- [ ] **Optional, stronger anti-evasion:** needs sudo for `/etc/claude-code/managed-settings.json`, which agents can't edit. Not tested. Only if you want it on the demo host.

## Closed without doing (no longer needed)

- **Track 03.** Your call on Nov 7: not entered, nothing posted upstream. The Canva connection stays in our repo, in `spikes/track03/`, with a README saying what's tested and what isn't.

- **Study (E5).** The Sat 09:00-13:00 slot passed without the Lab running, so the README says E5 is not measured and shows no number for it. The Lab code and tests stay in the repo.
- **E3 labels.** No labels arrived by the deadline, so the README says E3 is not measured either; `eval/out/to-label.jsonl` is there if you ever do them.
- **E2 runs, the spend cap, Cursor CLI and Codex logins.** E2 ran on Claude and OpenCode, $22.30 of the $35 cap. The README lists Codex and Cursor as "configured, not run".
- **The old 2:59 cut and its optional voice-over.** Replaced by the new film in `video/`.
- **Discord questions.** Too late to change anything; the stricter reading of each rule was followed.
- **The `!list-documents` crash.** Already reported upstream, with a PR open.
