# HUMAN: things only you can do

Everything else is being done without you. Tick a box when done (or just tell me). I never block on these; I keep working around them.
The deadline is Sat Nov 7, 23:59 IST. NOW is in the order I'd do it.

---

## NOW

- [ ] **Record your voice and face (about 10 minutes).** The script is `~/Downloads/clearance-voiceover-script.md`: 26 lines, each read twice with 2 seconds of silence, looking at the lens, in one video saved as `~/Downloads/clearance-vo.mp4`. Then tell me, and one rebuild swaps the narrator for you: `python video/owner_takes.py ~/Downloads/clearance-vo.mp4`, then `VOICE=owner TAG=final bash video/rebuild.sh`. If there's no time, the narrator cut is complete as it is.

- [ ] **Upload the film to YouTube (unlisted or public), then send me the link.** The file is `~/Videos/clearance/clearance-<latest>.mp4` (1080p, -14 LUFS). Title, description, chapters and sources are in `video/YOUTUBE.md`; the thumbnail is `~/Videos/clearance/thumbnail.png`. Captions are burned in, so don't upload the .srt. With the link I add it to the README, the site and the submission text.

- [ ] **Submission form.** Text is in `docs/build/submission-draft.md`. `pnpm numbers:fill` turns it into `SUBMISSION.md` with numbers and links filled in; I rerun it once the video link is in. You add the team members, video link, blog link and Wispr screenshots. Deadline: 23:59 IST tonight.

- [ ] **Get on the team page, and rename the team `dellfargo` there.** The repo says `dellfargo`, and the page has to match. Sign in on wemakedevs.org and have Soham add you to the team, star `sandbox-quantum/switch` through the event link, and join the WeMakeDevs Discord. Why: only listed members count. I can't check it from here.

- [ ] **Soham: deploy the site from the repo.** Vercel, Add New Project, import `SohamJuneja/clearance`, framework Other, no build command, output directory `site/dist`. Every push to `master` then updates it. Your own Vercel copy (clearance-site-brown.vercel.app) is the older page and doesn't update by itself.

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
- [ ] **Track 03 is with Soham.** `docs/build/track03.md` has the code and the steps. Deadline: PR open by Sat 23:59 IST.
- [ ] **Blog:** draft at `docs/build/blog-draft.md`, written as you, in first person. Please read it, since it speaks for you, and change anything that isn't how you'd say it. `pnpm numbers:fill` fills the numbers. Post on dev.to or Hashnode when you're happy with it.
- [ ] **Three #HowISwitch posts.** Text is in `docs/build/social-draft.md`, written as you. The clips are `docs/media/social/post-1.mp4` and `post-2.mp4`. Nothing gets posted until you do it or tick this.
- [ ] **Soham: clear the GitHub billing lock.** CI runs no steps: "The job was not started because your account is locked due to a billing issue." Only he can fix it, under Settings, Billing and plans. Not a hackathon rule. Once cleared: `gh run rerun 42282158902 -R SohamJuneja/clearance`.
- [ ] **Ask Soham to try to break the fixes again.** His review found real breaks, all now fixed and re-checked in `pnpm eval:authority --group sixth-review`. `scripts/check-fence.sh --live` shows what's locked from inside, and the limits we kept are in `docs/threat-model.md`.
- [ ] **Optional, stronger anti-evasion:** needs sudo for `/etc/claude-code/managed-settings.json`, which agents can't edit. Not tested. Only if you want it on the demo host.

## Closed without doing (no longer needed)

- **Study (E5).** The Sat 09:00-13:00 slot passed without the Lab running, so the README says E5 is not measured and shows no number for it. The Lab code and tests stay in the repo.
- **E3 labels.** No labels arrived by the deadline, so the README says E3 is not measured either; `eval/out/to-label.jsonl` is there if you ever do them.
- **E2 runs, the spend cap, Cursor CLI and Codex logins.** E2 ran on Claude and OpenCode, $22.30 of the $35 cap. The README lists Codex and Cursor as "configured, not run".
- **The old 2:59 cut and its optional voice-over.** Replaced by the new film in `video/`.
- **Discord questions.** Too late to change anything; the stricter reading of each rule was followed.
- **The `!list-documents` crash.** Already reported upstream, with a PR open.
