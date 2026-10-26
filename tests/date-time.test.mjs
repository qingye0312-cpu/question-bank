import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarDate, calendarDays, localDateTime, moveCalendarDate, moveCalendarMonth, parseCalendarDate} from '../src/date-time.ts';

test('calendar weeks start on Monday and include leap days and adjacent months', () => {
  const days = calendarDays('2024-02');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2024-01-29');
  assert.equal(days.at(-1), '2024-03-10');
  assert.equal(new Set(days).size, 42);
  assert.ok(days.includes('2024-02-29'));
  assert.equal(parseCalendarDate('2023-02-29'), null);
  assert.equal(parseCalendarDate('2026-13-01'), null);
  assert.equal(parseCalendarDate('2026-04-31'), null);
});

test('keyboard calendar navigation clamps end-of-month dates and crosses years', () => {
  assert.equal(moveCalendarMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(moveCalendarMonth('2024-02-29', 12), '2025-02-28');
  assert.equal(moveCalendarMonth('2026-01-31', -1), '2025-12-31');
  assert.equal(moveCalendarDate('2026-12-31', 1), '2027-01-01');
  assert.equal(moveCalendarDate('2026-01-02', -6), '2025-12-27');
});

test('export keeps local hours and includes the final minute across midnight', () => {
  const previousTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    const start = localDateTime('2026-10-26', '13:07');
    const end = localDateTime('2026-10-26', '23:59');
    assert.equal(start.toISOString(), '2026-10-26T05:07:00.000Z');
    assert.equal(new Date(end.getTime() + 60_000).toISOString(), '2026-10-26T16:00:00.000Z');
    assert.equal(calendarDate(start), '2026-10-26');
    for (const time of ['24:00', '13:60', '', '09:aa']) assert.equal(localDateTime('2026-10-26', time), null);
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(localDateTime('2026-03-08', '02:30'), null);
    assert.equal(localDateTime('2026-03-08', '03:30').getHours(), 3);
    assert.equal(moveCalendarDate('2026-03-08', 1), '2026-03-09');
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
