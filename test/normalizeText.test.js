import test from 'node:test';
import assert from 'node:assert';
import { normalizeText } from '../normalizeText.js';

test('normalizeText removes punctuation and trims spaces', () => {
  const result = normalizeText('  Hello，World！  ');
  assert.strictEqual(result, 'helloworld');
});
