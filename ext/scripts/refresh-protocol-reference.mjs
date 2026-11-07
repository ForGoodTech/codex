#!/usr/bin/env node
// Node 24+: the CLI exports unpack this same upstream precomputed bundle.
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';

const ext = fileURLToPath(new URL('../', import.meta.url));
const metadataPath = path.join(ext, 'app-server-protocol-export.version.json');
const previous = JSON.parse(await readFile(metadataPath, 'utf8'));
const args = process.argv.slice(2);
const release = args.find(arg => !arg.startsWith('--')) || previous.release;
if (!/^rust-v\d+\.\d+\.\d+$/.test(release) || args.some(arg => arg.startsWith('--') && arg !== '--check')) {
  throw Error('Usage: refresh-protocol-reference.mjs [rust-vX.Y.Z] [--check]');
}
const sourcePath = 'codex-rs/app-server-protocol/schema/precomputed/app-server-exports-experimental.json.zst';
const response = await fetch(`https://raw.githubusercontent.com/openai/codex/${release}/${sourcePath}`);
if (!response.ok) throw Error(`Protocol download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = createHash('sha256').update(bytes).digest('hex');
if (release === previous.release && sha256 !== previous.sha256) throw Error('The release bundle no longer matches its recorded SHA-256');
const bundle = JSON.parse(zstdDecompressSync(bytes));
const files = {...bundle.typescript, ...bundle.json_schema};
const output = path.join(ext, 'app-server-protocol-export');
for (const [key, value] of Object.entries(files)) {
  if (path.isAbsolute(key) || key.split('/').includes('..') || typeof value !== 'string') throw Error('Invalid export entry');
}
const metadata = {
  release, upstreamRepository:'https://github.com/openai/codex', sourcePath,
  gitBlobSha:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  sha256, experimental:true, typescriptFiles:Object.keys(bundle.typescript).length,
  jsonSchemaFiles:Object.keys(bundle.json_schema).length,
};
if (args.includes('--check')) {
  const entries = await readdir(output, {recursive:true, withFileTypes:true});
  const actual = entries.filter(entry => entry.isFile()).map(entry => path.relative(output, path.join(entry.parentPath, entry.name)));
  const unexpected = actual.filter(key => !(key in files));
  if (unexpected.length) throw Error('Unexpected export files: ' + unexpected.join(', '));
  for (const [key, expected] of Object.entries(files)) {
    if (await readFile(path.join(output, key), 'utf8') !== expected) throw Error('Export differs: ' + key);
  }
  if (JSON.stringify(previous) !== JSON.stringify(metadata)) throw Error('Export provenance differs');
  console.log(`Verified ${Object.keys(files).length} files against ${release}`);
} else {
  const staging = await mkdtemp(path.join(ext, '.protocol-reference-'));
  const backup = staging + '-previous';
  const metadataTemp = staging + '.json';
  let backedUp = false;
  try {
    for (const [key, value] of Object.entries(files)) {
      const file = path.join(staging, key);
      await mkdir(path.dirname(file), {recursive:true});
      await writeFile(file, value);
    }
    await writeFile(metadataTemp, JSON.stringify(metadata, null, 2) + '\n');
    await rename(output, backup);
    backedUp = true;
    try {
      await rename(staging, output);
      await rename(metadataTemp, metadataPath);
    } catch (error) {
      await rm(output, {recursive:true, force:true});
      await rename(backup, output);
      backedUp = false;
      throw error;
    }
    console.log(`Exported ${Object.keys(files).length} files for ${release}`);
  } finally {
    await rm(staging, {recursive:true, force:true});
    await rm(metadataTemp, {force:true});
    if (backedUp) await rm(backup, {recursive:true, force:true});
  }
}
