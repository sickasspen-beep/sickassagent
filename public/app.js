"use strict";

// ---- Tiny helpers --------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* no body */
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let toastTimer;
function toast(message, isError = false) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function timeLeft(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "Closed";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  if (days >= 1) return `${days}d ${hours}h left`;
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${mins}m left`;
}

// ---- Sleeper identity ----------------------------------------------------
// The voter's Sleeper username is remembered in this browser; votes are tracked
// server-side by the team name resolved from their league.
const SLEEPER_KEY = "sleeperUsername";
let verifiedTeam = null; // resolved team name once verified, else null

function getSleeperUsername() {
  return (localStorage.getItem(SLEEPER_KEY) || "").trim();
}

function setSleeperStatus(text, kind) {
  const el = $("#sleeper-status");
  el.textContent = text;
  el.className = "identity-status " + (kind || "muted");
}

async function verifySleeper(username, { quiet = false } = {}) {
  verifiedTeam = null;
  const name = (username || "").trim();
  if (!name) {
    setSleeperStatus("Enter your Sleeper username to vote.", "muted");
    return false;
  }
  if (!quiet) setSleeperStatus("Checking…", "muted");
  try {
    const data = await api(`/api/sleeper/me?username=${encodeURIComponent(name)}`);
    verifiedTeam = data.teamName;
    localStorage.setItem(SLEEPER_KEY, name);
    setSleeperStatus(`✓ Voting as ${data.teamName}`, "ok");
    return true;
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return false;
    }
    setSleeperStatus(err.message, "err");
    return false;
  }
}

function initIdentity() {
  const saved = getSleeperUsername();
  $("#sleeper-input").value = saved;
  if (saved) verifySleeper(saved, { quiet: true });
  else setSleeperStatus("Enter your Sleeper username to vote.", "muted");
}

$("#sleeper-save-btn").addEventListener("click", async () => {
  const ok = await verifySleeper($("#sleeper-input").value);
  if (ok) loadPolls(); // refresh so the viewer's own votes are flagged
});

$("#sleeper-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#sleeper-save-btn").click();
  }
});

// ---- Views ---------------------------------------------------------------
function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  $("#password-input").focus();
}

function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  showList();
  initIdentity();
  loadPolls();
}

function showList() {
  $("#create-view").classList.add("hidden");
  $("#list-view").classList.remove("hidden");
}

function showCreate() {
  $("#list-view").classList.add("hidden");
  $("#create-view").classList.remove("hidden");
  resetCreateForm();
  $("#question-input").focus();
}

// ---- Auth ----------------------------------------------------------------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#login-error");
  errEl.classList.add("hidden");
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#password-input").value }),
    });
    $("#password-input").value = "";
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

// ---- Create poll form ----------------------------------------------------
function makeOptionRow(value = "") {
  const row = document.createElement("div");
  row.className = "option-row";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 200;
  input.placeholder = "Option";
  input.value = value;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-option";
  remove.textContent = "✕";
  remove.title = "Remove option";
  remove.addEventListener("click", () => {
    const rows = $$("#options-list .option-row");
    if (rows.length <= 2) {
      toast("A poll needs at least 2 options", true);
      return;
    }
    row.remove();
  });
  row.appendChild(input);
  row.appendChild(remove);
  return row;
}

function resetCreateForm() {
  $("#create-form").reset();
  const list = $("#options-list");
  list.innerHTML = "";
  list.appendChild(makeOptionRow());
  list.appendChild(makeOptionRow());
  $("#create-error").classList.add("hidden");
}

$("#add-option-btn").addEventListener("click", () => {
  const rows = $$("#options-list .option-row");
  if (rows.length >= 10) {
    toast("You can add up to 10 options", true);
    return;
  }
  $("#options-list").appendChild(makeOptionRow());
});

$("#new-poll-btn").addEventListener("click", showCreate);
$("#cancel-create-btn").addEventListener("click", showList);
$("#home-link").addEventListener("click", () => {
  showList();
  loadPolls();
});

$("#create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#create-error");
  errEl.classList.add("hidden");

  const question = $("#question-input").value.trim();
  const options = $$("#options-list input").map((i) => i.value.trim());
  const durationDays = Number(
    ($('input[name="duration"]:checked') || {}).value
  );

  try {
    await api("/api/polls", {
      method: "POST",
      body: JSON.stringify({ question, options, durationDays }),
    });
    toast("Poll created 🎉");
    showList();
    loadPolls();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

// ---- Poll list & voting --------------------------------------------------
async function loadPolls() {
  try {
    const u = getSleeperUsername();
    const qs = u ? `?sleeper=${encodeURIComponent(u)}` : "";
    const polls = await api(`/api/polls${qs}`);
    renderPolls(polls);
  } catch (err) {
    if (err.status === 401) {
      showLogin();
      return;
    }
    toast(err.message, true);
  }
}

function renderPolls(polls) {
  const container = $("#polls-container");
  container.innerHTML = "";
  $("#empty-state").classList.toggle("hidden", polls.length > 0);

  for (const poll of polls) {
    container.appendChild(renderPollCard(poll));
  }
}

function renderPollCard(poll) {
  const card = document.createElement("div");
  card.className = "poll-card";

  const hasVoted = poll.votedOptionId != null;
  const showResults = hasVoted || poll.closed;

  const optionsHtml = poll.options
    .map((opt) => {
      const pct =
        poll.totalVotes > 0 ? Math.round((opt.votes / poll.totalVotes) * 100) : 0;
      const chosen = poll.votedOptionId === opt.id;
      const votable = !showResults;
      const meta = showResults
        ? `<span class="opt-meta">${opt.votes} · ${pct}%</span>`
        : "";
      const teams =
        showResults && opt.teams && opt.teams.length
          ? `<div class="opt-teams">${opt.teams
              .map((t) => `<span class="team-chip">${escapeHtml(t)}</span>`)
              .join("")}</div>`
          : "";
      return `
        <div class="opt ${votable ? "votable" : "disabled"} ${
        chosen ? "chosen" : ""
      }" data-option-id="${opt.id}">
          <div class="bar" style="width:${showResults ? pct : 0}%"></div>
          <div class="opt-content">
            <span class="opt-label">${escapeHtml(opt.label)}</span>
            ${meta}
          </div>
          ${teams}
        </div>`;
    })
    .join("");

  const badge = poll.closed
    ? `<span class="badge closed">Closed</span>`
    : `<span class="badge open">Open</span>`;

  card.innerHTML = `
    <div class="poll-head">
      <h3 class="poll-question">${escapeHtml(poll.question)}</h3>
      ${badge}
    </div>
    <div class="poll-options">${optionsHtml}</div>
    <div class="poll-foot">
      <span>${poll.totalVotes} vote${poll.totalVotes === 1 ? "" : "s"}</span>
      <span>${timeLeft(poll.expiresAt)}</span>
    </div>
  `;

  if (!showResults) {
    card.querySelectorAll(".opt.votable").forEach((el) => {
      el.addEventListener("click", () => vote(poll.id, el.dataset.optionId));
    });
  }

  return card;
}

async function vote(pollId, optionId) {
  const username = getSleeperUsername();
  if (!username) {
    toast("Enter your Sleeper username first", true);
    $("#sleeper-input").focus();
    return;
  }
  try {
    const result = await api(`/api/polls/${pollId}/vote`, {
      method: "POST",
      body: JSON.stringify({ optionId: Number(optionId), sleeperUsername: username }),
    });
    toast(`Vote recorded as ${result.votedAs} ✓`);
    loadPolls();
  } catch (err) {
    toast(err.message, true);
    // 409 = already voted; refresh so results/their existing vote show.
    if (err.status === 409) loadPolls();
  }
}

// ---- Boot ----------------------------------------------------------------
(async function init() {
  try {
    const { authed } = await api("/api/session");
    if (authed) showApp();
    else showLogin();
  } catch (_) {
    showLogin();
  }
})();
