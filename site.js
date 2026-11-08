(function () {
  const STORAGE_KEY = "secret-macabi-v1";

  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getDefaultWishlistUrl() {
    try {
      return new URL("wishlist.html", window.location.href).toString();
    } catch (error) {
      return "/wishlist.html";
    }
  }

  const defaults = {
    settings: {
      title: "Secret Macabi",
      budget: "$10",
      occasion: "Chanukah party",
      signoff: "The Party Team",
      subject: "🤫 {name}'s Eyes Only: Your Secret Macabi Assignment Awaits!",
      wishlistUrl: getDefaultWishlistUrl()
    },
    example: true,
    people: [
      { id: uid(), name: "Example: Dina Leah", email: "dina@example.com", group: "Adults", last: "Example: Moshe", excl: "" },
      { id: uid(), name: "Example: Moshe", email: "moshe@example.com", group: "Adults", last: "", excl: "Example: Rivka" },
      { id: uid(), name: "Example: Rivka", email: "rivka@example.com", group: "Adults", last: "", excl: "" },
      { id: uid(), name: "Example: Avi", email: "avi@example.com", group: "Adults", last: "", excl: "" },
      { id: uid(), name: "Example: Shira", email: "shira@example.com", group: "Kids", last: "", excl: "" },
      { id: uid(), name: "Example: Eli", email: "eli@example.com", group: "Kids", last: "", excl: "" },
      { id: uid(), name: "Example: Noa", email: "noa@example.com", group: "Kids", last: "", excl: "" }
    ],
    results: null,
    stale: false,
    sent: {}
  };

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && saved.people) return saved;
    } catch (error) {}
    return null;
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {}
  }

  let state = load() || clone(defaults);
  state.sent = state.sent || {};
  state.settings = state.settings || defaults.settings;
  if (!state.settings.wishlistUrl) state.settings.wishlistUrl = getDefaultWishlistUrl();

  const revealed = {};
  let confirmingRedraw = false;

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char];
    });
  }

  function norm(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/^example:\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sameName(a, b) {
    const x = norm(a);
    const y = norm(b);

    if (!x || !y) return false;
    if (x === y) return true;
    if (x.indexOf(" ") < 0 || y.indexOf(" ") < 0) {
      return x.split(" ")[0] === y.split(" ")[0];
    }
    return false;
  }

  function list(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function updateTitle() {
    const nextTitle = state.settings.title || "Secret Macabi";
    $("titleOut").textContent = nextTitle;
    document.title = nextTitle;
  }

  function buildWishlistLink() {
    const config = window.SECRET_MACABI_CONFIG || {};
    const candidate = state.settings.wishlistUrl
      || (config.siteUrl ? new URL(config.wishlistPage || "wishlist.html", config.siteUrl).toString() : getDefaultWishlistUrl());

    try {
      const url = new URL(candidate, window.location.href);
      url.searchParams.set("event", state.settings.title || "Secret Macabi");
      return url.toString();
    } catch (error) {
      return candidate;
    }
  }

  ["title", "budget", "occasion", "signoff", "subject", "wishlistUrl"].forEach((key) => {
    const el = $("set-" + key);
    if (!el) return;

    el.value = state.settings[key] || "";
    el.addEventListener("input", () => {
      state.settings[key] = el.value;
      if (key === "title") updateTitle();
      save();
    });
  });

  updateTitle();

  function renderPeople() {
    const box = $("people");

    if (!state.people.length) {
      box.innerHTML = '<div class="empty">Nobody yet. Add the adults and kids taking part.</div>';
    } else {
      box.innerHTML = state.people.map((person) => {
        const id = person.id;
        return `
          <div class="person" data-id="${id}">
            <label><span>Name</span><input id="n-${id}" data-f="name" value="${esc(person.name)}" autocomplete="off"></label>
            <label class="email"><span>Email</span><input id="e-${id}" data-f="email" type="email" value="${esc(person.email)}" placeholder="Parent's email for kids" autocomplete="off"></label>
            <label><span>Group</span>
              <select id="g-${id}" data-f="group">
                <option ${person.group === "Adults" ? "selected" : ""}>Adults</option>
                <option ${person.group === "Kids" ? "selected" : ""}>Kids</option>
              </select>
            </label>
            <label><span>Last year's match</span><input id="l-${id}" data-f="last" value="${esc(person.last)}" autocomplete="off"></label>
            <label><span>Never pair with</span><input id="x-${id}" data-f="excl" value="${esc(person.excl)}" autocomplete="off"></label>
            <button class="remove" data-act="remove" aria-label="Remove ${esc(person.name || "person")}">Remove</button>
          </div>
        `;
      }).join("");
    }

    $("exampleBanner").hidden = !state.example;
    updateCounts();
  }

  function updateCounts() {
    const adults = state.people.filter((person) => person.group === "Adults").length;
    const kids = state.people.length - adults;
    $("counts").textContent = `${adults} adult${adults === 1 ? "" : "s"} · ${kids} kid${kids === 1 ? "" : "s"}`;
  }

  function changed() {
    if (state.results) {
      state.stale = true;
      renderDraw();
    }
    save();
  }

  $("people").addEventListener("input", (event) => {
    const row = event.target.closest(".person");
    const field = event.target.dataset.f;
    if (!row || !field) return;

    const person = state.people.find((entry) => entry.id === row.dataset.id);
    if (!person) return;

    person[field] = event.target.value;
    if (field === "group") updateCounts();
    changed();
  });

  $("people").addEventListener("click", (event) => {
    const button = event.target.closest('[data-act="remove"]');
    if (!button) return;

    const id = button.closest(".person").dataset.id;
    state.people = state.people.filter((person) => person.id !== id);
    renderPeople();
    changed();
  });

  function addPerson(group) {
    const person = { id: uid(), name: "", email: "", group, last: "", excl: "" };
    state.people.push(person);
    renderPeople();
    changed();

    const input = $("n-" + person.id);
    if (input) input.focus();
  }

  $("addAdult").addEventListener("click", () => addPerson("Adults"));
  $("addKid").addEventListener("click", () => addPerson("Kids"));

  $("clearExamples").addEventListener("click", () => {
    state.people = [];
    state.example = false;
    state.results = null;
    state.stale = false;
    state.sent = {};
    renderPeople();
    renderDraw();
    save();
  });

  $("applyLastYear").addEventListener("click", () => {
    const lines = $("lastYearText").value.split(/\r?\n/).filter((line) => line.indexOf("-") > -1);
    let matched = 0;

    lines.forEach((line) => {
      const cut = line.lastIndexOf("-");
      const who = line.slice(0, cut).trim();
      const picked = line.slice(cut + 1).trim();

      if (!who || !picked) return;

      const shortWho = who.split(/\s+/).slice(0, -1).join(" ");
      const person = state.people.find((entry) => sameName(entry.name, who))
        || (shortWho && state.people.find((entry) => sameName(entry.name, shortWho)));

      if (person) {
        person.last = picked;
        matched++;
      }
    });

    const message = lines.length
      ? `Filled in ${matched} of ${lines.length} lines.${matched < lines.length ? " Check spelling for the rest." : ""}`
      : "No lines with a dash found.";

    $("lastYearMsg").textContent = message;
    renderPeople();
    changed();
  });

  function shuffle(array) {
    for (let index = array.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
    }
    return array;
  }

  function blocked(giver, other) {
    if (sameName(giver.last, other.name)) return true;
    return list(giver.excl).some((name) => sameName(name, other.name));
  }

  function solve(group, label) {
    const count = group.length;
    if (count === 0) return { pairs: [] };
    if (count < 2) return { error: label + " needs at least 2 people to draw." };

    const allowed = group.map((giver, index) => {
      return group
        .map((_, j) => j)
        .filter((j) => j !== index && !blocked(giver, group[j]));
    });

    for (let i = 0; i < count; i++) {
      if (!allowed[i].length) {
        return { error: group[i].name + " has nobody left they can draw. Remove a name from their exclusions." };
      }
    }

    const order = group.map((_, index) => index).sort((a, b) => allowed[a].length - allowed[b].length);
    const used = new Array(count).fill(false);
    const pick = new Array(count);
    let steps = 0;

    function dfs(k) {
      if (k === count) return true;
      if (++steps > 200000) return false;

      const index = order[k];
      const options = shuffle(allowed[index].slice());

      for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
        const matchIndex = options[optionIndex];
        if (used[matchIndex]) continue;

        used[matchIndex] = true;
        pick[index] = matchIndex;

        if (dfs(k + 1)) return true;

        used[matchIndex] = false;
      }
      return false;
    }

    if (!dfs(0)) {
      return { error: "There is no way to draw " + label.toLowerCase() + " with these exclusions. Remove one or two and try again." };
    }

    return {
      pairs: group.map((giver, index) => ({
        id: giver.id,
        giver: giver.name,
        email: giver.email,
        match: group[pick[index]].name
      }))
    };
  }

  function validate() {
    const problems = [];
    const seen = {};

    state.people.forEach((person, index) => {
      if (!person.name.trim()) {
        problems.push("Person " + (index + 1) + " has no name.");
      } else {
        const key = norm(person.name);
        if (seen[key]) {
          problems.push("Two people are named " + person.name.trim() + ". Add a last name or initial to tell them apart.");
        }
        seen[key] = true;
      }
    });

    return problems;
  }

  function draw() {
    const messageBox = $("drawMsg");
    const problems = validate();

    if (problems.length) {
      messageBox.innerHTML = '<div class="banner bad">' + esc(problems[0]) + '</div>';
      return;
    }

    const adults = solve(state.people.filter((person) => person.group === "Adults"), "Adults");
    const kids = solve(state.people.filter((person) => person.group === "Kids"), "Kids");
    const error = adults.error || kids.error;

    if (error) {
      messageBox.innerHTML = '<div class="banner bad">' + esc(error) + '</div>';
      return;
    }

    state.results = {
      Adults: adults.pairs,
      Kids: kids.pairs,
      at: new Date().toISOString()
    };
    state.stale = false;
    state.sent = {};
    Object.keys(revealed).forEach((key) => delete revealed[key]);
    confirmingRedraw = false;

    save();
    renderDraw();
  }

  function makeMailtoUrl(email, subject, body) {
    return "mailto:" + encodeURIComponent(email || "") +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }

  function emailFor(pair) {
    const settings = state.settings;
    const first = String(pair.giver).replace(/^Example:\s*/, "");
    const match = String(pair.match).replace(/^Example:\s*/, "");
    const subject = (settings.subject || "").split("{name}").join(first);
    const wishlist = buildWishlistLink();

    const body = "Hi " + first + ",\n\n" +
      "You have been assigned " + match + " for the " + (settings.occasion || "party") + ". " +
      "Please remember the gift budget is set to " + (settings.budget || "$10") + ".\n\n" +
      "Wish list: " + wishlist + "\n\n" +
      "Enjoy!\n\n" + (settings.signoff || "The Party Team");

    return { subject, body };
  }

  function resultsText() {
    const results = state.results;
    let output = "Welcome to this years drawings!\n";

    ["Adults", "Kids"].forEach((group) => {
      if (!results[group] || !results[group].length) return;
      output += "\n" + group.toUpperCase() + "\n";
      output += "/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\\\n";
      results[group].forEach((pair) => { output += pair.giver + " -" + pair.match + "\n"; });
      output += "\n";
    });

    return output;
  }

  function renderDraw() {
    const controls = $("drawControls");
    const currentResults = state.results;

    if (!currentResults) {
      controls.innerHTML = '<button class="primary" id="drawBtn">Draw names</button>';
    } else if (confirmingRedraw) {
      controls.innerHTML = '<span class="hint">Replace the current matches?</span><button class="primary" id="drawBtn">Yes, draw again</button><button id="cancelRedraw" class="ghost">Keep current</button>';
    } else {
      controls.innerHTML = `
        <a class="btn" href="${buildWishlistLink()}" target="_blank" rel="noopener">View wish list</a>
        <button id="copyAll">Copy all results</button>
        <button id="redrawBtn">Draw again</button>
      `;
    }

    const messageBox = $("drawMsg");
    if (currentResults && state.stale) {
      messageBox.innerHTML = '<div class="banner gold"><span>You changed the people list after drawing. Draw again to include the changes.</span></div>';
    } else if (currentResults) {
      const total = currentResults.Adults.length + currentResults.Kids.length;
      const sent = Object.keys(state.sent).filter((key) => state.sent[key]).length;
      messageBox.innerHTML = '<div class="banner ok"><span>Names drawn for ' + total + ' people. ' + sent + ' of ' + total + ' marked sent.</span></div>';
    } else {
      messageBox.innerHTML = "";
    }

    const box = $("results");
    if (!currentResults) {
      box.innerHTML = '<div class="empty">Nobody has been drawn yet. Check the list in step 2, then press Draw names.</div>';
      return;
    }

    box.innerHTML = ["Adults", "Kids"]
      .filter((group) => currentResults[group] && currentResults[group].length)
      .map((group) => {
        return `
          <div>
            <div class="group-title"><span>${group}</span><span>${currentResults[group].length}</span></div>
            <div class="ledger">
              ${currentResults[group].map((pair) => {
                const email = emailFor(pair);
                const href = makeMailtoUrl(pair.email || "", email.subject, email.body);
                const shown = revealed[pair.id];

                return `
                  <div class="pair ${state.sent[pair.id] ? "is-sent" : ""}" data-id="${pair.id}" data-g="${group}">
                    <div class="who">
                      <strong>${esc(pair.giver)}</strong>
                      <span class="addr">${pair.email ? esc(pair.email) : "No email yet"}</span>
                    </div>
                    <div class="match ${shown ? "" : "hidden-match"}" aria-live="polite">
                      ${shown ? "→ " + esc(pair.match) : "• • • •"}
                    </div>
                    <div class="actions">
                      <button data-act="reveal">${shown ? "Hide" : "Show"}</button>
                      <button data-act="copy">Copy email</button>
                      <button data-act="email">${state.sent[pair.id] ? "Resend" : "Send email"}</button>
                      <a class="btn" href="${esc(href)}" target="_blank" rel="noopener">Open in Mail</a>
                      <label class="sent"><input type="checkbox" data-act="sent" ${state.sent[pair.id] ? "checked" : ""}> Sent</label>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>
        `;
      }).join("");
  }

  function find(id, group) {
    return (state.results[group] || []).find((pair) => pair.id === id);
  }

  function copy(text, button) {
    function fallback() {
      $("fallbackWrap").hidden = false;
      const draft = $("fallback");
      draft.value = text;
      draft.focus();
      draft.select();
    }

    try {
      navigator.clipboard.writeText(text).then(() => {
        $("fallbackWrap").hidden = true;
        const previousText = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = previousText; }, 1400);
      }, fallback);
    } catch (error) {
      fallback();
    }
  }

  async function sendEmailPair(pair) {
    const config = window.SECRET_MACABI_CONFIG || {};
    const details = emailFor(pair);
    const payload = {
      to: pair.email,
      name: pair.giver,
      subject: details.subject,
      body: details.body,
      wishlistUrl: buildWishlistLink()
    };

    if (config.emailEndpoint) {
      try {
        const response = await fetch(config.emailEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error("Email endpoint rejected the request");
        }

        state.sent[pair.id] = true;
        save();
        renderDraw();
        return { ok: true, mode: "endpoint" };
      } catch (error) {
        console.error("Email send failed:", error);
      }
    }

    window.location.href = makeMailtoUrl(pair.email || "", details.subject, details.body);
    state.sent[pair.id] = true;
    save();
    renderDraw();
    return { ok: true, mode: "mailto" };
  }

  $("drawControls").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.id === "drawBtn") {
      draw();
    } else if (button.id === "redrawBtn") {
      confirmingRedraw = true;
      renderDraw();
    } else if (button.id === "cancelRedraw") {
      confirmingRedraw = false;
      renderDraw();
    } else if (button.id === "copyAll") {
      copy(resultsText(), button);
    }
  });

  $("results").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;

    const row = target.closest(".pair");
    const pair = find(row.dataset.id, row.dataset.g);
    if (!pair) return;

    const action = target.dataset.act;

    if (action === "reveal") {
      revealed[pair.id] = !revealed[pair.id];
      renderDraw();
    } else if (action === "copy") {
      const email = emailFor(pair);
      copy("To: " + (pair.email || "") + "\nSubject: " + email.subject + "\n\n" + email.body, target);
    } else if (action === "email") {
      target.disabled = true;
      target.textContent = "Sending…";
      await sendEmailPair(pair);
      target.disabled = false;
      target.textContent = state.sent[pair.id] ? "Resend" : "Send email";
    }
  });

  $("results").addEventListener("change", (event) => {
    const target = event.target;
    if (target.dataset.act !== "sent") return;

    const row = target.closest(".pair");
    state.sent[row.dataset.id] = target.checked;
    save();
    renderDraw();
  });

  renderPeople();
  renderDraw();
})();
