// The Approval Lab's client. The server decides every step; this draws it, times it and posts answers.
// Text only ever reaches the page through textContent, so nothing in a card can become markup.

/** Splits one line of Switch's Markdown into plain, bold and code runs. Exported for tests. */
export function parseInline(line) {
  const runs = [];
  let rest = line;
  while (rest.length > 0) {
    const code = /(`+)( ?)([\s\S]*?)\2\1(?!`)/.exec(rest);
    const bold = /\*\*(.+?)\*\*/.exec(rest);
    const useCode = code && (!bold || code.index <= bold.index);
    const match = useCode ? code : bold;
    if (!match) {
      runs.push({ type: "text", text: rest });
      break;
    }
    if (match.index > 0) runs.push({ type: "text", text: rest.slice(0, match.index) });
    if (useCode) runs.push({ type: "code", text: code[3] });
    else runs.push({ type: "bold", text: bold[1] });
    rest = rest.slice(match.index + match[0].length);
  }
  return runs;
}

const MENTION = /^@you$/;

/** Shown when the server can't be reached, which can be before any text has come from it. */
const NOT_THROUGH = "Something went wrong and that didn't go through. Check your connection and try again. Your answers so far are safe.";

export function boot(env) {
  const { root, document, fetch, pathname, now, afterPaint, setTimeout, clearTimeout, scrollToTop, tapGuardMs = 0 } = env;
  const token = pathname.split("/").filter(Boolean).pop();
  let copy = null;
  let hiddenDuringCard = false;
  let timing = { requestId: null, at: null };
  let firstDraw = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenDuringCard = true;
  });

  const el = (tag, className, ...children) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const child of children) {
      if (child === null || child === undefined) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  };

  const button = (label, className, onClick) => {
    const node = el("button", className, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };

  async function call(action, body) {
    const res = await fetch(`../api/${token}/${action}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /** Posts, then draws whatever step the server says is next. Failing is loud, and retriable. */
  async function advance(action, body) {
    try {
      const data = await call(action, body);
      copy = data.copy;
      draw(data.step, data.notice);
    } catch {
      // The clock is still running on whatever card this was, through however long this takes to clear.
      hiddenDuringCard = true;
      root.replaceChildren(el("main", "panel", el("p", "error", NOT_THROUGH), button("Try again", "primary", () => void advance("state"))));
    }
  }

  /** Asks once first: this can't be undone, and it sits just under the buttons someone is tapping. */
  const stopLink = (beforeStop) => {
    const area = el("div", "stop-area");
    const ask = button("Stop the study", "stop", () => {
      // Time spent on this question is not time spent on the card.
      hiddenDuringCard = true;
      area.replaceChildren(
        el("p", "stop-question", copy.stopQuestion),
        button(copy.stopKeepGoing, "card-button", () => area.replaceChildren(ask)),
        button(copy.stopYes, "stop-yes", () => {
          if (beforeStop) beforeStop();
          void advance("stop", {});
        }),
      );
    });
    area.append(ask);
    return area;
  };

  function panel(...children) {
    return el("main", "panel", ...children);
  }

  function drawConsent() {
    const agree = el("input");
    agree.type = "checkbox";
    agree.id = "agree";
    const role = el("select");
    role.id = "role";
    role.append(el("option", null, "Choose one"));
    role.children[0].value = "";
    for (const name of copy.roles) {
      const option = el("option", null, name);
      option.value = name;
      role.append(option);
    }
    const familiarity = choiceRow(null);
    const go = button("Start", "primary", () => {
      void advance("consent", { agreed: true, role: role.value, familiarity: familiarity.value() });
    });
    go.disabled = true;
    const refresh = () => {
      go.disabled = !(agree.checked && role.value && familiarity.value());
    };
    agree.addEventListener("change", refresh);
    role.addEventListener("change", refresh);
    familiarity.onChange(refresh);

    const agreeLabel = el("label", "agree", agree, ` ${copy.consentAgree}`);
    root.replaceChildren(
      panel(
        el("h1", null, "Consent"),
        el("p", null, copy.consent),
        el("label", "field", "Which best describes you?", role),
        el("div", "field", copy.familiarityQuestion, familiarity.node),
        agreeLabel,
        go,
      ),
    );
  }

  /** A row of 1 to 5 buttons. The caller decides when picking one counts as an answer. */
  function choiceRow(onPick) {
    let picked = 0;
    let listener = () => {};
    const row = el("div", "choices");
    const buttons = [1, 2, 3, 4, 5].map((n) =>
      button(String(n), "choice", () => {
        picked = n;
        for (const other of buttons) other.className = other === buttons[n - 1] ? "choice picked" : "choice";
        listener();
        if (onPick) onPick(n);
      }),
    );
    row.append(...buttons);
    return { node: row, value: () => picked, onChange: (fn) => (listener = fn) };
  }

  function drawBriefing() {
    root.replaceChildren(
      panel(
        el("h1", null, "Briefing"),
        el("p", null, copy.briefing),
        el("p", "note", copy.replicaNotice),
        button("Continue", "primary", () => void advance("briefing", {})),
        stopLink(),
      ),
    );
  }

  function postBody(text) {
    const body = el("div", "post-body");
    for (const line of text.split("\n")) {
      if (MENTION.test(line)) {
        body.append(el("div", "line", el("span", "mention", line)));
        continue;
      }
      if (line.trim() === "") {
        body.append(el("div", "gap"));
        continue;
      }
      const row = el("div", "line");
      for (const run of parseInline(line)) {
        if (run.type === "code") row.append(el("code", null, run.text));
        else if (run.type === "bold") row.append(el("strong", null, run.text));
        else row.append(document.createTextNode(run.text));
      }
      body.append(row);
    }
    return body;
  }

  function drawCard(step, notice, openedHere) {
    // A re-asked card is redrawn with the same id. It is still one decision, so the clock keeps running.
    const isNewCard = timing.requestId !== step.request_id;
    if (isNewCard) {
      timing = { requestId: step.request_id, at: null };
      // A page that opens on a card, from a reload or a second tab, starts its clock late. Its time isn't a real one.
      hiddenDuringCard = openedHere;
    }
    // A double tap's second tap lands on whatever has just been drawn under the finger. That is not an answer to it.
    const drawnAt = now();
    const settled = () => now() - drawnAt >= tapGuardMs;
    const answer = (fields) => {
      const ms = Math.max(1, Math.round(now() - (timing.at ?? now())));
      // A phone put down for hours must not leave its owner unable to answer. Past the limit, nobody was reading.
      const overLimit = ms > copy.maxCardMs;
      void advance("answer", { request_id: step.request_id, ms: Math.min(ms, copy.maxCardMs), interrupted: hiddenDuringCard || overLimit, ...fields });
    };

    const controls = el("div", "actions");
    let lockable = [];
    const lock = () => {
      for (const node of lockable) node.disabled = true;
    };
    if (step.card.typeToConfirm) {
      const hint = el("p", "typed-hint", copy.typedHint);
      const input = el("input", "confirm-input");
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = "Type your answer";
      input.maxLength = 200;
      // A phone must not change the value being confirmed, or make it look wrong to the person typing it.
      input.setAttribute("autocapitalize", "none");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("spellcheck", "false");
      input.setAttribute("enterkeyhint", "send");
      const sendTyped = () => {
        if (!settled()) return;
        if (!input.value.trim()) {
          hint.textContent = copy.typedEmpty;
          input.focus();
          return;
        }
        lock();
        answer({ typed: input.value });
      };
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (!lockable[0].disabled) sendTyped();
      });
      const send = button("Send", "primary", sendTyped);
      lockable.push(send);
      controls.append(hint, input, send);
    }
    for (const label of step.card.buttons) {
      const node = button(label, "card-button", () => {
        if (!settled()) return;
        lock();
        answer({ label });
      });
      lockable.push(node);
      controls.append(node);
    }

    const heading = step.step === "practice" ? `Practice card ${step.index} of ${step.total}, not scored` : `Block ${step.block} · card ${step.position} of ${step.total}`;

    const initial = step.card.sender.slice(0, 1).toUpperCase();
    root.replaceChildren(
      el("header", "channel-bar", el("span", "channel-name", "Thread"), el("span", "progress", heading)),
      el(
        "main",
        "thread",
        notice ? el("p", "notice", notice) : null,
        el(
          "article",
          "post",
          el("div", "avatar", initial),
          el(
            "div",
            "post-main",
            el("div", "post-head", el("span", "sender", step.card.sender), el("span", "bot-tag", "BOT")),
            postBody(step.card.text),
            controls,
          ),
        ),
        el("p", "note", copy.replicaNotice),
        stopLink(),
      ),
    );
    scrollToTop();
    if (isNewCard) {
      // Timing starts once the card is really on screen, not when it was built.
      afterPaint(() => {
        timing.at = now();
      });
    }
  }

  function drawConfidence(step) {
    root.replaceChildren(
      panel(
        el("h1", null, `End of block ${step.block}`),
        el("p", null, copy.confidenceQuestion),
        choiceRow((value) => void advance("confidence", { block: step.block, value })).node,
        stopLink(),
      ),
    );
  }

  function drawBreak(step) {
    let left = step.seconds;
    const counter = el("p", "countdown", `${left} s`);
    const go = button("Continue to block 2", "primary", () => void advance("break", {}));
    go.disabled = true;
    let timer = null;
    const tick = () => {
      left -= 1;
      counter.textContent = `${Math.max(left, 0)} s`;
      if (left <= 0) go.disabled = false;
      else timer = setTimeout(tick, 1000);
    };
    if (left <= 0) go.disabled = false;
    else timer = setTimeout(tick, 1000);
    root.replaceChildren(panel(el("h1", null, "Take a short break"), counter, go, stopLink(() => clearTimeout(timer))));
  }

  function drawComment() {
    const text = el("textarea");
    text.rows = 4;
    text.maxLength = 2000;
    root.replaceChildren(
      panel(
        el("h1", null, "One last question"),
        el("p", null, copy.freeTextQuestion),
        el("p", "note", copy.freeTextHint),
        text,
        button("Finish", "primary", () => void advance("comment", { text: text.value })),
      ),
    );
  }

  function drawDebrief(step) {
    const list = step.missed.length
      ? el("ul", "missed", ...step.missed.map((item) => el("li", null, el("strong", null, item.headline), el("div", null, item.explanation))))
      : null;
    root.replaceChildren(
      panel(
        el("h1", null, "Thank you"),
        el("p", null, copy.debriefThanks),
        el("p", null, step.missed.length ? copy.debriefMissedIntro : copy.debriefNoneMissed),
        list,
        el("p", null, copy.debriefAcknowledge),
        el("p", "note", copy.debriefData),
      ),
    );
  }

  function draw(step, notice) {
    const openedHere = firstDraw;
    firstDraw = false;
    switch (step.step) {
      case "consent":
        return drawConsent();
      case "briefing":
        return drawBriefing();
      case "practice":
      case "card":
        return drawCard(step, notice, openedHere);
      case "confidence":
        return drawConfidence(step);
      case "break":
        return drawBreak(step);
      case "comment":
        return drawComment();
      case "debrief":
        return drawDebrief(step);
      case "stopped":
        return root.replaceChildren(panel(el("h1", null, "Stopped"), el("p", null, copy.stopped)));
      default:
        throw new Error(`unknown step ${step.step}`);
    }
  }

  return advance("state");
}
