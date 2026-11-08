
const SUPABASE_SDK_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
  "https://esm.sh/@supabase/supabase-js@2?bundle",
];
let createClient = null;
function timeLimit(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`${label} timed out. Check your connection and retry.`)
          ),
        milliseconds
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
async function loadSupabaseSdk() {
  const attempts = [];
  for (const url of SUPABASE_SDK_SOURCES) {
    try {
      const library = await timeLimit(
        import(/* @vite-ignore */ url),
        9000,
        "Loading the game library"
      );
      if (typeof library.createClient !== "function")
        throw new Error("Missing createClient export");
      return library.createClient;
    } catch (error) {
      console.warn(
        "Cards Against Encore: SDK source unavailable:",
        new URL(url).hostname,
        error
      );
      attempts.push(new URL(url).hostname);
    }
  }
  throw new Error(
    `Could not load the Supabase game library from ${attempts.join( " or " )}. Check internet/CDN access, or try another network.`
  );
}
window.__encoreAppStarted = true;

// Cards Against Encore — zero-build static client.
// Security-sensitive game logic lives in the Supabase SQL RPCs, not this file.
const cfg = window.ENCORE_CONFIG || {};
const app = document.getElementById("app");
const toasts = document.getElementById("toasts");
let db = null;
let user = null;
let currentRoomId = null;
let state = null;
let channel = null;
let onlineMembers = new Set();
let selected = [];
let customText = "";
let roomSignature = "";
let offsetMs = 0;
let inFlight = false;
let refreshQueued = false;
let refreshTimer = null;
let clockTimer = null;
let zeroTimerLast = 0;
let pendingAction = false;
let roomTransition = false;
let nickname = localStorage.getItem("cae_nickname") || "";
let cardDraft = { kind: "prompt", picks: "1", text: "" };

const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        ch
      ])
  );
const q = (s) => app.querySelector(s);
const all = (s) => [...app.querySelectorAll(s)];
const html = (s, fallback = "") => escapeHtml(s ?? fallback);
const confValid = () =>
  Boolean(
    /^https:\/\/[^ ]+\.supabase\.co\/?$/.test(cfg.supabaseUrl || "") &&
      cfg.publishableKey &&
      !/YOUR|REPLACE|PLACEHOLDER/i.test(cfg.publishableKey)
  );
const asset = (value) => {
  // Only safe http(s) or local paths are supported for decorative artwork.
  if (typeof value !== "string" || !value || /["'()\\\s]/.test(value))
    return null;
  if (/^(https?:\/\/|assets\/)/i.test(value)) return value;
  return null;
};
const assetPath = (key) =>
  asset(cfg.assets?.[key]) ||
  {
    promptFront: "assets/cards/prompt-front.svg",
    responseFront: "assets/cards/response-front.svg",
    cardBack: "assets/cards/card-back.svg",
    logo: "assets/cards/crest.svg",
  }[key];
function applyAssets() {
  for (const [key, css] of Object.entries({
    promptFront: "--prompt-art",
    responseFront: "--response-art",
    cardBack: "--back-art",
    logo: "--logo-art",
  })) {
    document.documentElement.style.setProperty(css, `url("${assetPath(key)}")`);
  }
}
function toast(message, kind = "info") {
  const box = document.createElement("div");
  box.className = `toast ${kind}`;
  box.textContent = message;
  toasts.append(box);
  setTimeout(() => box.remove(), 4300);
}
function friendlyError(error) {
  const s = String(error?.message || error || "Something went wrong.");
  if (
    /anonymous sign-ins|anonymous sign in|Anonymous sign-ins|Anonymous users are disabled/i.test(
      s
    )
  )
    return "Enable Anonymous Sign-Ins in Supabase → Authentication → Providers → Anonymous.";
  if (/failed to fetch|networkerror/i.test(s))
    return "Connection failed. Check your internet, Supabase URL, and project status.";
  if (/could not find the function|schema cache/i.test(s))
    return "The database setup is missing or incomplete. Run the six SQL repair steps STEP_01 through STEP_06 in Supabase SQL Editor.";
  return s;
}
async function rpc(fn, args = {}) {
  if (!db) throw new Error("Supabase has not been configured.");
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data;
}
function setupError(message) {
  app.innerHTML = `<section class="panel panel-pad error-panel"> <div class="eyebrow">✦ THE CURTAIN ISN'T READY</div> <h1>One little setup step.</h1><p>${html(message)}</p> <p class="text-note">Open <code>site/config.js</code>, add your Supabase project URL and publishable key, and run the six numbered SQL setup files (<code>STEP_01</code> through <code>STEP_06</code>) in Supabase's SQL Editor. Enable Anonymous Sign-Ins too.</p> <button class="action action-secondary" data-action="retry-init">Try Again</button> </section>`;
}
async function init() {
  applyAssets();
  if (!confValid()) {
    setupError("Your Supabase URL or publishable key is missing or invalid.");
    window.__encoreBootComplete = true;
    return;
  }
  try {
    if (!createClient) createClient = await loadSupabaseSdk();
    db = createClient(cfg.supabaseUrl, cfg.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    let {
      data: { session },
      error,
    } = await timeLimit(db.auth.getSession(), 12000, "Restoring guest session");
    if (error) throw error;
    if (!session) {
      const result = await timeLimit(
        db.auth.signInAnonymously(),
        12000,
        "Guest sign-in"
      );
      if (result.error) throw result.error;
      session = result.data.session;
    }
    user =
      session?.user ||
      (await timeLimit(db.auth.getUser(), 12000, "Checking guest session")).data
        .user;
    if (!user) throw new Error("Could not create a guest player session.");
    const last = readLastRoom();
    const invitedCode = new URL(location.href).searchParams
      .get("room")
      ?.toUpperCase();
    if (last?.id && (!invitedCode || invitedCode === last.code)) {
      currentRoomId = last.id;
      try {
        await refreshState(true);
        if (!state) throw new Error("The room could not be restored.");
        connectRoom();
      } catch (error) {
        currentRoomId = null;
        localStorage.removeItem("cae_room");
        renderLanding();
      }
    } else renderLanding();
    if (!refreshTimer)
      refreshTimer = setInterval(() => {
        if (currentRoomId) refreshState();
      }, 3000);
    if (!clockTimer) clockTimer = setInterval(updateClock, 200);
    window.__encoreBootComplete = true;
  } catch (error) {
    console.error("Cards Against Encore startup error:", error);
    setupError(friendlyError(error));
    window.__encoreBootComplete = true;
  }
}
function readLastRoom() {
  try {
    return JSON.parse(localStorage.getItem("cae_room") || "null");
  } catch {
    return null;
  }
}
function saveRoom(id, code) {
  localStorage.setItem("cae_room", JSON.stringify({ id, code }));
}
function renderLanding() {
  state = null;
  roomSignature = "";
  onlineMembers.clear();
  selected = [];
  customText = "";
  const code = new URL(location.href).searchParams.get("room") || "";
  app.innerHTML = ` <section class="hero"> <img class="crest" src="${assetPath("logo")}" alt="Azure crown crest"> <div class="eyebrow eyebrow-gold">✦ THE AZURE PARLOR PRESENTS ✦</div> <h1 class="hero-title">Cards Against <em>Encore</em></h1> <p class="hero-subtitle">An absurd game of perfect timing and terrible answers. Grab your friends, unleash the chaos, and steal the spotlight.</p> <div class="divider-star">✦ ✧ ✦</div> <div class="hero-cards" aria-hidden="true"><div class="mini-back mini-back-left"></div><div class="mini-back mini-back-center"></div><div class="mini-back mini-back-right"></div></div> <div class="info-cards" style="justify-content:center"><span class="badge">3–16 Players</span><span class="badge">Live Multiplayer</span><span class="badge">Write Your Own Answers</span><span class="badge">No Account Needed</span></div> </section> <section class="intro-grid"> <div class="panel"> <div class="eyebrow">01 / THE HOST</div><h2>Create a room</h2> <p>Become the master of ceremonies. Invite friends using a room code or a link.</p> <form data-form="create"> <div class="field"><label for="createNick">Your stage name</label><input id="createNick" name="nickname" maxlength="24" required placeholder="The Grand Jester" autocomplete="nickname" value="${html( nickname )}"></div> <button class="action action-block" type="submit">✦ Create Your Stage</button> </form> </div> <div class="panel"> <div class="eyebrow">02 / THE GUEST</div><h2>Join a room</h2> <p>Someone has already started the show? Enter their code to join the cast.</p> <form data-form="join"> <div class="field"><label for="joinNick">Your stage name</label><input id="joinNick" name="nickname" maxlength="24" required placeholder="The Mysterious Guest" autocomplete="nickname" value="${html( nickname )}"></div> <div class="field"><label for="roomCode">Six-character room code</label><input id="roomCode" name="code" maxlength="6" minlength="6" spellcheck="false" autocapitalize="characters" required placeholder="A3F09B" value="${html( code.toUpperCase() )}"></div> <button class="action action-block action-secondary" type="submit">✧ Enter the Theater</button> </form> </div> </section> <p class="text-note" style="text-align:center;margin:23px auto;max-width:700px">In a round, everyone selects ${"1–3"} response cards or writes a custom answer. A rotating judge or the entire group picks the winner. The scores and countdowns synchronize across devices.</p>`;
}
function playerById(id) {
  return (state?.players || []).find((p) => p.id === id);
}
function statusMeta() {
  const r = state.room;
  const isJudge = r.mode === "judge" && r.judge_member_id === state.me.id;
  if (r.phase === "lobby")
    return [
      "Gather Your Cast",
      "Share your room code. The performance begins when the host starts the game.",
    ];
  if (r.phase === "submit")
    return [
      isJudge ? "Your Turn to Judge" : "The Cards Are Dealt",
      isJudge
        ? "You are the judge. Wait for the others to submit their funniest answers."
        : "Choose the required number of responses before the countdown ends.",
    ];
  if (r.phase === "judge")
    return [
      r.mode === "vote" ? "The Audience Decides" : "The Judge Decides",
      r.mode === "vote"
        ? "Each player who submitted votes for someone else."
        : "The judge picks the funniest anonymous response.",
    ];
  if (r.phase === "results")
    return [
      "The Grand Reveal",
      "A winner steps into the spotlight. Next round begins automatically.",
    ];
  return [
    "The Final Curtain",
    "The game has ended. The host can start another performance.",
  ];
}
function playerRow(p) {
  const you = p.id === state.me.id;
  return `<div class="player-row"><div style="min-width:0"><div class="player-name">${html( p.nickname )} ${you ? '<span class="tiny-tag">YOU</span>' : ""}</div> <div class="tiny">${ p.is_host ? '<span class="tiny-tag">♛ HOST</span> ' : "" }${ p.is_judge && state.room.phase !== "ended" ? '<span class="tiny-tag">✦ JUDGE</span>' : "" }</div></div> <div class="player-meta"><span class="player-dot" data-member-id="${ p.id }" aria-label="Offline"></span><strong class="score">${ p.score } ★</strong></div></div>`;
}
function sidebar() {
  const players = state.players;
  return `<aside class="sidebar"> <section class="panel panel-pad"><div class="section-label">✦ THE CAST <span class="badge">${ players.length }/16</span></div> <div class="stat-row"><span>Connected now</span><strong id="onlineCount">—</strong></div> <div class="player-list">${players.map(playerRow).join("")}</div> <p class="side-hint" style="margin:14px 0 0">Green dots mean online. Offline players can rejoin on the same device without losing their score.</p> </section> <section class="panel panel-pad"><div class="section-label">✧ HOW TO PLAY</div> <div class="stat-row"><span>Game mode</span><strong>${ state.room.mode === "judge" ? "Judge’s Choice" : "Audience Vote" }</strong></div> <div class="stat-row"><span>Responding</span><strong>${ state.room.answer_seconds }s</strong></div> <div class="stat-row"><span>Judging</span><strong>${ state.room.judge_seconds }s</strong></div> <div class="divider"></div><p class="side-hint">Blue prompt = the question. Light cards = your private hand. Write one custom response per round if your imagination demands it.</p> </section> </aside>`;
}
function showHostSettings() {
  const r = state.room;
  return `<section class="panel game-panel"><div class="section-label">♛ HOST'S CONTROL ROOM</div> <h2>Prepare the performance</h2><p class="text-note">Choose how the winner is picked and how long each round lasts.</p> <form data-form="start"> <div class="settings-grid"> <div class="field"><label for="gameMode">Win condition</label><select id="gameMode" name="mode"><option value="judge" ${ r.mode === "judge" ? "selected" : "" }>Rotating Judge</option><option value="vote" ${ r.mode === "vote" ? "selected" : "" }>Everyone Votes</option></select></div> <div class="field"><label for="roundLimit">Total rounds</label><select id="roundLimit" name="rounds">${[ 3, 5, 8, 10, 12, 15, 20, 30, ] .map( (n) => `<option value="${n}" ${ n === r.round_limit ? "selected" : "" }>${n} rounds</option>` ) .join("")}</select></div> <div class="field"><label for="answerSecs">Response time</label><select id="answerSecs" name="answerSecs">${[ 20, 30, 45, 60, 90, 120, 180, ] .map( (n) => `<option value="${n}" ${ n === r.answer_seconds ? "selected" : "" }>${n} seconds</option>` ) .join("")}</select></div> <div class="field"><label for="judgeSecs">Judging / voting time</label><select id="judgeSecs" name="judgeSecs">${[ 15, 20, 30, 45, 60, 90, 120, ] .map( (n) => `<option value="${n}" ${ n === r.judge_seconds ? "selected" : "" }>${n} seconds</option>` ) .join("")}</select></div> </div> <div class="settings-footer"><button class="action action-gold" type="submit" ${ state.players.length < 3 ? "disabled" : "" }>✦ ${r.phase === "ended" ? "Play Another Game" : "Begin the Show"} (${ state.players.length }/3 minimum)</button></div> </form> </section>`;
}
function customDeckPanel() {
  const cards = state.custom_cards || [];
  return `<section class="panel game-panel"> <div class="section-label">✦ THE PERSONALIZED DECK</div> <h2>Create your own cards</h2> <p class="text-note">Host-only: add black prompt cards or light response cards for this room. Every future round can draw them automatically.</p> <form data-form="card"> <div class="settings-grid"> <div class="field"><label for="deckKind">Card type</label><select id="deckKind" name="kind"><option value="prompt" ${ cardDraft.kind === "prompt" ? "selected" : "" }>Prompt (dark blue)</option><option value="answer" ${ cardDraft.kind === "answer" ? "selected" : "" }>Response (light blue)</option></select></div> <div class="field"><label for="deckPicks">Answers required</label><select id="deckPicks" name="picks" ${ cardDraft.kind === "answer" ? "disabled" : "" }>${[1, 2, 3] .map( (n) => `<option value="${n}" ${ Number(cardDraft.picks) === n ? "selected" : "" }>Pick ${n}</option>` ) .join("")}</select></div> </div> <div class="field"><label for="deckText">Card text</label><textarea id="deckText" name="text" maxlength="240" required placeholder="The jester's next trick is _____."></textarea></div> <div class="two-actions"><button class="action action-secondary" type="submit">+ Add to Room Deck</button><span class="text-note">${ cards.length }/150 custom cards</span></div> </form> ${ cards.length ? `<div class="custom-deck-list">${cards .map( (c) => `<div class="deck-entry"><div><span class="eyebrow">${ c.kind === "prompt" ? "PROMPT" : "RESPONSE" }${ c.kind === "prompt" ? " · PICK " + c.picks : "" }</span><p>${html( c.text )}</p></div><button type="button" data-action="remove-card" data-card-id="${ c.id }" aria-label="Remove card">✕</button></div>` ) .join("")}</div>` : '<div class="hint-box">Your room is using the original starter deck. Add your own chaos here!</div>' } </section>`;
}
function lobbyView() {
  return `<section class="panel game-panel"> <div class="section-label">✦ THE WAITING ROOM</div> <div class="waiting-card" style="min-height:190px"><div class="waiting-icon">♛</div><h3>The Cast Assembles</h3> <p>Invite friends with the code above. Every new player will appear automatically.</p> <div class="badge">${ state.players.length } of at least 3 performers ready</div></div> </section> ${ state.room.is_host ? showHostSettings() + customDeckPanel() : `<section class="panel game-panel"><div class="waiting-card" style="min-height:125px"><div class="waiting-icon">✧</div><p>Waiting for the host to start the game. You will be moved to your cards automatically.</p></div></section>` }`;
}
function promptSection() {
  if (!state.prompt) return "";
  return `<section class="panel game-panel"> <div class="section-label">✦ THE PROMPT CARD</div> <div class="prompt-wrap"><div class="card prompt-card"><div class="card-mini">CARDS AGAINST ENCORE · PROMPT</div> <div class="card-title">${html( state.prompt.text )}</div><div class="card-small-note">✦ THE AZURE PARLOR ✦</div></div> <div class="prompt-info"><span class="badge">PICK ${ state.prompt.picks }</span> <strong>${ state.prompt.picks === 1 ? "One answer. Endless possibilities." : `${state.prompt.picks} answers to complete this catastrophe.` }</strong> <p>Choose the cards in the order you want them revealed. A custom-written answer counts as one selection.</p> </div></div> </section>`;
}
function waitPanel(icon, title, description) {
  return `<section class="panel game-panel"><div class="waiting-card"><div class="waiting-icon">${icon}</div><h3>${title}</h3><p>${description}</p></div></section>`;
}
function submitPanel() {
  const r = state.room;
  if (r.mode === "judge" && r.judge_member_id === state.me.id)
    return waitPanel(
      "♛",
      "You Hold the Crown",
      `The cast is composing their responses. ${state.submission_count} of ${state.submission_required} have submitted. You'll pick the winner when they're ready.`
    );
  if (state.has_submitted)
    return waitPanel(
      "✦",
      "Your Answer Is Sealed",
      `${state.submission_count} of ${state.submission_required} responses received. Wait for the judge or audience to see them.`
    );
  const picks = state.prompt?.picks || 1;
  return `<section class="panel game-panel"><div class="section-label">✧ YOUR PRIVATE HAND <span class="badge">${ state.hand.length } CARDS</span></div> <h2>Choose your response${picks > 1 ? "s" : ""}</h2> <p class="text-note">Select ${picks} card${ picks > 1 ? "s" : "" } in order. You may use a custom answer too.</p> <div class="answer-grid">${state.hand .map((card, i) => { const index = selected.indexOf("c:" + card.id); return `<button type="button" class="card answer-card ${ index >= 0 ? "selected" : "" }" data-action="select-card" data-card-id="${card.id}" aria-pressed="${ index >= 0 }" aria-label="Choose: ${html(card.text)}"> <span class="card-mini">ENCORE RESPONSE ${i + 1}</span> <span class="card-title">${html(card.text)}</span> <span class="choice-number">${ index >= 0 ? index + 1 : "✦" }</span></button>`; }) .join("")}</div> <div class="custom-box ${ selected.includes("custom") ? "custom-selected" : "" }"> <div class="custom-head"><strong>✎ Write Your Own Card</strong><span>ONE custom answer per round</span></div> <textarea id="customAnswer" maxlength
