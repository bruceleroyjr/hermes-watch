// Run: node --test "test/*.test.js"
// lib/pc-health.sh is plain bash (no JS twin), so on a Mac this runs the real script and checks the
// JSON it prints; elsewhere the test is skipped so Linux / Windows runners stay green.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { formatPcHealth } = require('../lib/pc-health');

const onMac = process.platform === 'darwin';

test('pc-health.sh prints one JSON object with the fields formatPcHealth needs', { skip: !onMac && 'macOS only' }, () => {
  const out = execFileSync('/bin/bash', [path.join(__dirname, '..', 'lib', 'pc-health.sh')], { encoding: 'utf8', timeout: 20000 });
  const health = JSON.parse(out.trim());
  assert.strictEqual(typeof health.cpuLoadPct, 'number');
  assert.ok(health.cpuLoadPct >= 0 && health.cpuLoadPct <= 100, `cpuLoadPct ${health.cpuLoadPct}`);
  assert.ok(health.memTotalGB > 0, `memTotalGB ${health.memTotalGB}`);
  assert.ok(health.memUsedGB > 0 && health.memUsedGB <= health.memTotalGB, `memUsedGB ${health.memUsedGB}`);
  assert.ok(health.memUsedPct >= 0 && health.memUsedPct <= 100, `memUsedPct ${health.memUsedPct}`);
  assert.match(health.uptime, /^\d+d \d+h \d+m$/);
  assert.ok(Array.isArray(health.disks) && health.disks.length >= 1, 'at least the startup disk');
  for (const d of health.disks) {
    assert.strictEqual(typeof d.drive, 'string');
    assert.ok(d.freeGB >= 0 && d.freePct >= 0 && d.freePct <= 100, JSON.stringify(d));
  }
  assert.ok(Array.isArray(health.topMemory) && health.topMemory.length >= 1 && health.topMemory.length <= 5);
  assert.ok(health.topMemory[0].memMB >= health.topMemory[health.topMemory.length - 1].memMB, 'sorted by memory');
  // No sudo-only data is faked on macOS.
  assert.ok(!('drives' in health) && !('unexpectedShutdowns30d' in health) && !('lastUnexpectedShutdown' in health));
  // And the Windows formatter reads it as is.
  assert.match(formatPcHealth(out), /^(Healthy|Busy|Needs attention)\nCPU \d+%, RAM /);
});
