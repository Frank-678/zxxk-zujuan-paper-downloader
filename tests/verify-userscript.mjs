import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const source = await readFile(new URL('scripts/zxxk-zujuan-export.user.js', root), 'utf8');
const fixture = await readFile(new URL('tests/fixtures/lazy-answer-page.html', root), 'utf8');

assert.match(source, /@version\s+3\.1\.0/);
assert.match(source, /async function preloadAllAnswers/);
assert.match(source, /function waitForAnswerReady/);
assert.match(source, /new MutationObserver/);
assert.match(source, /function hydrateLazyImages/);
assert.match(source, /function renderAnswerBlock/);
assert.match(source, /function downloadLastDiagnostics/);
assert.match(source, /class TaskCancelledError/);
assert.match(source, /function fetchBlobForTask/);
assert.doesNotMatch(source, /^\/\/\s*@require\b/m, 'the distributed script must remain self-contained');

for (const preservedV22Capability of [
  'zipCreate',
  'zipFinalize',
  'buildAndDownloadSingleHTML',
  'buildAndDownloadZip',
  'exportAnswersAsHTML',
  'exportAnswersAsZip',
  'gmFetchBlob',
  'browserFetchBlob',
  'embedResourcesForNode',
]) {
  assert.match(source, new RegExp(`(?:async )?function ${preservedV22Capability}\\b`));
}

assert.match(fixture, /lazy-text-2/);
assert.match(fixture, /lazy-image-3/);
assert.match(fixture, /data-src=/);
assert.match(fixture, /zxxk-zujuan-export\.user\.js/);

console.log('Static userscript regression checks passed.');
