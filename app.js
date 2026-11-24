(function () {
  "use strict";

  const cfg = window.SECRET_MACABI_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const LAST_FAMILY_KEY = "secret-macabi-last-family";

  // ---------------------------------------------------------------- utilities
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function norm(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function sameName(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (x.indexOf(" ") < 0 || y.indexOf(" ") < 0) return x.split(" ")[0] === y.split(" ")[0];
    return false;
  }
  function list(value) {
    return String(value || "").split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }

  let toastTimer;
  function toast(message, kind) {
    const el = $("globalMsg");
    el.textContent = message;
    el.className = "toast " + (kind || "ok");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === "bad" ? 7000 : 3500);
  }
  function friendlyError(error) {
    const msg = (error && (error.message || error.error_description || error.error)) || String(error);
    if (/members_family_name_uidx/.test(msg)) return "Someone with that name is already in this family. Add a last name or initial.";
    if (/members_email_check/.test(msg)) return "That email address doesn't look right.";
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
    return msg;
  }
  function views(name) {
    ["authView", "familyView", "appView"].forEach((v) => { $(v).hidden = v !== name; });
  }

  // ---------------------------------------------------------------- setup check
  if (!window.supabase || !cfg.supabaseUrl || /YOUR-/.test(cfg.supabaseUrl + cfg.supabaseAnonKey)) {
    views("authView");
    $("authForm").hidden = true;
    $("authMsg").innerHTML = "This site isn't connected to its database yet. Fill in <code>supabaseUrl</code> and <code>supabaseAnonKey</code> in <code>config.js</code>.";
    return;
  }

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const pageUrl = window.location.href.split(/[?#]/)[0];

  // ---------------------------------------------------------------- state
  let session = null;
  let family = null;
  let myRole = null;
  let members = [];
  let draws = [];               // newest first
  let assignments = [];         // for all loaded draws
  let preview = null;           // unsaved draw: [{giver_id, receiver_id}]
  let notice = "";              // last send result banner (HTML)
  const revealed = {};

  // ================================================================= AUTH
  async function signIn(event) {
    event.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $("authEmail").value.trim(), password: $("authPassword").value });
    $("authMsg").textContent = error ? friendlyError(error) : "";
  }

  async function signUp() {
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    if (!email || password.length < 8) {
      $("authMsg").textContent = "Enter your email and a password of at least 8 characters, then press Create account.";
      return;
    }
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: pageUrl } });
    if (error) { $("authMsg").textContent = friendlyError(error); return; }
    $("authMsg").textContent = data.session ? "" : "Account created. Check your email to confirm it, then sign in.";
  }

  async function forgotPassword() {
    const email = $("authEmail").value.trim();
    if (!email) { $("authMsg").textContent = "Type your email first, then press Forgot password."; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl });
    $("authMsg").textContent = error ? friendlyError(error) : "If that account exists, a reset link is on its way.";
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
        const password = window.prompt("Choose a new password (at least 8 characters):");
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
    $("whoAmI").textContent = "Signed in as " + session.user.email;
    const { data, error } = await sb.from("family_admins").select("role, families(id, name)").eq("user_id", session.user.id);
    if (error) { $("familyList").innerHTML = '<div class="banner bad">' + esc(friendlyError(error)) + "</div>"; return; }
    const rows = (data || []).filter((r) => r.families);
    $("familyList").innerHTML = rows.length
      ? rows.map((r) => `<button type="button" class="family-pick" data-id="${esc(r.families.id)}">${esc(r.families.name)} <span class="hint">${esc(r.role)}</span></button>`).join("")
      : '<div class="empty">You are not an admin of any family yet.</div>';

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
    preview = null;
    notice = "";
    Object.keys(revealed).forEach((k) => delete revealed[k]);
    views("appView");
    renderSettings();
    renderShare();
    await Promise.all([loadMembers(), loadDraws(), loadAdmins()]);
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
    $("settingsMsg").textContent = "Saving…";
    const { error } = await sb.from("families").update({ [key]: value }).eq("id", family.id);
    if (error) { $("settingsMsg").textContent = ""; toast(friendlyError(error), "bad"); el.value = family[key]; return; }
    family[key] = value;
    $("settingsMsg").textContent = "Saved";
    if (key === "name") renderSettings();
    setTimeout(() => { $("settingsMsg").textContent = ""; }, 1500);
  }

  // ================================================================= MEMBERS
  async function loadMembers() {
    const { data, error } = await sb.from("members").select("*").eq("family_id", family.id).order("group_name").order("created_at");
    if (error) { toast(friendlyError(error), "bad"); return; }
    members = data || [];
    renderPeople();
  }

  function memberById(id) { return members.find((m) => m.id === id); }

  function renderPeople() {
    const box = $("people");
    if (!members.length) {
      box.innerHTML = '<div class="empty">Nobody yet. Add the adults and kids taking part.</div>';
    } else {
      box.innerHTML = members.map((p) => `
        <div class="person ${p.active ? "" : "inactive"}" data-id="${esc(p.id)}">
          <label><span>Name</span><input data-f="name" value="${esc(p.name)}" maxlength="100"></label>
          <label class="email"><span>Email</span><input data-f="email" type="email" value="${esc(p.email || "")}" placeholder="Parent's email for kids"></label>
          <label><span>Group</span><select data-f="group_name">
            <option ${p.group_name === "Adults" ? "selected" : ""}>Adults</option>
            <option ${p.group_name === "Kids" ? "selected" : ""}>Kids</option></select></label>
          <label><span>Gender</span><select data-f="gender" ${p.group_name === "Adults" ? "" : "disabled"}>
            <option value="" ${!p.gender ? "selected" : ""}>—</option>
            <option ${p.gender === "F" ? "selected" : ""}>F</option>
            <option ${p.gender === "M" ? "selected" : ""}>M</option></select></label>
          <label><span>Never pair with</span><input data-f="exclusions" value="${esc(p.exclusions)}"></label>
          <label><span>Past matches</span><input data-f="past_matches" value="${esc((p.past_matches || []).join(", "))}"></label>
          <label class="in-toggle"><span>In</span><input type="checkbox" data-f="active" ${p.active ? "checked" : ""}></label>
          <button class="remove" type="button" data-act="remove" aria-label="Remove ${esc(p.name)}">Remove</button>
        </div>`).join("");
    }
    const active = members.filter((m) => m.active);
    const adults = active.filter((m) => m.group_name === "Adults").length;
    const kids = active.length - adults;
    $("counts").textContent = `${adults} adult${adults === 1 ? "" : "s"} · ${kids} kid${kids === 1 ? "" : "s"}` +
      (members.length > active.length ? ` · ${members.length - active.length} sitting out` : "");
  }

  async function addPerson(event) {
    event.preventDefault();
    const row = {
      family_id: family.id,
      name: $("newName").value.trim(),
      email: $("newEmail").value.trim() || null,
      group_name: $("newGroup").value,
      gender: null
    };
    if (!row.name) return;
    const { data, error } = await sb.from("members").insert(row).select().single();
    if (error) { toast(friendlyError(error), "bad"); return; }
    members.push(data);
    $("newName").value = ""; $("newEmail").value = "";
    $("newName").focus();
    renderPeople();
    invalidatePreview();
  }

  async function updatePersonField(event) {
    const row = event.target.closest(".person");
    const field = event.target.dataset.f;
    if (!row || !field) return;
    const person = memberById(row.dataset.id);
    if (!person) return;

    let value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    if (field === "past_matches") value = list(value);
    if (field === "email") value = value.trim() || null;
    if (field === "gender") value = value || null;
    if (field === "name") { value = value.trim(); if (!value) { event.target.value = person.name; return; } }
    const patch = { [field]: value };
    if (field === "group_name" && value === "Kids") patch.gender = null;

    const { error } = await sb.from("members").update(patch).eq("id", person.id);
    if (error) { toast(friendlyError(error), "bad"); renderPeople(); return; }
    Object.assign(person, patch);
    if (field === "group_name" || field === "active") renderPeople();
    if (field === "name") renderDraw();
    invalidatePreview();
  }

  async function removePerson(event) {
    const button = event.target.closest('[data-act="remove"]');
    if (!button) return;
    const person = memberById(button.closest(".person").dataset.id);
    if (!person) return;
    const ok = window.confirm(`Remove ${person.name} for good? This also deletes their wish list and their part in past draws.\n\nTo just skip them this year, untick "In" instead.`);
    if (!ok) return;
    const { error } = await sb.from("members").delete().eq("id", person.id);
    if (error) { toast(friendlyError(error), "bad"); return; }
    members = members.filter((m) => m.id !== person.id);
    renderPeople();
    await loadDraws();
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
    const seen = new Set(members.map((m) => norm(m.name)));
    const rows = [];
    text.replace(/\r/g, "").split("\n").forEach((line) => {
      const p = parsePersonLine(line);
      if (!p || seen.has(norm(p.name))) return;
      seen.add(norm(p.name));
      rows.push({ family_id: family.id, name: p.name, email: p.email, group_name: p.group });
    });
    event.target.value = "";
    if (!rows.length) { toast("No new names found in that file.", "bad"); return; }
    const { error } = await sb.from("members").insert(rows);
    if (error) { toast(friendlyError(error), "bad"); return; }
    toast(`Imported ${rows.length} ${rows.length === 1 ? "person" : "people"}.`);
    await loadMembers();
    invalidatePreview();
  }

  function parseHistoryLine(line) {
    const cleaned = String(line || "").trim().replace(/^﻿/, "");
    let cut = -1;
    ["-", "–", "—", "→", ":", "="].forEach((sep) => {
      const i = cleaned.lastIndexOf(sep);
      if (i > 0 && i < cleaned.length - 1 && i > cut) cut = i;
    });
    if (cut < 0) return null;
    const who = cleaned.slice(0, cut).trim(), picked = cleaned.slice(cut + 1).trim();
    return who && picked ? { who, picked } : null;
  }

  async function applyHistory() {
    const lines = $("historyText").value.replace(/\r/g, "").split("\n").map(parseHistoryLine).filter(Boolean);
    if (!lines.length) { $("historyMsg").textContent = "No lines like “Name -Match” found."; return; }
    const changes = new Map();
    let matched = 0;
    lines.forEach(({ who, picked }) => {
      const shortWho = who.split(/\s+/).slice(0, -1).join(" ");
      const person = members.find((m) => sameName(m.name, who)) || (shortWho && members.find((m) => sameName(m.name, shortWho)));
      if (!person) return;
      matched++;
      const past = changes.get(person.id) || (person.past_matches || []).slice();
      if (!past.some((n) => sameName(n, picked))) past.push(picked);
      changes.set(person.id, past);
    });
    for (const [id, past] of changes) {
      const { error } = await sb.from("members").update({ past_matches: past }).eq("id", id);
      if (error) { toast(friendlyError(error), "bad"); return; }
      memberById(id).past_matches = past;
    }
    $("historyMsg").textContent = `Matched ${matched} of ${lines.length} lines.` + (matched < lines.length ? " Check spelling for the rest." : "");
    if (matched) $("historyText").value = "";
    renderPeople();
    invalidatePreview();
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
    if (list(giver.exclusions).some((n) => sameName(n, other.name))) return true;
    if (giver.group_name === "Adults" && other.group_name === "Adults" && giver.gender && other.gender && giver.gender !== other.gender) return true;
    return false;
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
    if (n < 2) return { error: label + " needs at least 2 people to draw." };
    const allowed = group.map((g, i) => group.map((_, j) => j).filter((j) => j !== i && !blocked(g, group[j], recentReceivers)));
    for (let i = 0; i < n; i++) {
      if (!allowed[i].length) return { error: group[i].name + " has nobody left they can draw. Loosen their exclusions or past matches." };
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
    if (!dfs(0)) {
      return { error: `There's no way to draw ${label.toLowerCase()} with these rules. Remove an exclusion or lower "Avoid repeats".` };
    }
    return { pairs: group.map((g, i) => ({ giver_id: g.id, receiver_id: group[pick[i]].id })) };
  }

  function makeDraw() {
    const active = members.filter((m) => m.active);
    const problems = [];
    active.forEach((m) => { if (!m.email) problems.push(m.name + " has no email (they can still be drawn, but won't get an email)."); });

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
    if (error) { $("drawMsg").innerHTML = '<div class="banner bad">' + esc(error) + "</div>"; return; }
    preview = adults.pairs.concat(kids.pairs);
    if (preview.length < 2) { preview = null; $("drawMsg").innerHTML = '<div class="banner bad">Add at least 2 people first.</div>'; return; }
    Object.keys(revealed).forEach((k) => delete revealed[k]);
    renderDraw(problems);
  }

  async function saveDraw() {
    const { data, error } = await sb.rpc("save_draw", { p_family: family.id, p_pairs: preview });
    if (error) { toast(friendlyError(error), "bad"); return; }
    preview = null;
    toast("Draw saved. Now send the emails.");
    await loadDraws();
    return data;
  }

  async function deleteCurrentDraw() {
    const d = currentDraw();
    if (!d) return;
    const sent = assignmentsFor(d.id).filter((a) => a.sent_at).length;
    const warning = sent
      ? `${sent} people were already emailed their match from this draw. Delete it anyway?`
      : "Delete this draw? (Nobody has been emailed yet.)";
    if (!window.confirm(warning)) return;
    const { error } = await sb.from("draws").delete().eq("id", d.id);
    if (error) { toast(friendlyError(error), "bad"); return; }
    await loadDraws();
  }

  async function sendEmails(drawId, assignmentIds, resend) {
    if (!cfg.apiBase) { toast("apiBase is missing in config.js", "bad"); return; }
    const { data: { session: s } } = await sb.auth.getSession();
    if (!s) { toast("Please sign in again.", "bad"); return; }
    $("drawMsg").innerHTML = '<div class="banner gold">Sending… the server may take up to a minute to wake up.</div>';
    notice = "";
    try {
      const response = await fetch(cfg.apiBase.replace(/\/$/, "") + "/api/send-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.access_token },
        body: JSON.stringify({ drawId, assignmentIds, resend: !!resend })
      });
      const result = await response.json().catch(() => ({ ok: false, error: "Server error " + response.status }));
      const failed = (result.results || []).filter((r) => !r.ok);
      const sentNow = (result.results || []).filter((r) => r.ok && !r.skipped).length;
      notice = !result.results
        ? '<div class="banner bad">' + esc(result.error || "Sending failed") + "</div>"
        : failed.length
        ? `<div class="banner bad"><span>Sent ${sentNow}. ${failed.length} failed:<br>${failed.map((f) => esc(f.error)).join("<br>")}</span></div>`
        : `<div class="banner ok"><span>Sent ${sentNow} email${sentNow === 1 ? "" : "s"}.</span></div>`;
    } catch (error) {
      notice = '<div class="banner bad">' + esc(friendlyError(error)) + "</div>";
    }
    await loadDraws();
  }

  function resultsText(rows) {
    let out = "Secret Macabi — " + family.name + "\n";
    ["Adults", "Kids"].forEach((group) => {
      const g = rows.filter((r) => (memberById(r.giver_id) || {}).group_name === group);
      if (!g.length) return;
      out += "\n" + group.toUpperCase() + "\n";
      g.forEach((r) => { out += nameOf(r.giver_id) + " -" + nameOf(r.receiver_id) + "\n"; });
    });
    return out;
  }
  function nameOf(id) { return (memberById(id) || { name: "(removed)" }).name; }

  function renderDraw(warnings) {
    const controls = $("drawControls");
    const d = currentDraw();
    const rows = preview || (d ? assignmentsFor(d.id) : []);

    if (preview) {
      controls.innerHTML = '<button class="primary" data-act="save">Save this draw</button><button data-act="draw">Shuffle again</button><button class="ghost" data-act="cancel">Cancel</button>';
      $("drawMsg").innerHTML = '<div class="banner gold"><span>Not saved yet. Save the draw to lock it in, then send the emails.' +
        (warnings && warnings.length ? "<br>" + warnings.map(esc).join("<br>") : "") + "</span></div>";
    } else if (d) {
      const unsent = rows.filter((r) => !r.sent_at).length;
      controls.innerHTML =
        (unsent ? `<button class="primary" data-act="sendAll">Send ${unsent} unsent email${unsent === 1 ? "" : "s"}</button>` : "") +
        '<button data-act="download">Download results</button><button data-act="draw">Start a new draw</button><button class="ghost" data-act="deleteDraw">Delete this draw</button>';
      $("drawMsg").innerHTML = notice ||
        `<div class="banner ok"><span>Draw from ${new Date(d.created_at).toLocaleDateString()}: ${rows.length - unsent} of ${rows.length} emailed.</span></div>`;
    } else {
      controls.innerHTML = '<button class="primary" data-act="draw">Draw names</button>';
      $("drawMsg").innerHTML = "";
    }

    const box = $("results");
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Nobody has been drawn yet. Check the list in step 2, then press Draw names.</div>';
      return;
    }
    box.innerHTML = ["Adults", "Kids"].map((group) => {
      const g = rows.filter((r) => (memberById(r.giver_id) || {}).group_name === group);
      if (!g.length) return "";
      return `<div>
        <div class="group-title"><span>${group}</span><span>${g.length}</span></div>
        <div class="ledger">${g.map((r) => {
          const giver = memberById(r.giver_id) || { name: "(removed)" };
          const key = r.id || r.giver_id;
          const shown = revealed[key];
          return `<div class="pair ${r.sent_at ? "is-sent" : ""}" data-key="${esc(key)}" data-id="${esc(r.id || "")}">
            <div class="who"><strong>${esc(giver.name)}</strong>
              <span class="addr">${giver.email ? esc(giver.email) : "No email"}${r.sent_at ? " · sent " + esc(new Date(r.sent_at).toLocaleString()) : ""}</span></div>
            <div class="match ${shown ? "" : "hidden-match"}">${shown ? "→ " + esc(nameOf(r.receiver_id)) : "• • • •"}</div>
            <div class="actions">
              <button type="button" data-act="reveal">${shown ? "Hide" : "Show"}</button>
              ${r.id ? `<button type="button" data-act="sendOne">${r.sent_at ? "Resend" : "Send"}</button>` : ""}
            </div></div>`;
        }).join("")}</div></div>`;
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
      else if (act === "cancel") { preview = null; $("drawMsg").innerHTML = ""; renderDraw(); }
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
    $("shareLink").value = shareUrl();
    $("wishlistNav").href = shareUrl();
  }

  async function regenerateShare() {
    if (!window.confirm("Make a new wish-list link? The old link (including links in emails already sent) will stop working.")) return;
    const { data, error } = await sb.rpc("regenerate_share_token", { p_family: family.id });
    if (error) { toast(friendlyError(error), "bad"); return; }
    family.share_token = data;
    renderShare();
    toast("New link created.");
  }

  async function testEmail() {
    const button = $("testEmail");
    button.disabled = true;
    button.textContent = "Sending… (server may be waking up)";
    try {
      const { data: { session: s } } = await sb.auth.getSession();
      const response = await fetch(cfg.apiBase.replace(/\/$/, "") + "/api/test-email", {
        method: "POST", headers: { Authorization: "Bearer " + s.access_token }
      });
      const result = await response.json().catch(() => ({ ok: false, error: "Server error " + response.status }));
      toast(result.ok ? `Test email sent to ${result.to}. ${result.remainingToday} left today.` : "Test failed: " + result.error, result.ok ? "ok" : "bad");
    } catch (error) {
      toast(friendlyError(error), "bad");
    } finally {
      button.disabled = false;
      button.textContent = "Send me a test email";
    }
  }

  async function loadAdmins() {
    const { data, error } = await sb.rpc("list_family_admins", { p_family: family.id });
    if (error) { $("adminList").innerHTML = '<div class="banner bad">' + esc(friendlyError(error)) + "</div>"; return; }
    const isOwner = myRole === "owner";
    $("addAdminForm").hidden = !isOwner;
    $("adminCount").textContent = data.length;
    $("adminList").innerHTML = data.map((a) => {
      const me = a.user_id === session.user.id;
      const canRemove = isOwner || me;
      return `<div class="admin-row"><span>${esc(a.email)}${me ? " (you)" : ""}</span>
        <span class="hint">${esc(a.role)}</span>
        ${canRemove ? `<button type="button" class="remove" data-user="${esc(a.user_id)}">${me ? "Leave" : "Remove"}</button>` : ""}</div>`;
    }).join("");
  }

  async function addAdmin(event) {
    event.preventDefault();
    const email = $("adminEmail").value.trim();
    const { error } = await sb.rpc("add_family_admin", { p_family: family.id, p_email: email, p_role: $("adminRole").value });
    if (error) { toast(friendlyError(error), "bad"); return; }
    $("adminEmail").value = "";
    toast(email + " is now an admin.");
    loadAdmins();
  }

  async function removeAdmin(event) {
    const button = event.target.closest("[data-user]");
    if (!button) return;
    const me = button.dataset.user === session.user.id;
    if (!window.confirm(me ? "Leave this family? You'll lose access." : "Remove this admin?")) return;
    const { error } = await sb.rpc("remove_family_admin", { p_family: family.id, p_user: button.dataset.user });
    if (error) { toast(friendlyError(error), "bad"); return; }
    if (me) { family = null; showFamilies(false); } else loadAdmins();
  }

  // ================================================================= wiring
  $("authForm").addEventListener("submit", signIn);
  $("signUpBtn").addEventListener("click", signUp);
  $("forgotBtn").addEventListener("click", forgotPassword);
  document.querySelectorAll('[data-act="signout"]').forEach((el) => el.addEventListener("click", signOut));
  $("newFamilyForm").addEventListener("submit", createFamily);
  $("familyList").addEventListener("click", (e) => { const b = e.target.closest(".family-pick"); if (b) openFamily(b.dataset.id); });
  $("switchFamily").addEventListener("click", (e) => { e.preventDefault(); storageSet(LAST_FAMILY_KEY, ""); showFamilies(false); });
  document.querySelectorAll("[data-setting]").forEach((el) => el.addEventListener("change", saveSetting));
  $("addPersonForm").addEventListener("submit", addPerson);
  $("people").addEventListener("change", updatePersonField);
  $("people").addEventListener("click", removePerson);
  $("peopleFile").addEventListener("change", importPeople);
  $("applyHistory").addEventListener("click", applyHistory);
  $("historyFile").addEventListener("change", loadHistoryFiles);
  $("drawControls").addEventListener("click", onDrawControl);
  $("results").addEventListener("click", onResultClick);
  $("copyShare").addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl()).then(() => toast("Link copied."), () => { $("shareLink").select(); });
  });
  $("regenShare").addEventListener("click", regenerateShare);
  $("testEmail").addEventListener("click", testEmail);
  $("addAdminForm").addEventListener("submit", addAdmin);
  $("adminList").addEventListener("click", removeAdmin);

  sb.auth.getSession().then(({ data }) => { if (!data.session) views("authView"); });
})();
