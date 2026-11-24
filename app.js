(function () {
  "use strict";

  const cfg = window.SECRET_MACABI_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const LAST_FAMILY_KEY = "secret-macabi-last-family";
  const LAST_TAB_KEY = "secret-macabi-last-tab";

  // ---------------------------------------------------------------- utilities
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function norm(value) { return String(value || "").toLowerCase().replace(/\s+/g, " ").trim(); }
  function sameName(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.indexOf(" ") < 0 || y.indexOf(" ") < 0) return x.split(" ")[0] === y.split(" ")[0];
    return false;
  }
  // History lines sometimes say "Ezzi drew - Azi"; treat "Ezzi drew" as "Ezzi".
  function cleanGiver(name) { return String(name || "").replace(/\s+(drew|draws|got|gets|picked|has|had)\s*$/i, "").trim(); }
  function list(value) { return String(value || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean); }
  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  let toastTimer;
  function toast(message, kind) {
    const el = $("globalMsg");
    el.textContent = message;
    el.className = "toast " + (kind || "ok");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === "bad" ? 6000 : 3000);
  }
  function friendlyError(error) {
    const msg = (error && (error.message || error.error_description || error.error)) || String(error);
    if (/members_family_name_uidx/.test(msg)) return "That name is already on the list.";
    if (/members_email_check/.test(msg)) return "That email address doesn't look right.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Connection problem. Try again.";
    return msg;
  }
  function views(name) {
    ["authView", "familyView", "appView"].forEach((v) => { $(v).hidden = v !== name; });
  }
  function authMessage(text, kind) {
    const el = $("authMsg");
    el.textContent = text || "";
    el.className = "form-msg" + (kind === "bad" ? " bad" : "");
  }

  // Every database write goes through here so the header can show "Saving… / Saved".
  let pendingSaves = 0, saveTimer;
  async function persist(work) {
    const el = $("saveState");
    pendingSaves++;
    el.textContent = "Saving…"; el.className = "save-state";
    clearTimeout(saveTimer);
    try {
      const result = await work();
      if (result && result.error) throw result.error;
      return result;
    } catch (error) {
      el.textContent = "Not saved"; el.className = "save-state bad";
      toast(friendlyError(error), "bad");
      throw error;
    } finally {
      pendingSaves--;
      if (!pendingSaves && el.textContent === "Saving…") {
        el.textContent = "Saved ✓"; el.className = "save-state ok";
        saveTimer = setTimeout(() => { el.textContent = ""; }, 2500);
      }
    }
  }

  // ---------------------------------------------------------------- setup check
  if (!window.supabase || !cfg.supabaseUrl || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
    views("authView");
    $("authForm").hidden = true;
    authMessage("Site not configured. Add Supabase settings to config.js.", "bad");
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const pageUrl = window.location.href.split(/[?#]/)[0];

  // ---------------------------------------------------------------- state
  let session = null;
  let family = null;
  let myRole = null;
  let members = [];
  let draws = [];          // newest first
  let assignments = [];
  let pastPairs = [];      // imported history: [{id, giver, receiver}]
  let preview = null;      // unsaved draw: [{giver_id, receiver_id}]
  let notice = "";
  const revealed = {};
  const expanded = new Set();

  // ================================================================= AUTH
  async function signIn(event) {
    event.preventDefault();
    authMessage("Signing in…");
    const { error } = await sb.auth.signInWithPassword({ email: $("authEmail").value.trim(), password: $("authPassword").value });
    if (!error) { authMessage(""); return; }
    authMessage(/invalid login credentials/i.test(error.message)
      ? "Wrong email or password. New here? Use Create account."
      : friendlyError(error), "bad");
  }

  async function signUp() {
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    if (!email || password.length < 8) { authMessage("Enter an email and a password of 8+ characters.", "bad"); return; }
    authMessage("Creating account…");
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: pageUrl } });
    const exists = (error && /already registered/i.test(error.message)) ||
      (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0);
    if (exists) { authMessage("That email already has an account. Sign in instead.", "bad"); return; }
    if (error) { authMessage(friendlyError(error), "bad"); return; }
    authMessage(data.session ? "" : "Check your email to confirm your account.");
  }

  async function forgotPassword() {
    const email = $("authEmail").value.trim();
    if (!email) { authMessage("Enter your email first.", "bad"); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl });
    authMessage(error ? friendlyError(error) : "If that account exists, a reset link is on its way.", error ? "bad" : "");
  }

  async function signOut(event) {
    if (event) event.preventDefault();
    await sb.auth.signOut();
  }

  // Supabase advises not to await other Supabase calls inside this callback, so work is deferred.
  sb.auth.onAuthStateChange((eventName, newSession) => {
    const wasSignedIn = !!session;
    session = newSession;
    setTimeout(async () => {
      if (eventName === "PASSWORD_RECOVERY") {
        const password = window.prompt("New password (8+ characters):");
        if (password && password.length >= 8) {
          const { error } = await sb.auth.updateUser({ password });
          toast(error ? friendlyError(error) : "Password updated.", error ? "bad" : "ok");
        }
      }
      if (!session) { family = null; views("authView"); return; }
      if (!wasSignedIn) showFamilies(true);
    }, 0);
  });

  // ================================================================= FAMILIES
  async function showFamilies(autoOpen) {
    views("familyView");
    $("whoAmI").textContent = session.user.email;
    const { data, error } = await sb.from("family_admins").select("role, families(id, name)").eq("user_id", session.user.id);
    if (error) { $("familyList").innerHTML = '<div class="banner bad">' + esc(friendlyError(error)) + "</div>"; return; }
    const rows = (data || []).filter((r) => r.families);
    $("familyList").innerHTML = rows.length
      ? rows.map((r) => `<button type="button" class="family-pick" data-id="${esc(r.families.id)}"><span>${esc(r.families.name)}</span><span class="muted">${esc(r.role)}</span></button>`).join("")
      : '<p class="muted">No families yet.</p>';

    const last = storageGet(LAST_FAMILY_KEY);
    if (autoOpen && last && rows.some((r) => r.families.id === last)) openFamily(last);
    else if (autoOpen && rows.length === 1) openFamily(rows[0].families.id);
  }

  async function createFamily(event) {
    event.preventDefault();
    const name = $("newFamilyName").value.trim();
    if (!name) return;
    const { data, error } = await sb.rpc("create_family", { p_name: name });
    if (error) { toast(friendlyError(error), "bad"); return; }
    $("newFamilyName").value = "";
    openFamily(data.id);
  }

  async function openFamily(id) {
    const [fam, role] = await Promise.all([
      sb.from("families").select("*").eq("id", id).maybeSingle(),
      sb.from("family_admins").select("role").eq("family_id", id).eq("user_id", session.user.id).maybeSingle()
    ]);
    if (fam.error || !fam.data) { toast(fam.error ? friendlyError(fam.error) : "Family not found.", "bad"); return showFamilies(false); }
    family = fam.data;
    myRole = role.data ? role.data.role : "admin";
    storageSet(LAST_FAMILY_KEY, id);
    preview = null; notice = "";
    expanded.clear();
    Object.keys(revealed).forEach((k) => delete revealed[k]);
    views("appView");
    $("menuEmail").textContent = session.user.email;
    $("avatar").textContent = (session.user.email || "?").trim().charAt(0).toUpperCase();
    showTab(storageGet(LAST_TAB_KEY) || "people");
    setupHeadsUpDate();
    renderSettings();
    renderShare();
    await Promise.all([loadMembers(), loadDraws(), loadAdmins(), loadPastPairs()]);
  }

  // ================================================================= TABS
  function showTab(name) {
    if (!document.querySelector(`[data-panel="${name}"]`)) name = "people";
    document.querySelectorAll("[data-tab]").forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    });
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    storageSet(LAST_TAB_KEY, name);
  }

  // ================================================================= SETTINGS
  function renderSettings() {
    $("familyTitle").textContent = family.name;
    document.title = family.name + " · Secret Macabi";
    document.querySelectorAll("[data-setting]").forEach((el) => { el.value = family[el.dataset.setting] ?? ""; });
  }

  async function saveSetting(event) {
    const el = event.target;
    const key = el.dataset.setting;
    if (!key) return;
    let value = el.value;
    if (key === "avoid_recent_draws") value = Math.max(0, Math.min(10, parseInt(value, 10) || 0));
    if (key === "name" && !value.trim()) { el.value = family.name; return; }
    try {
      await persist(() => sb.from("families").update({ [key]: value }).eq("id", family.id));
      family[key] = value;
      if (key === "name") renderSettings();
    } catch (e) { el.value = family[key] ?? ""; }
  }

  // ================================================================= PEOPLE
  async function loadMembers() {
    const { data, error } = await sb.from("members").select("*").eq("family_id", family.id).order("group_name").order("created_at");
    if (error) { toast(friendlyError(error), "bad"); return; }
    members = data || [];
    renderPeople();
  }

  const byName = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });

  function memberById(id) { return members.find((m) => m.id === id); }

  function renderPeople() {
    const box = $("people");
    if (!members.length) {
      box.innerHTML = '<div class="empty">No one added yet.</div>';
    } else {
      box.innerHTML = members.slice().sort((a, b) => byName(a.name, b.name)).map((p) => {
        const open = expanded.has(p.id);
        const tags = [
          !p.active ? "Sitting out" : "",
          p.exclusions ? "Exclusions" : "",
          (p.past_matches || []).length ? "History" : ""
        ].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join("");
        return `
        <div class="person ${p.active ? "" : "inactive"} ${open ? "open" : ""}" data-id="${esc(p.id)}">
          <div class="person-main">
            <input data-f="name" value="${esc(p.name)}" maxlength="100" aria-label="Name">
            <input data-f="email" type="email" value="${esc(p.email || "")}" placeholder="Email" aria-label="Email">
            <select data-f="group_name" aria-label="Group">
              <option ${p.group_name === "Adults" ? "selected" : ""}>Adults</option>
              <option ${p.group_name === "Kids" ? "selected" : ""}>Kids</option></select>
            <span class="tags">${tags}</span>
            <button type="button" class="icon-btn" data-act="toggle" aria-expanded="${open}" aria-label="More options for ${esc(p.name)}">${open ? "Close" : "Edit"}</button>
          </div>
          ${open ? `
          <div class="person-more">
            ${p.group_name === "Adults" ? `<label><span>Gender</span><select data-f="gender">
              <option value="" ${!p.gender ? "selected" : ""}>Not set</option>
              <option value="F" ${p.gender === "F" ? "selected" : ""}>Female</option>
              <option value="M" ${p.gender === "M" ? "selected" : ""}>Male</option></select></label>` : ""}
            <label><span>Never pair with</span><input data-f="exclusions" value="${esc(p.exclusions)}" placeholder="Names, comma separated"></label>
            <label><span>Past matches</span><input data-f="past_matches" value="${esc((p.past_matches || []).join(", "))}" placeholder="Names, comma separated"></label>
            <div class="person-more-actions">
              <label class="check"><input type="checkbox" data-f="active" ${p.active ? "" : "checked"} data-invert="1"> Sitting out this year</label>
              <button class="link danger" type="button" data-act="remove">Remove</button>
            </div>
          </div>` : ""}
        </div>`;
      }).join("");
    }
    $("removeAllPeople").hidden = !members.length;
    const active = members.filter((m) => m.active);
    const adults = active.filter((m) => m.group_name === "Adults").length;
    $("counts").textContent = members.length ? `${adults} adults · ${active.length - adults} kids` : "";
  }

  async function addPerson(event) {
    event.preventDefault();
    const row = {
      family_id: family.id,
      name: $("newName").value.trim(),
      email: $("newEmail").value.trim() || null,
      group_name: $("newGroup").value
    };
    if (!row.name) return;
    try {
      const { data } = await persist(() => sb.from("members").insert(row).select().single());
      members.push(data);
      $("newName").value = ""; $("newEmail").value = "";
      $("newName").focus();
      renderPeople();
      invalidatePreview();
    } catch (e) {}
  }

  async function updatePersonField(event) {
    const row = event.target.closest(".person");
    const field = event.target.dataset.f;
    if (!row || !field) return;
    const person = memberById(row.dataset.id);
    if (!person) return;

    let value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    if (event.target.dataset.invert) value = !value;
    if (field === "past_matches") value = list(value);
    if (field === "email") value = value.trim() || null;
    if (field === "gender") value = value || null;
    if (field === "name") { value = value.trim(); if (!value) { event.target.value = person.name; return; } }
    const patch = { [field]: value };
    if (field === "group_name" && value === "Kids") patch.gender = null;

    try {
      await persist(() => sb.from("members").update(patch).eq("id", person.id));
      Object.assign(person, patch);
      if (["name", "group_name", "active", "exclusions", "past_matches"].includes(field)) renderPeople();
      if (field === "name") renderDraw();
      invalidatePreview();
    } catch (e) { renderPeople(); }
  }

  async function onPeopleClick(event) {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const person = memberById(button.closest(".person").dataset.id);
    if (!person) return;
    if (button.dataset.act === "toggle") {
      if (expanded.has(person.id)) expanded.delete(person.id); else expanded.add(person.id);
      renderPeople();
    } else if (button.dataset.act === "remove") {
      if (!window.confirm(`Remove ${person.name}? This deletes their wish list and draw history.`)) return;
      try {
        await persist(() => sb.from("members").delete().eq("id", person.id));
        members = members.filter((m) => m.id !== person.id);
        renderPeople();
        await loadDraws();
      } catch (e) {}
    }
  }

  async function removeAllPeople() {
    const n = members.length;
    if (!n) return;
    const hasDraws = draws.length > 0;
    const msg = `Remove all ${n} ${n === 1 ? "person" : "people"}? Their wish lists` +
      (hasDraws ? " and past draw results" : "") + " will be deleted too. This can't be undone.";
    if (!window.confirm(msg)) return;
    try {
      await persist(() => sb.from("members").delete().eq("family_id", family.id));
      // Their draw results went with them; clear the now-empty draws too.
      if (hasDraws) await persist(() => sb.from("draws").delete().eq("family_id", family.id));
      notice = "";
      members = [];
      expanded.clear();
      preview = null;
      renderPeople();
      await loadDraws();
      toast(`Removed ${n}.`);
    } catch (e) { await loadMembers(); }
  }

  function parsePersonLine(line) {
    const cleaned = String(line || "").trim().replace(/^['"]|['"]$/g, "");
    if (!cleaned || cleaned.startsWith("#")) return null;
    const cells = cleaned.split(/[\t,;|]+/).map((c) => c.trim()).filter(Boolean);
    let group = "Adults";
    if (cells.length && /^(adults?|kids?)$/i.test(cells[0])) group = /^kid/i.test(cells.shift()) ? "Kids" : "Adults";
    if (!cells.length) return null;
    const email = cells.find((c) => c.includes("@")) || null;
    const name = cells.filter((c) => c !== email).join(" ");
    return name ? { name, email, group } : null;
  }

  async function importPeople(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    event.target.value = "";
    const seen = new Set(members.map((m) => norm(m.name)));
    const rows = [];
    text.replace(/\r/g, "").split("\n").forEach((line) => {
      const p = parsePersonLine(line);
      if (!p || seen.has(norm(p.name))) return;
      seen.add(norm(p.name));
      rows.push({ family_id: family.id, name: p.name, email: p.email, group_name: p.group });
    });
    if (!rows.length) { toast("No new names in that file.", "bad"); return; }
    try {
      await persist(() => sb.from("members").insert(rows));
      toast(`Added ${rows.length}.`);
      await loadMembers();
      invalidatePreview();
    } catch (e) {}
  }

  // "Giver - Receiver". Prefer unambiguous separators so hyphenated names (Ben-David) stay intact.
  function parseHistoryLine(line) {
    const cleaned = String(line || "").replace(/^﻿/, "").trim();
    if (!cleaned) return null;
    const m = cleaned.match(/^(.+?)\s*(?:->|=>|→|–|—|:)\s*(.+)$/) || cleaned.match(/^(.+?)\s+-\s*(.+)$/);
    if (m) return { giver: cleanGiver(m[1]), receiver: m[2].trim() };
    const i = cleaned.lastIndexOf("-");
    if (i > 0 && i < cleaned.length - 1) return { giver: cleanGiver(cleaned.slice(0, i)), receiver: cleaned.slice(i + 1).trim() };
    // Headings from old result files ("ADULTS", "/\/\/\", "Welcome to ...!") are skipped quietly.
    if (!/[a-z]/i.test(cleaned) || /^(adults?|kids?)$/i.test(cleaned) || /!$/.test(cleaned) || cleaned === cleaned.toUpperCase()) return null;
    return { bad: cleaned };
  }

  async function loadPastPairs() {
    const { data, error } = await sb.from("past_pairs").select("id, giver, receiver").eq("family_id", family.id).order("giver").order("receiver");
    if (error) {
      $("pastList").innerHTML = /past_pairs/.test(error.message)
        ? banner("bad", "Run supabase/003_past_pairs.sql in Supabase to enable saved past draws.")
        : banner("bad", friendlyError(error));
      return;
    }
    pastPairs = data || [];
    renderPastPairs();
  }

  function renderPastPairs() {
    $("removeAllPast").hidden = !pastPairs.length;
    $("pastCount").textContent = pastPairs.length ? pastPairs.length : "";
    if (!pastPairs.length) { $("pastList").innerHTML = '<p class="muted">None saved yet.</p>'; return; }
    // Group by giver so each person's history sits on one line.
    const groups = new Map();
    pastPairs.forEach((p) => {
      const k = norm(cleanGiver(p.giver));
      if (!groups.has(k)) groups.set(k, { name: cleanGiver(p.giver), pairs: [] });
      groups.get(k).pairs.push(p);
    });
    $("pastList").innerHTML = Array.from(groups.values()).map((g) =>
      `<div class="past-row">
        <span class="past-giver">${esc(g.name)}</span>
        <span class="past-receivers"><span class="arrow">→</span>${g.pairs.map((p) =>
          `<span class="chip">${esc(p.receiver)}<button type="button" data-pair="${esc(p.id)}" aria-label="Remove ${esc(p.receiver)}">×</button></span>`).join("")}</span>
      </div>`).join("");
  }

  async function applyHistory() {
    const parsed = $("historyText").value.replace(/\r/g, "").split("\n").map(parseHistoryLine).filter(Boolean);
    const bad = parsed.filter((p) => p.bad).map((p) => p.bad);
    const key = (g, r) => norm(g) + "|" + norm(r);
    const have = new Set(pastPairs.map((p) => key(cleanGiver(p.giver), p.receiver)));
    const rows = [];
    let dupes = 0;
    parsed.filter((p) => !p.bad).forEach((p) => {
      const k = key(p.giver, p.receiver);
      if (have.has(k)) { dupes++; return; }
      have.add(k);
      rows.push({ family_id: family.id, giver: p.giver.slice(0, 100), receiver: p.receiver.slice(0, 100) });
    });
    if (!rows.length && !bad.length) { $("historyMsg").textContent = dupes ? "Already saved." : "Nothing to add."; return; }
    if (rows.length) {
      try { await persist(() => sb.from("past_pairs").insert(rows)); } catch (e) { return; }
      await loadPastPairs();
      invalidatePreview();
    }
    const parts = [`Saved ${rows.length}.`];
    if (dupes) parts.push(`${dupes} already saved.`);
    if (bad.length) parts.push(`Couldn't read: ${bad.slice(0, 3).join(" / ")}${bad.length > 3 ? " …" : ""}`);
    $("historyMsg").textContent = parts.join(" ");
    $("historyText").value = bad.join("\n");
  }

  async function removeAllPast() {
    const n = pastPairs.length;
    if (!n || !window.confirm(`Remove all ${n} saved past draws? This can't be undone.`)) return;
    try {
      await persist(() => sb.from("past_pairs").delete().eq("family_id", family.id));
      pastPairs = [];
      renderPastPairs();
      invalidatePreview();
      $("historyMsg").textContent = "";
    } catch (e) { await loadPastPairs(); }
  }

  async function removePastPair(event) {
    const one = event.target.closest("[data-pair]");
    const all = event.target.closest("[data-giver]");
    let ids;
    if (one) ids = [one.dataset.pair];
    else if (all) {
      ids = pastPairs.filter((p) => norm(cleanGiver(p.giver)) === norm(all.dataset.giver)).map((p) => p.id);
      if (!window.confirm(`Remove all ${ids.length} past draws for ${all.dataset.giver}?`)) return;
    } else return;
    try {
      await persist(() => sb.from("past_pairs").delete().in("id", ids));
      pastPairs = pastPairs.filter((p) => !ids.includes(p.id));
      renderPastPairs();
      invalidatePreview();
    } catch (e) {}
  }

  async function loadHistoryFiles(event) {
    const files = Array.from(event.target.files || []);
    const texts = await Promise.all(files.map((f) => f.text()));
    $("historyText").value = [$("historyText").value, ...texts].filter(Boolean).join("\n");
    event.target.value = "";
    applyHistory();
  }

  // ================================================================= DRAW
  async function loadDraws() {
    const { data, error } = await sb.from("draws").select("id, created_at").eq("family_id", family.id).order("created_at", { ascending: false }).limit(15);
    if (error) { toast(friendlyError(error), "bad"); return; }
    draws = data || [];
    assignments = [];
    if (draws.length) {
      const res = await sb.from("assignments").select("id, draw_id, giver_id, receiver_id, sent_at").in("draw_id", draws.map((d) => d.id));
      if (res.error) { toast(friendlyError(res.error), "bad"); return; }
      assignments = res.data || [];
    }
    renderDraw();
  }

  function currentDraw() { return draws[0] || null; }
  function assignmentsFor(drawId) { return assignments.filter((a) => a.draw_id === drawId); }
  function invalidatePreview() { if (preview) { preview = null; renderDraw(); } }

  function blocked(giver, other, recentReceivers) {
    if ((recentReceivers.get(giver.id) || new Set()).has(other.id)) return true;
    if ((giver.past_matches || []).some((n) => sameName(n, other.name))) return true;
    if (pastPairs.some((p) => pastNameMatches(cleanGiver(p.giver), giver.name) && pastNameMatches(p.receiver, other.name))) return true;
    if (list(giver.exclusions).some((n) => sameName(n, other.name))) return true;
    if (giver.group_name === "Adults" && other.group_name === "Adults" && giver.gender && other.gender && giver.gender !== other.gender) return true;
    return false;
  }

  // History often has full names ("Leah Rosen") while the list has "Leah", or vice versa.
  function pastNameMatches(historyName, memberName) {
    if (sameName(historyName, memberName)) return true;
    const shorter = historyName.split(/\s+/).slice(0, -1).join(" ");
    return !!shorter && sameName(shorter, memberName);
  }

  function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  function solve(group, label, recentReceivers) {
    const n = group.length;
    if (n === 0) return { pairs: [] };
    if (n < 2) return { error: `${label} need at least 2 people.` };
    const allowed = group.map((g, i) => group.map((_, j) => j).filter((j) => j !== i && !blocked(g, group[j], recentReceivers)));
    for (let i = 0; i < n; i++) {
      if (!allowed[i].length) return { error: `${group[i].name} has no one left to draw. Loosen their exclusions.` };
    }
    const order = group.map((_, i) => i).sort((a, b) => allowed[a].length - allowed[b].length);
    const used = new Array(n).fill(false), pick = new Array(n);
    let steps = 0;
    function dfs(k) {
      if (k === n) return true;
      if (++steps > 200000) return false;
      const i = order[k];
      for (const j of shuffle(allowed[i].slice())) {
        if (used[j]) continue;
        used[j] = true; pick[i] = j;
        if (dfs(k + 1)) return true;
        used[j] = false;
      }
      return false;
    }
    if (!dfs(0)) return { error: `No valid draw for ${label.toLowerCase()} with these rules. Remove an exclusion or past draw, or lower "Avoid repeats from site draws" in Settings.` };
    return { pairs: group.map((g, i) => ({ giver_id: g.id, receiver_id: group[pick[i]].id })) };
  }

  function makeDraw() {
    const active = members.filter((m) => m.active);
    const recentReceivers = new Map();
    draws.slice(0, family.avoid_recent_draws || 0).forEach((d) => {
      assignmentsFor(d.id).forEach((a) => {
        if (!recentReceivers.has(a.giver_id)) recentReceivers.set(a.giver_id, new Set());
        recentReceivers.get(a.giver_id).add(a.receiver_id);
      });
    });
    const adults = solve(active.filter((m) => m.group_name === "Adults"), "Adults", recentReceivers);
    const kids = solve(active.filter((m) => m.group_name === "Kids"), "Kids", recentReceivers);
    const error = adults.error || kids.error;
    if (error) { notice = banner("bad", error); preview = null; renderDraw(); return; }
    preview = adults.pairs.concat(kids.pairs);
    if (preview.length < 2) { preview = null; notice = banner("bad", "Add at least 2 people first."); renderDraw(); return; }
    const noEmail = active.filter((m) => !m.email).map((m) => m.name);
    notice = noEmail.length ? banner("gold", "No email for: " + noEmail.join(", ")) : "";
    Object.keys(revealed).forEach((k) => delete revealed[k]);
    renderDraw();
  }

  function banner(kind, text) { return `<div class="banner ${kind}">${esc(text)}</div>`; }

  async function saveDraw() {
    try {
      await persist(() => sb.rpc("save_draw", { p_family: family.id, p_pairs: preview }));
      preview = null;
      notice = banner("ok", "Draw saved. Ready to send.");
      await loadDraws();
      return true;
    } catch (e) { return false; }
  }

  async function deleteCurrentDraw() {
    const d = currentDraw();
    if (!d) return;
    const sent = assignmentsFor(d.id).filter((a) => a.sent_at).length;
    if (!window.confirm(sent ? `${sent} people were already emailed. Delete this draw anyway?` : "Delete this draw?")) return;
    try {
      await persist(() => sb.from("draws").delete().eq("id", d.id));
      notice = "";
      await loadDraws();
    } catch (e) {}
  }

  async function apiPost(path, body) {
    if (!cfg.apiBase) throw new Error("apiBase is missing in config.js");
    const { data: { session: s } } = await sb.auth.getSession();
    if (!s) throw new Error("Please sign in again.");
    const response = await fetch(cfg.apiBase.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.access_token },
      body: JSON.stringify(body || {})
    });
    return response.json().catch(() => ({ ok: false, error: "Server error " + response.status }));
  }

  async function sendEmails(drawId, assignmentIds, resend) {
    notice = banner("gold", "Sending… (can take up to a minute)");
    renderDraw();
    try {
      const result = await apiPost("/api/send-assignments", { drawId, assignmentIds, resend: !!resend });
      const failed = (result.results || []).filter((r) => !r.ok);
      const sentNow = (result.results || []).filter((r) => r.ok && !r.skipped).length;
      if (!result.results) notice = banner("bad", result.error || "Sending failed.");
      else if (failed.length) notice = `<div class="banner bad">Sent ${sentNow}. ${failed.length} failed:<br>${failed.map((f) => esc(f.error)).join("<br>")}</div>`;
      else notice = banner("ok", `Sent ${sentNow} email${sentNow === 1 ? "" : "s"}.`);
    } catch (error) {
      notice = banner("bad", friendlyError(error));
    }
    await loadDraws();
  }

  // Local calendar date as YYYY-MM-DD (not UTC), so "tomorrow" matches the organizer's clock.
  function localISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function describeDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const target = new Date(y, m - 1, d);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const days = Math.round((target - now) / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days > 1 && days < 7) return `in ${days} days`;
    return "on " + target.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }
  function setupHeadsUpDate() {
    const input = $("headsUpDate");
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    input.min = localISO(today);
    if (!input.value || input.value < input.min) input.value = localISO(tomorrow);
  }

  async function sendHeadsUp() {
    const recipients = members.filter((m) => m.active && m.email);
    if (!recipients.length) { toast("Nobody taking part has an email yet.", "bad"); return; }
    const date = $("headsUpDate").value;
    const today = localISO(new Date());
    if (!date || date < today) { toast("Pick a drawing date from today onward.", "bad"); return; }
    if (!window.confirm(`Email ${recipients.length} ${recipients.length === 1 ? "person" : "people"} that the drawing is ${describeDate(date)}?`)) return;
    const button = $("sendHeadsUp");
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const result = await apiPost("/api/send-heads-up", { familyId: family.id, date, today });
      const failed = (result.results || []).filter((r) => !r.ok);
      const sent = (result.results || []).filter((r) => r.ok).length;
      if (!result.results) notice = banner("bad", result.error || "Sending failed.");
      else if (failed.length) notice = `<div class="banner bad">Heads-up sent to ${sent}. ${failed.length} failed:<br>${failed.map((f) => esc(f.error)).join("<br>")}</div>`;
      else notice = banner("ok", `Heads-up sent to ${sent} ${sent === 1 ? "person" : "people"}.`);
    } catch (error) {
      notice = banner("bad", friendlyError(error));
    } finally {
      button.disabled = false;
      button.textContent = "Send";
      renderDraw();
    }
  }

  function nameOf(id) { return (memberById(id) || { name: "(removed)" }).name; }

  function resultsText(rows) {
    let out = family.name + "\n";
    ["Adults", "Kids"].forEach((group) => {
      const g = rows.filter((r) => (memberById(r.giver_id) || {}).group_name === group)
        .sort((a, b) => byName(nameOf(a.giver_id), nameOf(b.giver_id)));
      if (!g.length) return;
      out += "\n" + group.toUpperCase() + "\n";
      g.forEach((r) => { out += nameOf(r.giver_id) + " - " + nameOf(r.receiver_id) + "\n"; });
    });
    return out;
  }

  function renderDraw() {
    const controls = $("drawControls");
    const d = currentDraw();
    const rows = preview || (d ? assignmentsFor(d.id) : []);
    let status = "";

    if (preview) {
      controls.innerHTML = '<button class="ghost" data-act="cancel">Cancel</button><button data-act="draw">Reshuffle</button><button data-act="save">Save draw</button><button class="primary" data-act="saveSend">Save &amp; send all</button>';
      status = banner("gold", "Preview. Save to lock it in.");
    } else if (d) {
      const unsent = rows.filter((r) => !r.sent_at).length;
      controls.innerHTML =
        '<button class="ghost" data-act="deleteDraw">Delete</button><button class="ghost" data-act="download">Download</button><button data-act="draw">New draw</button>' +
        (unsent
          ? `<button class="primary" data-act="sendAll">Send all${unsent < rows.length ? ` (${unsent} left)` : ""}</button>`
          : '<button data-act="resendAll">Resend all</button>');
      status = `<p class="muted">Drawn ${esc(new Date(d.created_at).toLocaleDateString())} · ${rows.length - unsent}/${rows.length} sent</p>`;
    } else {
      controls.innerHTML = '<button class="primary" data-act="draw">Draw names</button>';
    }
    $("headsUpBar").hidden = !!preview;
    $("drawMsg").innerHTML = notice + status;

    const box = $("results");
    if (!rows.length) { box.innerHTML = '<div class="empty">No draw yet.</div>'; return; }
    box.innerHTML = ["Adults", "Kids"].map((group) => {
      const g = rows.filter((r) => (memberById(r.giver_id) || {}).group_name === group)
        .sort((a, b) => byName(nameOf(a.giver_id), nameOf(b.giver_id)));
      if (!g.length) return "";
      return `<div class="result-group">
        <div class="group-title">${group}</div>
        ${g.map((r) => {
          const giver = memberById(r.giver_id) || { name: "(removed)" };
          const key = r.id || r.giver_id;
          const shown = revealed[key];
          return `<div class="pair" data-key="${esc(key)}" data-id="${esc(r.id || "")}">
            <div class="who"><strong>${esc(giver.name)}</strong><span class="muted">${giver.email ? esc(giver.email) : "No email"}</span></div>
            <button type="button" class="match ${shown ? "" : "hidden-match"}" data-act="reveal" title="${shown ? "Hide" : "Show"}"><span class="arrow" aria-hidden="true">→</span>${shown ? esc(nameOf(r.receiver_id)) : "••••"}</button>
            <div class="pair-status">
              ${r.sent_at ? '<span class="tag ok">Sent</span>' : ""}
              ${r.id ? `<button type="button" class="link" data-act="sendOne">${r.sent_at ? "Resend" : "Send"}</button>` : ""}
            </div></div>`;
        }).join("")}</div>`;
    }).join("");
  }

  async function onDrawControl(event) {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    button.disabled = true;
    try {
      if (act !== "download") notice = "";
      if (act === "draw") makeDraw();
      else if (act === "save") await saveDraw();
      else if (act === "saveSend") { if (await saveDraw()) await sendEmails(currentDraw().id, null, false); }
      else if (act === "resendAll") { if (window.confirm("Email everyone their match again?")) await sendEmails(currentDraw().id, null, true); }
      else if (act === "cancel") { preview = null; renderDraw(); }
      else if (act === "sendAll") await sendEmails(currentDraw().id, null, false);
      else if (act === "deleteDraw") await deleteCurrentDraw();
      else if (act === "download") {
        const blob = new Blob([resultsText(assignmentsFor(currentDraw().id))], { type: "text/plain;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "secret-macabi-" + new Date().getFullYear() + ".txt";
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } finally {
      button.disabled = false;
    }
  }

  async function onResultClick(event) {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const row = button.closest(".pair");
    if (button.dataset.act === "reveal") {
      revealed[row.dataset.key] = !revealed[row.dataset.key];
      renderDraw();
    } else if (button.dataset.act === "sendOne") {
      button.disabled = true;
      button.textContent = "Sending…";
      await sendEmails(currentDraw().id, [row.dataset.id], true);
    }
  }

  // ================================================================= SHARING & ADMINS
  function shareUrl() {
    const url = new URL("wishlist.html", pageUrl);
    url.searchParams.set("f", family.share_token);
    return url.toString();
  }
  function renderShare() {
    $("openShare").href = shareUrl();
    $("wishlistNav").href = shareUrl();
    $("wishlistNavMenu").href = shareUrl();
  }

  async function regenerateShare() {
    if (!window.confirm("Reset the wish list link? The old link, including ones already emailed, will stop working.")) return;
    try {
      const { data } = await persist(() => sb.rpc("regenerate_share_token", { p_family: family.id }));
      family.share_token = data;
      renderShare();
      toast("New link created.");
    } catch (e) {}
  }

  async function testEmail() {
    const button = $("testEmail");
    button.disabled = true;
    button.textContent = "Sending…";
    try {
      const result = await apiPost("/api/test-email");
      toast(result.ok ? `Test sent to ${result.to}.` : "Test failed: " + result.error, result.ok ? "ok" : "bad");
    } catch (error) {
      toast(friendlyError(error), "bad");
    } finally {
      button.disabled = false;
      button.textContent = "Send test email";
    }
  }

  async function loadAdmins() {
    const { data, error } = await sb.rpc("list_family_admins", { p_family: family.id });
    if (error) { $("adminList").innerHTML = banner("bad", friendlyError(error)); return; }
    const isOwner = myRole === "owner";
    $("addAdminForm").hidden = !isOwner;
    $("adminList").innerHTML = data.map((a) => {
      const me = a.user_id === session.user.id;
      const canRemove = isOwner || me;
      return `<div class="admin-row"><span>${esc(a.email)}${me ? ' <span class="muted">(you)</span>' : ""}</span>
        <span class="tag">${esc(a.role)}</span>
        ${canRemove ? `<button type="button" class="link danger" data-user="${esc(a.user_id)}">${me ? "Leave" : "Remove"}</button>` : "<span></span>"}</div>`;
    }).join("");
  }

  async function addAdmin(event) {
    event.preventDefault();
    const email = $("adminEmail").value.trim();
    try {
      await persist(() => sb.rpc("add_family_admin", { p_family: family.id, p_email: email, p_role: $("adminRole").value }));
      $("adminEmail").value = "";
      loadAdmins();
    } catch (e) {}
  }

  async function removeAdmin(event) {
    const button = event.target.closest("[data-user]");
    if (!button) return;
    const me = button.dataset.user === session.user.id;
    if (!window.confirm(me ? "Leave this family? You'll lose access." : "Remove this admin?")) return;
    try {
      await persist(() => sb.rpc("remove_family_admin", { p_family: family.id, p_user: button.dataset.user }));
      if (me) { family = null; showFamilies(false); } else loadAdmins();
    } catch (e) {}
  }

  // ================================================================= wiring
  $("authForm").addEventListener("submit", signIn);
  $("signUpBtn").addEventListener("click", signUp);
  $("forgotBtn").addEventListener("click", forgotPassword);
  document.querySelectorAll('[data-act="signout"]').forEach((el) => el.addEventListener("click", signOut));
  $("newFamilyForm").addEventListener("submit", createFamily);
  $("familyList").addEventListener("click", (e) => { const b = e.target.closest(".family-pick"); if (b) openFamily(b.dataset.id); });
  $("switchFamily").addEventListener("click", () => { storageSet(LAST_FAMILY_KEY, ""); showFamilies(false); });
  document.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.querySelectorAll("[data-setting]").forEach((el) => el.addEventListener("change", saveSetting));
  $("addPersonForm").addEventListener("submit", addPerson);
  $("people").addEventListener("change", updatePersonField);
  $("people").addEventListener("click", onPeopleClick);
  $("peopleFile").addEventListener("change", importPeople);
  $("applyHistory").addEventListener("click", applyHistory);
  $("historyFile").addEventListener("change", loadHistoryFiles);
  $("pastList").addEventListener("click", removePastPair);
  $("removeAllPeople").addEventListener("click", removeAllPeople);
  $("removeAllPast").addEventListener("click", removeAllPast);
  $("drawControls").addEventListener("click", onDrawControl);
  $("results").addEventListener("click", onResultClick);
  $("copyShare").addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl()).then(() => toast("Link copied."), () => window.prompt("Copy this link:", shareUrl()));
  });
  $("regenShare").addEventListener("click", regenerateShare);
  $("testEmail").addEventListener("click", testEmail);
  $("sendHeadsUp").addEventListener("click", sendHeadsUp);
  $("addAdminForm").addEventListener("submit", addAdmin);

  // Phone menu (☰): open/close, and close on outside click, Escape, or choosing an item.
  function setMenu(open) {
    $("appMenu").classList.toggle("open", open);
    $("menuBtn").setAttribute("aria-expanded", open);
  }
  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); setMenu(!$("appMenu").classList.contains("open")); });
  $("appMenu").addEventListener("click", (e) => { if (e.target.closest("a, button")) setMenu(false); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#appMenu")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  $("adminList").addEventListener("click", removeAdmin);
  window.addEventListener("beforeunload", (e) => { if (pendingSaves) { e.preventDefault(); e.returnValue = ""; } });

  sb.auth.getSession().then(({ data }) => { if (!data.session) views("authView"); });
})();
