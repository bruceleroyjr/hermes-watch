// PC health check on the watch, answered by the relay itself from pc-health.ps1 (the same
// snapshot and thresholds), so it never waits on Hermes.

// Raw pc-health.ps1 output -> screen text, or null when it wasn't gathered.
function formatPcHealth(raw) {
  let h;
  try { h = JSON.parse(raw); } catch { return null; }
  if (!h || h.cpuLoadPct == null || !h.memTotalGB) return null;
  const disks = [].concat(h.disks || []);
  const upDays = parseInt(h.uptime, 10) || 0;
  const problems = [];
  for (const d of disks) if (d.freePct < 10) problems.push(`${d.drive} has only ${Math.round(d.freeGB)} GB free`);
  for (const d of [].concat(h.drives || [])) if (d.status && d.status !== 'OK') problems.push(`${d.name} reports ${d.status}`);
  if (h.restartPending) problems.push('a restart is pending');
  if (h.unexpectedShutdowns30d > 0) {
    problems.push(`${h.unexpectedShutdowns30d} unexpected shutdown${h.unexpectedShutdowns30d === 1 ? '' : 's'} in 30 days, last ${h.lastUnexpectedShutdown}`);
  }
  if (upDays > 7) problems.push(`up ${upDays} days, a restart would help`);
  const busy = h.cpuLoadPct > 80 || h.memUsedPct > 85;
  const lines = [problems.length ? 'Needs attention' : busy ? 'Busy' : 'Healthy',
    `CPU ${h.cpuLoadPct}%, RAM ${h.memUsedGB} of ${h.memTotalGB} GB`];
  if (disks.length) lines.push(disks.map(d => `${d.drive} ${Math.round(d.freeGB)} GB free`).join(', '));
  lines.push(`Up ${String(h.uptime).replace(/ \d+m$/, '')}`);
  const top = [].concat(h.topMemory || [])[0];
  if (top) lines.push(`Most memory: ${top.name} ${(top.memMB / 1000).toFixed(1)} GB`);
  if (problems.length) lines.push(problems.join('; '));
  return lines.join('\n');
}

module.exports = { formatPcHealth };
