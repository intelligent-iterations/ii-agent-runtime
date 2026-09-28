import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, linkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { captureTartFiles, type executeTartGuest } from '../src/index.js';

// Execute the actual guest reader under Python; only the Tart transport is substituted.
const execute: typeof executeTartGuest = async (_manifest, command, input) => new Promise((resolve, reject) => {
  const child = execFile('python3', command.slice(3), { maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(Error('Guest read failed')) : resolve(stdout));
  child.stdin!.end(input);
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-capture-')));
  const guest = join(root, 'guest'); const destination = join(root, 'retained'); mkdirSync(guest); mkdirSync(destination);
  return { root, guest, destination, close() { rmSync(root, { recursive: true }); } };
}

test('retains multi-chunk binary bytes and manifest after the source is removed', async () => {
  const f = fixture();
  try {
    const bytes = Buffer.alloc(700_000); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    writeFileSync(join(f.guest, 'output.bin'), bytes);
    const files = await captureTartFiles('manifest', { root: f.guest, paths: ['output.bin'], destination: f.destination }, execute);
    rmSync(f.guest, { recursive: true });
    assert.deepEqual(readFileSync(files[0]!.localPath), bytes);
    assert.equal(files[0]!.sha256, createHash('sha256').update(bytes).digest('hex'));
    const manifest = readdirSync(f.destination).find(name => name.startsWith('capture-'))!;
    assert.deepEqual(JSON.parse(readFileSync(join(f.destination, manifest), 'utf8')).files, files);
  } finally { f.close(); }
});

test('symlinks, hard links, directory links, missing files and traversal cannot be captured', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'private'), 'private');
    symlinkSync(join(f.root, 'private'), join(f.guest, 'symlink'));
    linkSync(join(f.root, 'private'), join(f.guest, 'hardlink'));
    symlinkSync(f.root, join(f.guest, 'directory'));
    for (const path of ['symlink', 'hardlink', 'directory/private', 'missing', '../private', '/private', '.env', 'auth.json', '.ssh/id_rsa']) {
      await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: [path], destination: f.destination }, execute));
    }
    assert.deepEqual(readdirSync(f.destination), []);
  } finally { f.close(); }
});

test('aggregate limits reject oversized capture and never emit a complete manifest', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.guest, 'one'), '1234'); writeFileSync(join(f.guest, 'two'), '5678');
    await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: ['one', 'two'], destination: f.destination, maxBytes: 6 }, execute));
    assert.ok(!readdirSync(f.destination).some(name => name.startsWith('capture-')));
  } finally { f.close(); }
});

test('changed bytes fail hash verification and partial transfers are removed', async () => {
  const f = fixture(); let changed = false;
  try {
    writeFileSync(join(f.guest, 'output'), 'before');
    const mutating: typeof executeTartGuest = async (manifest, command, input) => {
      const request = JSON.parse(String(input));
      if (request.action === 'read' && !changed) { writeFileSync(join(f.guest, 'output'), 'change'); changed = true; }
      return execute(manifest, command, input);
    };
    await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: ['output'], destination: f.destination }, mutating), /changed|corrupted/);
    assert.deepEqual(readdirSync(f.destination), []);
  } finally { f.close(); }
});


test('optional paths record confirmed absence while preserving present files', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.guest, 'present'), 'retained');
    const files = await captureTartFiles('manifest', { root: f.guest, paths: ['present', 'missing/child'], optionalPaths: ['missing/child'], destination: f.destination }, execute);
    assert.equal(files.length, 1); assert.equal(readFileSync(files[0]!.localPath, 'utf8'), 'retained');
    const manifest = readdirSync(f.destination).find(name => name.startsWith('capture-'))!;
    assert.deepEqual(JSON.parse(readFileSync(join(f.destination, manifest), 'utf8')).missing, ['missing/child']);
    await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: ['missing'], optionalPaths: ['unrequested'], destination: f.destination }, execute), /Optional paths/);
  } finally { f.close(); }
});

test('optional capture never turns unsafe paths or transport failures into absence', async () => {
  const f = fixture();
  try {
    symlinkSync('/nonexistent-target', join(f.guest, 'link'));
    await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: ['link'], optionalPaths: ['link'], destination: f.destination }, execute));
    await assert.rejects(captureTartFiles('manifest', { root: f.guest, paths: ['missing'], optionalPaths: ['missing'], destination: f.destination }, async () => { throw Error('Transport unavailable'); }), /Transport unavailable/);
    assert.deepEqual(readdirSync(f.destination), []);
  } finally { f.close(); }
});
