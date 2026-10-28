import test from 'node:test';
import assert from 'node:assert/strict';
import {rowOffsets, rowAtOffset, revealRow} from '../desktop/src/variable-rows.ts';

test('mixed short and long questions occupy their measured heights without gaps', () => {
  const offsets = rowOffsets([82.5, 151, 940, 99]);
  assert.deepEqual(offsets, [0, 82.5, 233.5, 1173.5, 1272.5]);
  for (const [position, index] of [[0, 0], [82.49, 0], [82.5, 1], [500, 2], [1173.5, 3], [1272.5, 3]]) {
    assert.equal(rowAtOffset(offsets, position), index);
  }
  assert.equal(rowAtOffset([0], 0), 0);
});

test('keyboard navigation reveals a normal row and starts an oversized question at its beginning', () => {
  assert.equal(revealRow(100, 220, 0, 400), 0);
  assert.equal(revealRow(100, 220, 150, 400), 100);
  assert.equal(revealRow(900, 1020, 500, 400), 620);
  assert.equal(revealRow(900, 1840, 500, 400), 900);
});
