#!/usr/bin/env node
// src/camfit-panel.js 를 북마클릿으로 만들어 camfit.html 안에 주입합니다.
//
//   node build.js          빌드
//   node build.js --check  현재 camfit.html 이 소스와 일치하는지만 확인 (수정하지 않음)
//
// camfit.html 의 <a class="bm" href="javascript:..."> 한 곳만 교체합니다.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src', 'camfit-panel.js');
const OUT = path.join(ROOT, 'camfit.html');
const MARKER = /(<a class="bm" href="javascript:)(.*?)(")/s;

// 주석과 들여쓰기를 걷어냅니다. 북마클릿은 URL 한 줄로 들어가므로
// 남은 공백이 그대로 용량이 됩니다. 문자열 리터럴을 건드리면 안 되니
// 토큰 단위로 훑으면서 문자열·정규식 바깥에서만 지웁니다.
function strip(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // 문자열 리터럴은 통째로 옮깁니다.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // 줄 주석
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // 블록 주석
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    out += c;
    i++;
  }

  // 줄별로 앞뒤 공백을 없애고 빈 줄을 버립니다.
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function build() {
  if (!fs.existsSync(SRC)) {
    console.error(`✗ 소스가 없습니다: ${path.relative(ROOT, SRC)}`);
    process.exit(1);
  }

  const code = strip(fs.readFileSync(SRC, 'utf8'));

  // encodeURIComponent 와 같은 규칙으로 인코딩합니다.
  const encoded = encodeURIComponent(code);

  const html = fs.readFileSync(OUT, 'utf8');
  if (!MARKER.test(html)) {
    console.error('✗ camfit.html 에서 북마클릿 링크를 찾지 못했습니다.');
    process.exit(1);
  }

  const updated = html.replace(MARKER, (_, a, old, b) => {
    if (process.env.__CHECK && old !== encoded) process.exitCode = 2;
    return a + encoded + b;
  });

  return { code, encoded, html, updated };
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  process.env.__CHECK = '1';
  const { html, updated } = build();
  if (html === updated) {
    console.log('✓ camfit.html 이 소스와 일치합니다.');
  } else {
    console.error('✗ camfit.html 이 소스보다 낡았습니다. `node build.js` 를 실행하세요.');
    process.exit(1);
  }
} else {
  const { code, encoded, html, updated } = build();

  // 빌드 결과가 실제로 실행 가능한지 확인합니다.
  try {
    new Function(code);
  } catch (e) {
    console.error('✗ 빌드 결과에 문법 오류가 있습니다:', e.message);
    process.exit(1);
  }

  if (html === updated) {
    console.log('· 변경 없음 (이미 최신)');
  } else {
    fs.writeFileSync(OUT, updated);
    console.log('✓ camfit.html 갱신');
  }
  const kb = n => (n / 1024).toFixed(1) + 'KB';
  console.log(`  소스 ${kb(fs.statSync(SRC).size)} → 압축 ${kb(code.length)} → 인코딩 ${kb(encoded.length)}`);
}
