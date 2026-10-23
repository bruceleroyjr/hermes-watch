// Actions the watch relay runs itself, only after a Yes tap: texts, car commands, PC restart.
// Recognised with plain patterns (like the relay's PC restart), never by the model, so a
// misheard phrase can at most show a confirm card. A card's id works once, for 60 s.
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { callMcpTool } = require('./mcp-call');
const { parsePcRestartCommand, restartPc } = require('./voice-common');

// Local stdio MCP servers that send texts and control the car (yours will differ).
const TEXT_MCP = process.env.WATCH_TEXT_MCP || path.join(os.homedir(), 'text-bridge', 'text-mcp-server.js');
const TESLA_MCP = process.env.WATCH_TESLA_MCP || path.join(os.homedir(), 'tesla-bridge', 'tesla-mcp-server.js');
const TEXT_TIMEOUT_MS = 60000; // send_text has its own restart + retry path
const TESLA_TIMEOUT_MS = 45000; // waking the car can take a while
const CONFIRM_TTL_MS = 60000; // instant actions (car, text): a stale Yes must not fire them
// A Hermes question only sends "yes, go ahead" into the chat, so it can wait while a long answer is
// read and spoken (60 s ran out: the clock starts before the card reaches the watch).
const HERMES_CARD_TTL_MS = 5 * 60 * 1000;
const ttlFor = (action) => (action && action.kind === 'hermes' ? HERMES_CARD_TTL_MS : CONFIRM_TTL_MS);

const LEAD = /^(?:(?:ok(?:ay)?|hey|hermes|please)[ ,]+)*/i;
const TEXT_START = /^(?:send (?:a )?text(?: message)? to|text|message) /i;
const TEXT_SEPARATOR = / (?:saying|that says|telling (?:her|him|them)|that) /i;
const SELF = new Set(['me', 'myself']);
// Whisper heard "restart my PC" as "Start my PC." Still only a card: nothing runs without Yes.
const START_PC = /^start (?:the |my )?(?:pc|computer)$/i;

const CAR = '(?:the|my) (?:car|tesla)';
const TESLA = [
  [new RegExp(`^unlock ${CAR}$`, 'i'), 'tesla_unlock', 'Unlock the car?'],
  [new RegExp(`^lock ${CAR}$`, 'i'), 'tesla_lock', 'Lock the car?'],
  [/^open (?:the|my) trunk$/i, 'tesla_open_trunk', 'Open the trunk?'],
  [/^open (?:the|my) frunk$/i, 'tesla_open_frunk', 'Open the frunk?'],
  [/^honk (?:the )?horn$/i, 'tesla_honk_horn', 'Honk the horn?'],
  [/^flash (?:the )?(?:head)?lights$/i, 'tesla_flash_lights', 'Flash the lights?'],
];

function normalizeContact(name) {
  const n = name.toLowerCase().replace(/^my /, '').trim();
  return SELF.has(n) ? 'me' : n;
}

function parseText(said) {
  const start = said.match(TEXT_START);
  if (!start) return null;
  const rest = said.slice(start[0].length);
  let contact;
  let message;
  const sep = rest.match(TEXT_SEPARATOR);
  if (sep) {
    contact = rest.slice(0, sep.index);
    message = rest.slice(sep.index + sep[0].length);
  } else {
    // "text Alex I'm running late": the contact is one name ("my sister" counts as one).
    const m = /^my /i.test(rest) ? rest.match(/^(my \S+) (.+)$/i) : rest.match(/^(\S+) (.+)$/);
    if (!m) return null;
    [, contact, message] = m;
  }
  contact = normalizeContact(contact);
  message = message.trim().replace(/\.$/, '');
  if (!contact || !message) return null;
  return { kind: 'text', contact, message, summary: `Text ${contact}: "${message}"?` };
}

function parseAction(text) {
  const said = String(text || '').trim().replace(LEAD, '').replace(/[.!]+$/, '').replace(/\s+/g, ' ');
  const pc = parsePcRestartCommand(said); // 'cancel' is handled by the relay without a card
  if (pc === 'request' || pc === 'confirm' || START_PC.test(said)) return { kind: 'pc', tool: 'restart', summary: 'Restart the PC? It restarts 60 seconds after Yes.' };
  for (const [pattern, tool, summary] of TESLA) {
    if (pattern.test(said)) return { kind: 'tesla', tool, summary };
  }
  return parseText(said);
}

const pending = new Map();

function createPending(action, now = Date.now()) {
  for (const [id, p] of pending) if (now - p.at > ttlFor(p.action)) pending.delete(id);
  const id = crypto.randomBytes(9).toString('base64url');
  pending.set(id, { action, at: now });
  return id;
}

function takePending(id, now = Date.now()) {
  const p = pending.get(id);
  pending.delete(id);
  if (!p || now - p.at > ttlFor(p.action)) return null;
  return p.action;
}

const TESLA_DONE = {
  tesla_unlock: 'Car unlocked.', tesla_lock: 'Car locked.', tesla_open_trunk: 'Trunk opened.',
  tesla_open_frunk: 'Frunk opened.', tesla_honk_horn: 'Horn honked.', tesla_flash_lights: 'Lights flashed.',
};

// The Tesla MCP answers {status, body: '{"response":{"result":bool,"reason":...}}'}; anything
// else (an error message) is shown as it came.
function teslaMessage(tool, text) {
  let res = null;
  try { res = JSON.parse(JSON.parse(text).body).response; } catch { /* below */ }
  if (res && res.result === true) return TESLA_DONE[tool] || 'Done.';
  if (res && res.result === false) return `The car didn't do it: ${res.reason || 'no reason given'}.`;
  return String(text).slice(0, 200);
}

async function runAction(action) {
  if (action.kind === 'text') {
    const r = await callMcpTool(TEXT_MCP, 'send_text', { contact: action.contact, message: action.message }, TEXT_TIMEOUT_MS);
    if (!r.ok) return { ok: false, message: r.text };
    let body = {};
    try { body = JSON.parse(JSON.parse(r.text).body); } catch { /* fall through */ }
    if (body.sent) return { ok: true, message: `Sent to ${action.contact}.` };
    return { ok: false, message: body.error || 'The text did not go out.' };
  }
  if (action.kind === 'tesla') {
    const r = await callMcpTool(TESLA_MCP, action.tool, {}, TESLA_TIMEOUT_MS);
    return { ok: r.ok, message: teslaMessage(action.tool, r.text) };
  }
  if (action.kind === 'pc') {
    // 60 s countdown (and the 10 min uptime guard) in voice-common, so this reply gets out first.
    try {
      return { ok: true, message: restartPc() };
    } catch (e) {
      return { ok: false, message: `PC restart failed: ${e.message}` };
    }
  }
  return { ok: false, message: 'Unknown action.' };
}

module.exports = { parseAction, createPending, takePending, runAction, teslaMessage, CONFIRM_TTL_MS, HERMES_CARD_TTL_MS };
