// Run: node --test "test/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { formatPcHealth } = require('../lib/pc-health');

const sample = {
  cpuLoadPct: 34, memTotalGB: 15.9, memUsedGB: 10.3, memUsedPct: 65, uptime: '2d 3h 56m',
  disks: [{ drive: 'C:', freeGB: 147.6, freePct: 31 }, { drive: 'D:', freeGB: 229, freePct: 25 }],
  drives: [{ name: 'SanDisk', status: 'OK' }],
  topMemory: [{ name: 'claude', count: 14, memMB: 2610 }, { name: 'node', count: 23, memMB: 342 }],
  restartPending: false, unexpectedShutdowns30d: 0,
};

test('healthy PC', () => {
  assert.strictEqual(formatPcHealth(JSON.stringify(sample)),
    'Healthy\nCPU 34%, RAM 10.3 of 15.9 GB\nC: 148 GB free, D: 229 GB free\nUp 2d 3h\nMost memory: claude 2.6 GB');
});

test('problems are listed', () => {
  const h = { ...sample, unexpectedShutdowns30d: 1, lastUnexpectedShutdown: 'Sep 27, 9:00 PM',
    disks: [{ drive: 'C:', freeGB: 20, freePct: 4 }], restartPending: true };
  assert.strictEqual(formatPcHealth(JSON.stringify(h)),
    'Needs attention\nCPU 34%, RAM 10.3 of 15.9 GB\nC: 20 GB free\nUp 2d 3h\nMost memory: claude 2.6 GB\n'
    + 'C: has only 20 GB free; a restart is pending; 1 unexpected shutdown in 30 days, last Sep 27, 9:00 PM');
});

test('busy PC', () => {
  assert.match(formatPcHealth(JSON.stringify({ ...sample, cpuLoadPct: 95 })), /^Busy\n/);
});

test('errors and empty output -> null', () => {
  assert.strictEqual(formatPcHealth('Error gathering PC health: timed out'), null);
  assert.strictEqual(formatPcHealth('{}'), null);
});
