import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalImage, type LocalImageDrivers } from '../src/local-image.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-local-image-')));
  const recipe = join(root, 'recipe'); mkdirSync(recipe);
  for (const file of ['versions.json', 'build.sh', 'provision.sh', 'seal.sh']) writeFileSync(join(recipe, file), file);
  const manifest = Buffer.from('{"schemaVersion":2,"fixture":true}');
  const digest = 'sha256:' + createHash('sha256').update(manifest).digest('hex');
  let published = false; let builds = 0; let stops = 0; let failBuild = false; let corrupt = false;
  const drivers: LocalImageDrivers = {
    async installBinary() { return 'fixture'; },
    async startRegistry(_binary, _directory, port) {
      const server = createServer((_request, response) => {
        response.writeHead(published ? 200 : 404, { 'docker-content-digest': digest });
        response.end(corrupt ? 'changed' : manifest);
      });
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
      return async () => { stops++; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
    },
    async build(_recipe, _state, destination) {
      builds++; assert.match(destination, /^127\.0\.0\.1:[0-9]+\/factory\/worker:recipe-[a-f0-9]{64}$/);
      if (failBuild) throw Error('Build interrupted'); published = true;
    },
  };
  const open = (prepare = true) => openLocalImage(root, { prepare, recipeDirectory: recipe, drivers });
  return { root, recipe, open, stats: () => ({ builds, stops }), fail: () => { failBuild = true; }, recover: () => { failBuild = false; },
    corrupt: () => { corrupt = true; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('first setup builds and pins an image; reruns and launch reuse it without rebuilding', async () => {
  const f = fixture();
  try {
    const first = (await f.open())!; assert.match(first.image, /@sha256:[a-f0-9]{64}$/); const image = first.image;
    await assert.rejects(f.open(), /controller may still be alive/);
    await first.close(); await first.close();
    for (const prepare of [true, false]) { const next = (await f.open(prepare))!; assert.equal(next.image, image); await next.close(); }
    assert.deepEqual(f.stats(), { builds: 1, stops: 3 });
  } finally { f.dispose(); }
});

test('failed builds stop the store, release ownership and can be retried', async () => {
  const f = fixture();
  try {
    f.fail(); await assert.rejects(f.open(), /Build interrupted/);
    await assert.rejects(f.open(false), /finish preparing/);
    f.recover(); const prepared = (await f.open())!; await prepared.close();
    assert.deepEqual(f.stats(), { builds: 2, stops: 2 });
  } finally { f.dispose(); }
});

test('changed recipes require explicit new installations, and corrupt images fail closed', async () => {
  const f = fixture();
  try {
    await (await f.open())!.close();
    const path = join(f.recipe, 'provision.sh'), original = readFileSync(path, 'utf8');
    writeFileSync(path, original + ' changed'); await assert.rejects(f.open(), /recipe changed/);
    writeFileSync(path, original); f.corrupt(); await assert.rejects(f.open(false), /missing or changed/);
    assert.equal(f.stats().builds, 1);
  } finally { f.dispose(); }
});

test('existing external-image installations do not acquire a local image store', async () => {
  const f = fixture();
  try { assert.equal(await f.open(false), undefined); assert.deepEqual(f.stats(), { builds: 0, stops: 0 }); }
  finally { f.dispose(); }
});
