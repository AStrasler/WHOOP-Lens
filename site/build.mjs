// Builds the www.whooplens.tech static site from docs/ into site/dist.
// Copies only the public pages and their assets, strips the GitHub Pages
// "/WHOOP-Lens/" path prefix, and leaves the docs/ sources unchanged.
import {mkdir, readFile, rm, writeFile, copyFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '..', 'docs');
export const OUT = join(here, 'dist');
export const PAGES = ['index.html', 'privacy/index.html', 'terms/index.html', 'support/index.html', 'refresh/index.html', 'oauth/consent/index.html', 'connect/index.html'];
const ASSETS = ['style.css', 'logo.jpg', 'connect.css'];
export const STATIC = ['_headers', '404.html', '.well-known/assetlinks.json', 'android/oauth/callback.html'];
const WWW = 'https://www.whooplens.tech';

export function transform(html) {
  return html
    .replaceAll('https://astrasler.github.io/WHOOP-Lens/', WWW + '/')
    .replaceAll('"/WHOOP-Lens/', '"/');
}

export async function build() {
  await rm(OUT, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  for (const page of PAGES) {
    const target = join(OUT, page);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, transform(await readFile(join(docs, page), 'utf8')));
  }
  for (const asset of ASSETS) await copyFile(join(docs, asset), join(OUT, asset));
  for (const file of STATIC) {
    await mkdir(dirname(join(OUT, file)), {recursive: true});
    await copyFile(join(here, file), join(OUT, file));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
