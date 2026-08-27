// Render-Smoke for the FileView body (2026-08-27).
// Run: cd web && npx tsx src/components/fileview-render.test.mts
//
// No browser: renderToString runs no effects, so this covers what a
// type-check cannot — that each file kind picks the element it should,
// and that a media kind never falls through to the text renderer (which
// would print raw bytes into the window).

import React from 'react';
import { renderToString } from 'react-dom/server';
import { Body, type FileViewResponse } from './FileViewWindow';

let ok = 0;
let bad = 0;
const t = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { ok++; console.log('  ok  ', name); }
  else { bad++; console.error('  FAIL', name, detail); }
};

const base = { path: '/w/x', ext: '', bytes: 10, truncated: false };
const render = (d: Partial<FileViewResponse>): string =>
  renderToString(React.createElement(Body, { data: { ...base, ...d } as FileViewResponse }));

const img = render({ kind: 'image', mime: 'image/png', url: '/files/raw?path=x', ext: '.png' });
t('image renders an <img>', img.includes('<img'), img.slice(0, 120));
t('image points at the byte route', img.includes('/files/raw'));

const vid = render({ kind: 'video', mime: 'video/mp4', url: '/files/raw?path=v', ext: '.mp4' });
t('video renders a <video>', vid.includes('<video'));
t('video has controls', vid.includes('controls'));
t('video preloads metadata only', vid.includes('preload="metadata"'), vid.slice(0, 160));

const aud = render({ kind: 'audio', mime: 'audio/wav', url: '/files/raw?path=a', ext: '.wav' });
t('audio renders an <audio>', aud.includes('<audio'));

const pdf = render({ kind: 'pdf', mime: 'application/pdf', url: '/files/raw?path=p', ext: '.pdf' });
t('pdf renders an <iframe>', pdf.includes('<iframe'));

const bin = render({ kind: 'binary', mime: 'application/octet-stream', downloadUrl: '/files/raw?download=1' });
t('binary explains itself', bin.includes('No preview'));
t('binary offers the download', bin.includes('download'));
t('binary names the type', bin.includes('application/octet-stream'));

const txt = render({ kind: 'text', content: 'hello log line', ext: '.log' });
t('text still renders its content', txt.includes('hello log line'));

const md = render({ kind: 'markdown', content: '# Titel', ext: '.md' });
t('markdown still renders', md.length > 0);

// A media kind whose url never arrived must not fall through to the
// text renderer — there is no content to print.
const broken = render({ kind: 'image', mime: 'image/png' });
t('media without a url degrades to the no-preview panel', broken.includes('No preview'), broken.slice(0, 120));

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
if (bad > 0) process.exit(1);
