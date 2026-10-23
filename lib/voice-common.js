// Small helpers the relay shares with its prompt and actions: clock strings, the voice
// shortcuts it answers itself (new session, PC restart, PC health) and answer formatting.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

// "Mon, Oct 5, 2026, 9:41 AM EST" for any IANA time zone, so the model never converts zones itself.
function timeString(timeZone, label, now = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);
  return label ? `${formatted} ${label}` : formatted;
}

// Speech-to-text adds stray punctuation/filler; normalize before matching.
function isResetCommand(text) {
  const normalized = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.includes('start new session') || normalized.includes('start a new session');
}

// PC restart by voice is handled in plain code, never by the model.
// Returns 'request' | 'confirm' | 'cancel' | null.
const PC_RESTART_MIN_UPTIME_S = 10 * 60; // no reboot loops right after a boot
function parsePcRestartCommand(text) {
  const n = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(cancel|abort|stop)\b.*\b(restart|reboot)\b/.test(n)) return 'cancel';
  if (/\bconfirm (the )?(pc )?(restart|reboot)\b/.test(n)) return 'confirm';
  if (/\b(restart|reboot)\b.*\b(pc|computer|desktop)\b/.test(n)) return 'request';
  return null;
}

function restartPc() {
  const uptime = os.uptime();
  if (uptime < PC_RESTART_MIN_UPTIME_S) {
    return `Not restarting: the PC only booted ${Math.round(uptime / 60)} min ago. Try again in a few minutes.`;
  }
  execFileSync('shutdown.exe', ['/r', '/t', '60', '/d', 'p:0:0', '/c', 'Restart requested from the watch'], { windowsHide: true });
  return 'Restarting the PC in 60 seconds. Say "cancel restart" to stop it.';
}

function cancelPcRestart() {
  try {
    execFileSync('shutdown.exe', ['/a'], { windowsHide: true, stdio: 'ignore' });
    return 'PC restart cancelled.';
  } catch {
    return 'No PC restart was pending.';
  }
}

// Optional saved facts (a markdown file of "- " bullets) added to every prompt.
function savedMemoryContext(file, note) {
  if (!file) return '';
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- '));
  } catch {
    return '';
  }
  if (!lines.length) return '';
  const picked = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0 && size < 3000; i--) {
    picked.unshift(lines[i]);
    size += lines[i].length;
  }
  return `\n\n[Saved memory - ${note}]:\n${picked.join('\n')}`;
}

// "how's my PC doing", "PC health", "disk space", "is my computer running slow", ...
function isPcHealthRequest(text) {
  const n = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(pc|computer|desktop|system|machine) (health|performance|stats)\b|\bhealth of (the |my )?(pc|computer|desktop|machine)\b|\bhow healthy is (the |my )?(pc|computer|desktop|machine)\b|\bhow( i)? ?s my (pc|computer|desktop|machine)( doing| running)?\b|\b(cpu|ram|memory) (usage|load)\b|\bdisk space\b|\buptime\b|\b(pc|computer) (is )?(running )?slow\b|\bhealth check\b/.test(n);
}

// CPU/RAM/disk/uptime snapshot from pc-health.ps1 without blocking the event loop. Never rejects.
const PC_HEALTH_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'pc-health.ps1')];
function gatherPcHealthAsync(timeout = 12000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', PC_HEALTH_ARGS, { timeout, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      if (err) return resolve(`Error gathering PC health: ${err.message}`);
      resolve(String(stdout).trim() || '{}');
    });
  });
}

// The model sometimes still answers with markdown: normalize list markers to "• ", drop
// emphasis/headers and blank lines so the answer reads well on a small screen.
function formatForHud(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+•·]|\d+[.)])\s+/, '• ')
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
    .trim();
}

// Cut at the last line break or space instead of mid-word.
function truncateForHud(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastBreak = cut.lastIndexOf('\n');
  if (lastBreak > limit * 0.5) return cut.slice(0, lastBreak).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

module.exports = {
  timeString, isResetCommand, parsePcRestartCommand, restartPc, cancelPcRestart, savedMemoryContext,
  isPcHealthRequest, gatherPcHealthAsync, formatForHud, truncateForHud,
};
