// 캠핏 예약 도우미 패널 — 캠핏 사이트 안에서 실행됩니다.
(function () {
  if (document.getElementById('cfPanel')) {
    document.getElementById('cfPanel').remove();
    return;
  }

  var API = 'https://api.camfit.co.kr/v1';
  var TOKEN = window.localStorage.jwt;
  var state = { camp: null, zone: null, sites: [], picked: [] };
  var clockOffset = 0;      // 서버시각 - 로컬시각 (ms)
  var clockErr = null;      // 보정 오차 (± ms). null 이면 아직 못 맞춤
  var clockTimer = 0, syncTimer = 0;
  var running = false;      // 예약 시도 진행 중 여부

  function serverNow() { return new Date(Date.now() + clockOffset); }

  // ── 서버 시계 보정 ──
  // 캠핏 페이지와 같은 도메인에 HEAD 요청을 보내 응답의 Date 헤더를 읽습니다.
  // (api.camfit.co.kr 은 다른 도메인이라 브라우저가 Date 헤더를 스크립트에 보여 주지 않습니다.)
  //
  // Date 헤더는 초 단위(아래는 버림)라 한 번 재면 오차가 최대 1초입니다. 대신 범위로 다룹니다.
  // 서버가 헤더를 찍은 순간의 서버 시각은 [D, D+1000), 그 순간의 PC 시각은 [보낸 때, 받은 때] 이므로
  //   오프셋(서버-PC) ∈ [D - 받은 때, D + 1000 - 보낸 때]
  // 여러 번 잰 범위를 겹치면 가능한 범위가 점점 좁아집니다. 가운데 값을 씁니다.
  // PC 시계는 서버와 조금씩 다른 빠르기로 흘러가므로(보통 100만분의 수십), 오래된 측정일수록
  // 흘렀을 만큼 범위를 넓혀서 겹칩니다 — 10분 지난 측정은 앞뒤로 ±30ms 씩 넓어집니다.
  // 30분이 지난 측정은 버립니다.
  var samples = [];         // { lo, hi, at }
  var SAMPLE_KEEP = 30 * 60000;
  var DRIFT = 50e-6;        // 1ms 당 넓힐 양 (100만분의 50)
  var syncing = false;

  function syncClock() {
    if (syncing) return Promise.resolve(clockOffset);
    syncing = true;
    var t0 = Date.now();
    return fetch(location.origin + '/', { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      var t1 = Date.now(), hd = r.headers.get('Date');
      if (!hd) throw new Error('Date 헤더 없음');
      var D = new Date(hd).getTime();
      samples.push({ lo: D - t1, hi: D + 1000 - t0, at: t1 });
      samples = samples.filter(function (x) { return t1 - x.at <= SAMPLE_KEEP; });

      // 범위를 겹칩니다. 겹치는 곳이 없으면(PC 시계가 바뀌었거나 튄 값) 오래된 것부터 버립니다.
      var lo, hi;
      while (true) {
        lo = -Infinity; hi = Infinity;
        samples.forEach(function (x) {
          var widen = (t1 - x.at) * DRIFT;
          lo = Math.max(lo, x.lo - widen);
          hi = Math.min(hi, x.hi + widen);
        });
        if (lo <= hi || samples.length <= 1) break;
        samples.shift();
      }
      clockOffset = (lo + hi) / 2;
      clockErr = (hi - lo) / 2;
      return clockOffset;
    }).then(function (off) { syncing = false; return off; },
      function (e) { syncing = false; throw e; });
  }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === 'style') el.style.cssText = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) {
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Type': 'application/json'
    }, opts.headers || {});
    return fetch(API + path, opts).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.message || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  // ── 패널 골격 ──
  var css = ''
    + '#cfPanel{position:fixed;top:0;right:0;width:400px;height:100vh;z-index:2147483647;'
    + 'background:#16181c;color:#e8e8ea;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;'
    + 'box-shadow:-4px 0 24px rgba(0,0,0,.4);display:flex;flex-direction:column}'
    + '#cfPanel *{box-sizing:border-box}'
    + '#cfHead{padding:12px 16px;border-bottom:1px solid #2a2d33}'
    + '#cfTitle{display:flex;align-items:center;gap:8px}'
    + '#cfTitle b{font-size:15px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#cfStatus{display:flex;align-items:center;gap:6px;margin-top:8px}'
    // 카운트다운이 숨어도 시계가 왼쪽으로 튀지 않도록 남는 폭을 밀어냅니다.
    + '#cfStatus .sp{flex:1}'
    + '#cfClock,#cfCount{font:12px/1 ui-monospace,monospace;padding:5px 9px;'
    + 'background:#1f2229;border-radius:5px;letter-spacing:.5px;white-space:nowrap;'
    + 'display:flex;align-items:baseline;gap:6px}'
    + '#cfClock{color:#4ade80}'
    + '#cfClock.off{color:#8a8f98}'
    + '#cfCount{color:#fbbf24;flex:1;justify-content:center}'
    + '#cfCount.soon{color:#4ade80;background:#14301f}'
    // 라벨은 값보다 한 단계 죽여서, 값이 먼저 읽히게 합니다.
    + '#cfStatus .k{font:11px/1 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;color:#8a8f98;letter-spacing:0}'
    + '#cfCount .k{color:inherit;opacity:.75}'
    + '#cfBody{flex:1;overflow-y:auto;padding:16px}'
    + '.cfStep{border:1px solid #2a2d33;border-radius:10px;padding:14px;margin-bottom:12px}'
    + '.cfStep h3{margin:0 0 4px;font-size:13px;color:#4ade80}'
    + '.cfStep p{margin:0 0 10px;font-size:12px;color:#8a8f98}'
    + '.cfStep.done{border-color:#2d7d46}'
    + '#cfPanel input,#cfPanel select{width:100%;padding:8px 10px;font-size:13px;border:1px solid #3a3d44;'
    + 'border-radius:6px;background:#1f2229;color:#e8e8ea;margin-bottom:8px}'
    + '#cfPanel button{background:#2d7d46;color:#fff;border:0;border-radius:6px;padding:8px 16px;'
    + 'font-size:13px;font-weight:600;cursor:pointer}'
    + '#cfPanel button:hover{background:#26683a}'
    + '#cfPanel button.sub{background:#2a2d33;color:#c8ccd4;padding:6px 12px;font-size:12px}'
    + '#cfPanel button.sub:hover{background:#353941}'
    + '.cfRow{display:flex;gap:8px}.cfRow>*{flex:1}'
    + '.cfList{max-height:200px;overflow-y:auto;margin-top:8px}'
    + '.cfItem{padding:8px 10px;border:1px solid #2a2d33;border-radius:6px;margin-bottom:6px;cursor:pointer}'
    + '.cfItem:hover{border-color:#2d7d46}'
    + '.cfItem.on{background:#1e3a28;border-color:#2d7d46}'
    + '.cfItem .nm{font-weight:600}'
    + '.cfItem .sub{font-size:11px;color:#8a8f98}'
    + '.cfItem .nm{display:flex;align-items:baseline;gap:8px}.cfItem .nm span{flex:1;min-width:0}'
    + '.cfLink{font-size:11px;font-weight:500;color:#4ade80;text-decoration:none;white-space:nowrap}'
    + '.cfLink:hover{text-decoration:underline}'
    + '.cfChips{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:5px;margin-top:8px}'
    + '.cfChip{position:relative;padding:7px 3px;border:1px solid #3a3d44;border-radius:6px;'
    + 'text-align:center;font-size:11px;cursor:pointer;user-select:none}'
    // 글자 줄임은 안쪽 글자에만 겁니다. 칩에 걸면 모서리 밖으로 나온 배지가 잘립니다.
    + '.cfChip .tx{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.cfChip:hover{border-color:#2d7d46}'
    + '.cfChip.sel{background:#2d7d46;border-color:#2d7d46;color:#fff}'
    + '.cfChip.blk{opacity:.45}'
    + '.cfChip.blk:not(.sel){border-style:dashed}'
    + '.cfChip .rk{position:absolute;top:-5px;right:-5px;background:#c23b22;color:#fff;'
    + 'font-size:9px;min-width:15px;height:15px;line-height:15px;border-radius:8px;padding:0 4px;'
    + 'white-space:nowrap;z-index:1;box-shadow:0 0 0 2px #16181c}'
    + '.cfChip .rk.rec{background:#fbbf24;color:#16181c;font-weight:700}'
    + '.cfMsg{font-size:12px;padding:8px 10px;border-radius:6px;margin-top:8px}'
    + '.cfMsg.err{background:#3a1f1f;color:#ff8f8f}'
    + '.cfMsg.ok{background:#1e3a28;color:#7ee0a0}'
    + '#cfOut{width:100%;height:70px;font:10px/1.4 ui-monospace,monospace;'
    + 'background:#1f2229;color:#c8ccd4;border:1px solid #3a3d44;border-radius:6px;padding:8px;margin-top:8px}'
    + '#cfLog{max-height:180px;overflow-y:auto;margin-top:10px;padding:8px;background:#1f2229;'
    + 'border:1px solid #2a2d33;border-radius:6px;font:11px/1.6 ui-monospace,monospace}'
    + '.cfLine{color:#c8ccd4;padding:1px 0}'
    + '.cfLine.ok{color:#7ee0a0}.cfLine.err{color:#ff8f8f}'
    + '.cfLine .ts{color:#6b7280;margin-right:7px}';

  var style = h('style', {}, [css]);
  document.head.appendChild(style);

  var body = h('div', { id: 'cfBody' });
  var clockTime = h('span', { class: 'v' }, ['--:--:--']);
  var clock = h('div', { id: 'cfClock' }, [h('span', { class: 'k' }, ['서버 시간']), clockTime]);
  var clockErrEl = h('span', { class: 'k', style: 'margin-left:2px' }, ['']);
  var countdown = h('div', { id: 'cfCount', style: 'display:none' }, ['']);
  var spacer = h('div', { class: 'sp' }, []);
  var panel = h('div', { id: 'cfPanel' }, [
    h('div', { id: 'cfHead' }, [
      h('div', { id: 'cfTitle' }, [
        h('b', {}, ['🏕 캠핏 예약 도우미']),
        h('button', { class: 'sub', onclick: function () { closePanel(); } }, ['닫기'])
      ]),
      h('div', { id: 'cfStatus' }, [countdown, spacer, clock])
    ]),
    body
  ]);

  function closePanel() {
    running = false;
    if (clockTimer) clearInterval(clockTimer);
    clearTimeout(syncTimer);
    clearTimeout(armTimer);
    document.removeEventListener('visibilitychange', onHidden);
    panel.remove();
    style.remove();
  }
  document.body.appendChild(panel);

  if (!TOKEN) {
    body.appendChild(h('div', { class: 'cfMsg err' }, ['로그인이 필요합니다. 캠핏에 로그인한 뒤 다시 열어주세요.']));
    return;
  }

  // 서버 시계 표시 — 예약 시각을 눈으로 확인할 수 있습니다.
  function pad(n) { return String(n).padStart(2, '0'); }
  function tickClock() {
    var d = serverNow();
    clockTime.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    tickStatus();
    tsFreshen();
  }

  // 라벨과 값을 한 배지 안에 같은 모양으로 채웁니다.
  function setKV(el, label, value) {
    el.textContent = '';
    if (label) el.appendChild(h('span', { class: 'k' }, [label]));
    el.appendChild(h('span', { class: 'v' }, [value]));
  }

  clock.classList.add('off');
  clockTime.textContent = '동기화 중';
  clock.appendChild(clockErrEl);

  // 필요할 때만 자주 잽니다. 매초 요청하면 서버 기록에 눈에 띄고, Cloudflare 가 이 브라우저를 의심해
  // 정작 예약 순간에 보안 확인을 띄울 수 있습니다.
  //   패널을 연 직후   약 1초마다 — 오차가 ±50ms 안으로 들어올 때까지 (최대 30회)
  //   그 뒤           1분마다 1회
  //   타이머 2분 전   약 1초마다 10회
  // 촘촘히 잴 때는 간격을 0.85~1.15초로 흔듭니다. 정확히 1초마다 재면 매번 초의 같은 지점을 재게 되어
  // 범위가 더 좁아지지 않습니다. 탭이 숨어 있으면 쉬고, 다시 보이면 이어서 잽니다.
  var burstLeft = 30, preLeft = 0, preFor = null;

  function syncDelay() {
    var quick = 850 + Math.random() * 300;
    if (burstLeft > 0 && (clockErr === null || clockErr > 50)) return quick;
    burstLeft = 0;
    if (armTarget) {
      var left = armTarget - serverNow();
      if (left > 120000) return Math.min(60000, left - 120000);   // 2분 전 시점에 맞춰 깹니다
      if (left > 0) {
        if (preFor !== armTarget) { preFor = armTarget; preLeft = 10; }
        if (preLeft > 0) return quick;
      }
    }
    return 60000;
  }

  function resync() {
    clearTimeout(syncTimer);
    if (syncing || document.hidden) return;   // 재는 중이면 끝난 뒤 다음 일정을 잡습니다
    if (burstLeft <= 0 && preFor === armTarget && preLeft > 0) preLeft--;
    else if (burstLeft > 0) burstLeft--;
    syncClock().then(function (off) {
      clock.classList.remove('off');
      clockErrEl.textContent = '±' + Math.round(clockErr) + 'ms';
      clock.title = '서버 시간 — PC 시계와 ' + (off >= 0 ? '+' : '') + (off / 1000).toFixed(3) + '초 차이, ' +
        '오차 ±' + Math.round(clockErr) + 'ms (최근 ' + samples.length + '회 측정)';
    }).catch(function () {
      if (clockErr === null) {
        clock.title = '동기화 실패 — PC 시계';
        clockErrEl.textContent = 'PC 시계';
      }
    }).then(function () {
      syncTimer = setTimeout(resync, syncDelay());
    });
  }
  resync();
  tickClock();
  clockTimer = setInterval(tickClock, 200);

  // ── Step 0: 캠핑장 검색 ──
  var s0 = h('div', { class: 'cfStep' });
  var searchInput = h('input', { type: 'text', placeholder: '캠핑장 이름 (예: 휘게포레스트)' });
  var s0List = h('div', { class: 'cfList' });
  var s0Msg = h('div');

  s0.appendChild(h('h3', {}, ['Step 0 · 캠핑장 검색']));
  s0.appendChild(h('p', {}, ['이름으로 검색해 캠핑장을 고르세요.']));
  s0.appendChild(searchInput);
  s0.appendChild(h('button', { onclick: doSearch }, ['검색']));
  s0.appendChild(s0Msg);
  s0.appendChild(s0List);
  body.appendChild(s0);

  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });

  function msg(el, text, kind) {
    el.innerHTML = '';
    if (text) el.appendChild(h('div', { class: 'cfMsg ' + (kind || '') }, [text]));
  }

  // 요청이 겹칠 때 마지막 것만 반영하기 위한 번호
  var searchSeq = 0, zoneSeq = 0, siteSeq = 0;

  // ── URL 로 현재 캠핑장 알아내기 ──
  // /camp/{캠핑장ID} 또는 /camp/{캠핑장ID}/{구역ID} 형태입니다.
  // 캠핑장 상세 화면에서 열면 검색을 건너뛰고 바로 다음 단계로 갑니다.
  var pending = null;

  function readUrl() {
    var m = location.pathname.match(/\/camp\/([0-9a-f]{24})(?:\/([0-9a-f]{24}))?/i);
    if (!m) return null;
    return { campId: m[1], zoneId: m[2] || null };
  }

  // 캠핑장 상세 — 이름을 정확히 얻는 경로입니다.
  // /v1 이 아닌 proxy 경로라 api() 대신 직접 부릅니다.
  function fetchCampName(campId) {
    return fetch('https://api.camfit.co.kr/proxy/api/v1/app/experiences/camp/' + campId, {
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + TOKEN }
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d ? pickName(d) : ''; })
      .catch(function () { return ''; });
  }

  // 응답 어딘가에 있는 캠핑장 이름을 집어냅니다.
  // 구조를 단정할 수 없어 흔한 자리를 차례로 봅니다.
  function pickName(d) {
    var boxes = [d, d.data, d.camp, d.result, d.experience,
                 d.data && d.data.camp, d.data && d.data.result];
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!b || typeof b !== 'object') continue;
      var nm = b.campName || b.name || b.title;
      if (typeof nm === 'string' && nm.trim()) return nm.trim();
    }
    return '';
  }

  // 캠핑장 이름 찾기 — 화면에서 먼저 훑고, 실패하면 API 로 확인합니다.
  // 이름은 표시용이라 못 찾아도 ID 로 진행할 수 있습니다.
  function campNameFromPage() {
    // 상세 페이지의 제목. 캠핏은 og:title 에 캠핑장 이름을 넣습니다.
    var og = document.querySelector('meta[property="og:title"]');
    var t = og && og.content && og.content.trim();
    if (ok(t)) return clean(t);

    var el = document.querySelector('h1, h2, [class*="campName"], [class*="CampName"]');
    t = el && el.textContent.trim();
    if (ok(t)) return clean(t);

    // 마지막으로 <title> — "캠핑장이름 : 캠핏" 같은 꼬리를 떼어 냅니다.
    t = document.title && document.title.trim();
    return ok(t) ? clean(t) : '';

    function ok(x) { return x && x.length > 1 && x.length < 40; }
    function clean(x) { return x.split(/\s*[|:·]\s*/)[0].trim(); }
  }

  // 구역 응답이나 검색 API 에서 캠핑장 이름을 건집니다.
  function campNameFromApi(zonesResponse) {
    var d = zonesResponse;
    var c = d && (d.camp || d.campInfo || d.data && d.data.camp);
    var nm = c && (c.name || c.title);
    if (nm) return Promise.resolve(nm);
    if (d && typeof d.campName === 'string') return Promise.resolve(d.campName);

    // 구역 하나가 캠핑장 정보를 물고 있는 경우도 있습니다.
    var list = Array.isArray(d) ? d : (d && (d.zones || d.results || d.data) || []);
    for (var i = 0; i < list.length; i++) {
      var z = list[i];
      var zc = z && (z.camp || z.campInfo);
      if (zc && (zc.name || zc.title)) return Promise.resolve(zc.name || zc.title);
      if (z && typeof z.campName === 'string' && z.campName) return Promise.resolve(z.campName);
    }
    return Promise.resolve('');
  }

  // 이름이 있을 때만 "○○ · " 을 앞에 붙입니다.
  function showCampIn(el, nm) {
    el.textContent = '';
    if (!nm) return;
    el.appendChild(h('b', {}, [nm]));
    el.appendChild(document.createTextNode(' · '));
  }

  // 화면에 캠핑장 이름을 반영합니다.
  // 이름은 늦게 도착할 수 있습니다. 그 사이 다른 캠핑장을 골랐으면 버립니다.
  function setCampName(campId, nm) {
    if (!state.camp || state.camp.id !== campId) return;
    if (!nm || nm === state.camp.name) return;
    state.camp.name = nm;
    msg(s0Msg, '이 페이지의 캠핑장으로 시작합니다 — ' + nm, 'ok');
    // 이름이 늦게 도착해도 Step 1 안내가 함께 갱신되도록 합니다.
    showCampIn(s1Camp, nm);
  }

  function enterFromUrl() {
    var u = readUrl();
    if (!u) return false;

    pending = u;
    var nm = campNameFromPage();
    state.camp = { id: u.campId, name: nm || u.campId };

    // Step 0 은 접어 두되, 다른 캠핑장을 고를 수 있게 남겨 둡니다.
    s0.classList.add('done');
    msg(s0Msg, '이 페이지의 캠핑장으로 시작합니다' + (nm ? ' — ' + nm : ''), 'ok');

    // 이름은 캠핑장 상세에서 확인합니다. 화면에서 주운 값보다 정확합니다.
    fetchCampName(u.campId).then(function (nm) { setCampName(u.campId, nm); });

    loadZones();
    return true;
  }

  // 캠핏의 캠핑장·구역 페이지를 새 탭으로 엽니다. 사진과 요금을 미리 볼 수 있습니다.
  // 링크를 눌러도 그 항목이 선택되지는 않습니다.
  function siteLink(path) {
    return h('a', {
      class: 'cfLink', href: 'https://camfit.co.kr' + path, target: '_blank', rel: 'noopener',
      title: '캠핏에서 보기 (새 탭)',
      onclick: function (e) { e.stopPropagation(); }
    }, ['캠핏에서 보기 ↗']);
  }

  function doSearch() {
    var kw = searchInput.value.trim();
    if (!kw) { msg(s0Msg, '검색어를 입력하세요.', 'err'); return; }
    if (running) return;
    msg(s0Msg, '검색 중...', '');
    s0List.innerHTML = '';
    // 새로 검색하면 고른 캠핑장도 풀립니다. 그 뒤 단계는 모두 비웁니다.
    state.camp = null;
    s0.classList.remove('done');
    resetAfter(0, '캠핑장 다시 검색');

    var seq = ++searchSeq;
    fetch(API + '/camps/search/autocomplete?search=' + encodeURIComponent(kw))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        // 뒤늦게 도착한 이전 요청의 응답은 버립니다.
        if (seq !== searchSeq) return;
        // 응답 형태가 배열일 수도, {results:[...]} 일 수도 있습니다.
        var list = Array.isArray(d) ? d : (d.results || d.camps || d.data || []);
        // 응답을 그리기 직전에 한 번 더 비웁니다.
        s0List.innerHTML = '';
        if (!list.length) { msg(s0Msg, '검색 결과가 없습니다.', 'err'); return; }
        msg(s0Msg, list.length + '개 발견', 'ok');

        list.forEach(function (c) {
          var id = c.id || c._id;
          var nm = c.name || c.title || '(이름 없음)';
          var it = h('div', { class: 'cfItem' }, [
            h('div', { class: 'nm' }, [h('span', {}, [nm]), siteLink('/camp/' + id)]),
            h('div', { class: 'sub' }, [(c.address || '') + '  ' + id])
          ]);
          it.addEventListener('click', function () {
            s0List.querySelectorAll('.cfItem').forEach(function (x) { x.classList.remove('on'); });
            it.classList.add('on');
            state.camp = { id: id, name: nm };
            resetAfter(0, '캠핑장 변경');
            s0.classList.add('done');
            showCampIn(s1Camp, nm);
            loadZones();
          });
          s0List.appendChild(it);
        });
      })
      .catch(function (e) {
        if (seq !== searchSeq) return;
        msg(s0Msg, '검색 실패: ' + e.message, 'err');
      });
  }

  // ── Step 1: 구역 조회 ──
  var s1 = h('div', { class: 'cfStep', style: 'display:none' });
  var s1List = h('div', { class: 'cfList' });
  var s1Msg = h('div');
  // 어느 캠핑장의 구역을 보고 있는지 함께 보여 줍니다.
  var s1Camp = h('span', { class: 'campNm' }, []);
  s1.appendChild(h('h3', {}, ['Step 1 · 구역 선택']));
  s1.appendChild(h('p', {}, [s1Camp, '예약할 구역을 고르세요.']));
  s1.appendChild(s1Msg);
  s1.appendChild(s1List);
  body.appendChild(s1);

  function loadZones() {
    s1.style.display = '';
    s1List.innerHTML = '';
    msg(s1Msg, '구역을 불러오는 중...', '');

    // URL 로 들어온 경우, 목록을 그리면서 해당 구역을 찾아 둡니다.
    var want = pending;
    var matched = null;
    pending = null;

    var p = new URLSearchParams({
      id: state.camp.id, adult: 2, teen: 0, child: 0,
      startTimestamp: 0, endTimestamp: 0, limit: 100, skip: 0
    });

    var seq = ++zoneSeq;
    api('/camps/zones/' + state.camp.id + '?' + p).then(function (d) {
      if (seq !== zoneSeq) return;

      // URL 로 들어와 이름을 아직 모르면 응답에서 건져 봅니다.
      if (want && state.camp.name === state.camp.id) {
        var cid = state.camp.id;
        campNameFromApi(d).then(function (nm) { setCampName(cid, nm); });
      }

      var list = Array.isArray(d) ? d : (d.zones || d.results || d.data || []);
      s1List.innerHTML = '';
      if (!list.length) { msg(s1Msg, '구역이 없습니다. 응답: ' + JSON.stringify(d).slice(0, 200), 'err'); return; }
      msg(s1Msg, list.length + '개 구역', 'ok');

      list.forEach(function (z) {
        var id = z.id || z._id;
        var nm = z.name || z.title || '(이름 없음)';
        var it = h('div', { class: 'cfItem' }, [
          h('div', { class: 'nm' }, [h('span', {}, [nm]), siteLink('/camp/' + state.camp.id + '/' + id)]),
          h('div', { class: 'sub' }, [id])
        ]);
        it.addEventListener('click', function () { chooseZone(it, id, nm); });
        s1List.appendChild(it);

        // URL 에 구역 ID 가 있으면 그 구역을 눌러 둡니다.
        if (want && want.zoneId === id) matched = it;
      });

      if (matched) matched.click();
      else if (want && want.zoneId) msg(s1Msg, list.length + '개 구역 — URL 의 구역을 찾지 못해 직접 골라야 합니다.', 'err');
    }).catch(function (e) { msg(s1Msg, '구역 조회 실패: ' + e.message, 'err'); });
  }

  // 구역이 정해졌을 때 — 클릭이든 URL 자동 선택이든 같은 경로를 씁니다.
  function chooseZone(it, id, nm) {
    s1List.querySelectorAll('.cfItem').forEach(function (x) { x.classList.remove('on'); });
    it.classList.add('on');
    state.zone = { id: id, name: nm };
    s1.classList.add('done');
    // 요금표가 담긴 구역 상세를 받아 둡니다.
    zoneInfo = null;
    resetAfter(1, '구역 변경');
    api('/zones/' + id + '?id=' + id + '&adult=2&teen=0&child=0')
      .then(function (z) {
        if (!state.zone || state.zone.id !== id) return;   // 그 사이 다른 구역을 골랐습니다.
        zoneInfo = z;
        // 요금표가 이제 왔으니, 금액 칸이 열려 있으면 바로 계산합니다.
        if (s3.style.display !== 'none') scheduleCalc();
        // 구역 상세에도 캠핑장 정보가 실려 오므로, 아직 이름을 모르면 여기서 채웁니다.
        var cid = state.camp.id;
        if (state.camp.name === cid) campNameFromApi(z).then(function (nm) { setCampName(cid, nm); });
      })
      .catch(function () { /* 실패하면 수동 입력으로 진행합니다. */ });
    // 날짜를 정한 뒤 조회하므로 카드만 열어 둡니다.
    s2.style.display = '';
    msg(s2Msg, '날짜를 확인하고 사이트 조회를 누르세요.', '');
    s2.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── Step 2: 사이트 선택 ──
  var s2 = h('div', { class: 'cfStep', style: 'display:none' });
  var s2Chips = h('div', { class: 'cfChips' });
  var s2Msg = h('div');
  var s2Picked = h('div', { class: 'sub', style: 'margin-top:8px;font-size:11px;color:#8a8f98' });
  var _t = new Date(); _t.setDate(_t.getDate() + 1);
  var _o = new Date(_t); _o.setDate(_o.getDate() + 2);
  var _iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  var dIn  = h('input', { type: 'date', value: _iso(_t) });
  var dOut = h('input', { type: 'date', value: _iso(_o) });
  // 날짜가 바뀌면 예약 가능 여부도 달라지니 사이트를 비우고 새 날짜로 다시 조회합니다.
  function datesChanged() {
    if (running || !state.zone) return;
    resetAfter(2, '날짜 변경');
    if (dIn.value && dOut.value && ts(dOut.value) > ts(dIn.value)) loadSites();
    else msg(s2Msg, '퇴실일은 입실일보다 뒤여야 합니다.', 'err');
  }
  dIn.addEventListener('change', datesChanged);
  dOut.addEventListener('change', datesChanged);

  s2.appendChild(h('h3', {}, ['Step 2 · 날짜와 사이트']));
  s2.appendChild(h('p', {}, ['날짜를 정하면 사이트가 조회됩니다. 누른 순서가 곧 우선순위입니다.']));
  s2.appendChild(h('div', { class: 'cfRow' }, [
    h('div', {}, [h('div', { style: 'font-size:11px;color:#8a8f98;margin-bottom:3px' }, ['입실일']), dIn]),
    h('div', {}, [h('div', { style: 'font-size:11px;color:#8a8f98;margin-bottom:3px' }, ['퇴실일']), dOut])
  ]));
  s2.appendChild(h('button', { onclick: loadSites }, ['사이트 조회']));
  s2.appendChild(s2Msg);
  s2.appendChild(s2Chips);
  s2.appendChild(s2Picked);
  body.appendChild(s2);

  // 날짜를 타임스탬프로 변환합니다. 사이트 조회에 필수입니다.
  function ts(v) {
    var p = v.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).getTime();
  }

  function loadSites() {
    if (!dIn.value || !dOut.value) { msg(s2Msg, '입실일과 퇴실일을 먼저 정하세요.', 'err'); return; }
    if (ts(dOut.value) <= ts(dIn.value)) { msg(s2Msg, '퇴실일은 입실일보다 뒤여야 합니다.', 'err'); return; }

    if (running) return;
    resetAfter(2, '사이트 다시 조회');
    msg(s2Msg, '사이트를 불러오는 중...', '');

    // 이 엔드포인트는 zone ID를 받아 그 구역의 사이트 배열을 돌려줍니다.
    var p = new URLSearchParams({
      id: state.zone.id,
      adult: +v('adult') || 2, teen: +v('teen') || 0, child: +v('child') || 0,
      startTimestamp: ts(dIn.value), endTimestamp: ts(dOut.value)
    });

    var seq = ++siteSeq;
    api('/sites/' + state.zone.id + '?' + p).then(function (d) {
      if (seq !== siteSeq) return;
      var list = Array.isArray(d) ? d : (d.sites || d.data || []);
      s2Chips.innerHTML = '';
      if (!list.length) { msg(s2Msg, '사이트가 없습니다. 응답: ' + JSON.stringify(d).slice(0, 200), 'err'); return; }

      state.sites = list.map(function (x) {
        return {
          id: x.id || x._id,
          name: x.name || x.title || '(이름없음)',
          // 사이트마다 요금이 다를 수 있어 함께 보관합니다.
          price: x.salePrice || x.price || 0,
          // unavailableReason이 있으면 그 날짜에 예약 불가한 사이트입니다.
          blocked: !!x.unavailableReason,
          reason: x.unavailableReason || ''
        };
      });

      var free = state.sites.filter(function (x) { return !x.blocked; }).length;
      msg(s2Msg, state.sites.length + '개 중 ' + free + '개 예약 가능', 'ok');
      renderChips();
      s2.classList.add('done');
      s3.style.display = '';
      conditionChanged('사이트 조회');   // 선택이 비었으니 금액도 새로 계산합니다.
      tsPrepare(1);   // 누르는 순간 바로 쓸 수 있게 보안 토큰을 미리 받아 둡니다.
    }).catch(function (e) { msg(s2Msg, '사이트 조회 실패: ' + e.message, 'err'); });
  }

  // ── 단계 초기화 ──
  // 어떤 단계에서 무언가를 바꾸면 그 뒤 단계는 앞 단계의 결과로 만든 것이라 더 이상 맞지 않습니다.
  // step 뒤의 단계를 비우고 숨깁니다. 직접 입력한 값(날짜, 인원, 예약자 정보)은 남겨 둡니다.
  //   0: 캠핑장이 바뀜 → 구역·사이트·실행 비움
  //   1: 구역이 바뀜   → 사이트·실행 비움
  //   2: 날짜·조회     → 사이트 선택·실행 비움
  function resetAfter(step, why) {
    if (step < 1) {
      zoneSeq++;            // 오고 있던 구역 목록은 버립니다.
      state.zone = null;
      zoneInfo = null;
      s1List.innerHTML = '';
      msg(s1Msg, '', '');
      s1.classList.remove('done');
      s1.style.display = 'none';
    }
    if (step < 2) s2.style.display = 'none';
    siteSeq++;              // 오고 있던 사이트 목록은 버립니다.
    state.sites = [];
    state.picked = [];
    s2Chips.innerHTML = '';
    s2Picked.textContent = '';
    msg(s2Msg, '', '');
    s2.classList.remove('done');
    // Step 3 은 사이트를 다시 고를 때까지 숨깁니다. 금액·다시 시도는 비웁니다.
    s3.style.display = 'none';
    conditionChanged(why);
  }

  function renderChips() {
    s2Chips.innerHTML = '';
    state.sites.forEach(function (s) {
      var i = state.picked.indexOf(s.id);
      var el = h('div', {
        class: 'cfChip' + (i > -1 ? ' sel' : '') + (s.blocked ? ' blk' : ''),
        title: s.name + (s.blocked ? ' — ' + s.reason : '')
      }, [h('span', { class: 'tx' }, [s.name])]);
      if (i > -1) el.appendChild(h('span', { class: 'rk' }, [String(i + 1)]));
      el.addEventListener('click', function () {
        var j = state.picked.indexOf(s.id);
        if (j > -1) state.picked.splice(j, 1); else state.picked.push(s.id);
        renderChips();
        conditionChanged('사이트 선택 변경');
      });
      s2Chips.appendChild(el);
    });
    var names = state.picked.map(function (id) {
      var f = state.sites.filter(function (x) { return x.id === id; })[0];
      return f ? f.name : id;
    });
    s2Picked.textContent = names.length ? '우선순위: ' + names.join(' → ') : '선택한 사이트가 없습니다.';
  }

  // ── Step 3: 예약 정보 ──
  var s3 = h('div', { class: 'cfStep', style: 'display:none' });
  s3.appendChild(h('h3', {}, ['Step 3 · 예약 정보와 실행']));

  function field(label, id, val, type) {
    var wrap = h('div');
    wrap.appendChild(h('div', { style: 'font-size:11px;color:#8a8f98;margin-bottom:3px' }, [label]));
    var attrs = { type: type || 'text', id: 'cf_' + id, value: val };
    // 시각은 초까지 지정할 수 있어야 합니다 (기본 UI 는 분 단위까지만 보여 줍니다).
    if (type === 'time') attrs.step = '1';
    wrap.appendChild(h('input', attrs));
    return wrap;
  }

  s3.appendChild(h('div', { class: 'cfRow' }, [
    field('성인', 'adult', '2', 'number'),
    field('청소년', 'teen', '1', 'number'),
    field('유아', 'child', '0', 'number'),
    field('차량', 'car', '1', 'number')
  ]));
  s3.appendChild(field('예약자 이름', 'name', ''));
  s3.appendChild(field('연락처', 'contact', ''));
  s3.appendChild(field('차량번호', 'carno', ''));

  // ── 요금 계산 ──
  // /v1/zones 응답의 charges·tempCharges·peakPeriods로 박별 요금을 직접 계산합니다.
  // 오픈 순간에 calculate를 호출하지 않아도 되므로 왕복이 한 번 줄어듭니다.
  var zoneInfo = null;   // 구역 상세 (요금표 포함)

  // 그 날짜가 성수기/극성수기인지 판정합니다. 연말처럼 해를 넘기는 구간도 처리합니다.
  function peakOf(d) {
    var ps = (zoneInfo && zoneInfo.camp && zoneInfo.camp.peakPeriods) || [];
    var md = (d.getMonth() + 1) * 100 + d.getDate();
    for (var i = 0; i < ps.length; i++) {
      var a = ps[i].fromMonth * 100 + ps[i].fromDay;
      var b = ps[i].toMonth * 100 + ps[i].toDay;
      var hit = a <= b ? (md >= a && md <= b) : (md >= a || md <= b);
      if (hit) return ps[i].isSuperPeak ? 'superPeak' : 'peak';
    }
    return 'normal';
  }

  // tempCharges의 요일 지정이 그 날짜에 걸리는지 봅니다.
  var DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function nightCharge(d, season, weekendDays, skipTemp) {
    var key = DOW[d.getDay()];
    var t = d.getTime();

    // 특정 요일 특별요금이 우선합니다 (예: 일요일 90,000).
    var tc = (skipTemp ? [] : (zoneInfo && zoneInfo.tempCharges)) || [];
    for (var i = 0; i < tc.length; i++) {
      var c = tc[i];
      if (c.startTimestamp && t < c.startTimestamp) continue;
      if (c.endTimestamp && t > c.endTimestamp) continue;
      if (!c.applyDays || !c.applyDays[key]) continue;
      if (season === 'superPeak') return c.superPeakSingle || c.single;
      if (season === 'peak') return c.peakSingle || c.single;
      return c.single;
    }

    // 기본 요금표 — 주말 여부에 따라 갈립니다.
    var ch = (zoneInfo && zoneInfo.charges && zoneInfo.charges[season]) || null;
    if (!ch) return 0;
    var isWeekend = weekendDays.indexOf(key) > -1;
    var slot = isWeekend ? ch.weekend : ch.weekday;
    return (slot && (slot.single || slot.multiple)) || 0;
  }

  // 입실일부터 퇴실 전날까지 박별로 합산합니다.
  function totalFor(weekendDays, skipTemp) {
    if (!zoneInfo || !dIn.value || !dOut.value) return 0;
    var a = new Date(dIn.value), b = new Date(dOut.value);
    var sum = 0;
    for (var d = new Date(a); d < b; d.setDate(d.getDate() + 1)) {
      sum += nightCharge(d, peakOf(d), weekendDays, skipTemp);
    }
    return sum;
  }

  // 기준 대수를 넘는 차량은 보통 박당 추가 요금이 붙습니다.
  function carFee() {
    if (!zoneInfo || !dIn.value || !dOut.value) return 0;
    var base = zoneInfo.numOfCars || 1;
    var extra = Math.max(0, (+v('car') || 1) - base);
    if (extra <= 0) return 0;
    var nights = Math.round((new Date(dOut.value) - new Date(dIn.value)) / 86400000);
    var per = zoneInfo.extraCarCharge || 0;
    return extra * per * (zoneInfo.isCarChargeOnce ? 1 : nights);
  }

  // ── 금액 미리 계산 ──
  // 오픈 순간에 calculate를 호출하면 왕복 지연만큼 늦고, 금액이 틀리면 예약이 실패합니다.
  // 같은 조건(요일·성수기 등)의 참고 날짜로 미리 금액을 확보해 둡니다.
  // 후보를 제안만 하고, 실제로 보낼 금액은 사용자가 하나만 고릅니다.
  var priceInput = h('input', { type: 'text', id: 'cf_price', inputmode: 'numeric', placeholder: '예: 200000' });
  var preMsg = h('div');
  var priceChips = h('div', { class: 'cfChips', style: 'grid-template-columns:repeat(auto-fill,minmax(110px,1fr))' });

  s3.appendChild(h('div', { style: 'border-top:1px solid #2a2d33;margin:12px 0 10px' }));
  s3.appendChild(h('div', { style: 'font-size:12px;color:#4ade80;font-weight:600;margin-bottom:4px' },
    ['결제 금액 (필수)']));
  s3.appendChild(h('div', { style: 'font-size:11px;color:#8a8f98;margin-bottom:8px' },
    ['구역 요금표로 후보를 계산해 제안합니다. 그중 하나를 고르면 그 금액으로 한 번만 시도합니다.']));
  s3.appendChild(h('button', { class: 'sub', onclick: preCalc }, ['요금 후보 제안']));
  s3.appendChild(preMsg);
  s3.appendChild(priceChips);
  s3.appendChild(h('div', { style: 'font-size:11px;color:#8a8f98;margin:8px 0 3px' },
    ['결제 금액 (원) — 위에서 고르거나 직접 하나만 입력']));
  s3.appendChild(priceInput);
  priceInput.addEventListener('input', markPicked);

  // 입력칸의 금액과 같은 후보를 선택 표시합니다.
  function markPicked() {
    var cur = parsePrice(priceInput.value);
    [].forEach.call(priceChips.children, function (c) {
      c.className = 'cfChip' + (+c.getAttribute('data-price') === cur ? ' sel' : '');
    });
  }

  // 후보 목록을 고를 수 있는 버튼으로 그립니다. best 는 캠핏 계산값(추천)입니다.
  function showChoices(found, best) {
    priceChips.innerHTML = '';
    Object.keys(found).map(Number).sort(function (a, b) { return a - b; }).forEach(function (x) {
      var chip = h('div', { class: 'cfChip', 'data-price': String(x), title: found[x] }, [
        h('span', { class: 'tx' }, [x.toLocaleString() + '원 · ' + found[x]])
      ]);
      if (x === best) chip.appendChild(h('span', { class: 'rk rec' }, ['추천']));
      chip.addEventListener('click', function () {
        priceInput.value = String(x);
        markPicked();
      });
      priceChips.appendChild(chip);
    });
    markPicked();
  }

  // 구역 요금표(charges·tempCharges·peakPeriods)로 박별 요금을 계산합니다.
  // 만실이면 API가 price를 0으로 주므로, 계산 방식이 오픈 직전에도 항상 동작합니다.
  // 주말 정의와 특별요금 적용 방식이 캠핑장마다 달라, 경우의 수를 모두 후보로 만듭니다.
  // ── 조건이 바뀌면 ──
  // 캠핑장·구역·날짜·사이트·인원·차량이 바뀌면 금액이 달라질 수 있으니
  // 고른 금액을 비우고 후보를 다시 계산합니다. "다시 시도" 상태도 처음으로 되돌립니다.
  var priceSeq = 0;    // 조건이 바뀔 때마다 올라갑니다. 늦게 온 계산 결과를 버리는 데 씁니다.
  var calcTimer = 0;

  function conditionChanged(why) {
    priceSeq++;
    priceInput.value = '';
    priceChips.innerHTML = '';
    resetRun(why);
    if (s3.style.display === 'none') { msg(preMsg, '', ''); return; }
    msg(preMsg, why + ' — 금액을 다시 계산합니다', '');
    scheduleCalc();
  }

  // 연달아 바뀌는 경우(인원 칸 입력, 사이트 여러 개 클릭)를 한 번으로 묶습니다.
  function scheduleCalc() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(function () {
      if (!dIn.value || !dOut.value) return;
      if (!zoneInfo) { msg(preMsg, '구역 요금표를 받는 중 — 받으면 바로 계산합니다', ''); return; }
      preCalc();
    }, 400);
  }

  // 실행 중이면 건드리지 않습니다. 이번 실행은 누를 때의 조건으로 끝까지 갑니다.
  function resetRun(why) {
    if (running || !runCount) return;
    runCount = 0;
    runBtn.textContent = '지금 실행';
    msg(genMsg, '', '');
    log(why + ' — 다시 시도를 초기화했습니다');
  }

  function preCalc() {
    if (!dIn.value || !dOut.value) { msg(preMsg, '날짜를 먼저 정하세요.', 'err'); return; }
    if (ts(dOut.value) <= ts(dIn.value)) { msg(preMsg, '퇴실일은 입실일보다 뒤여야 합니다.', 'err'); return; }
    if (!zoneInfo) { msg(preMsg, '구역 요금표를 아직 못 받았습니다. 잠시 후 다시 눌러주세요.', 'err'); return; }

    var weekendSets = [
      { label: '금', days: ['fri'] },
      { label: '토', days: ['sat'] },
      { label: '금토', days: ['fri', 'sat'] },
      { label: '토일', days: ['sat', 'sun'] },
      { label: '금토일', days: ['fri', 'sat', 'sun'] }
    ];

    var fee = carFee();
    var found = {};   // 금액 → 어떤 조합에서 나왔는지

    weekendSets.forEach(function (w) {
      // 특별요금(일요일 등)을 적용한 경우와 무시한 경우를 모두 계산합니다.
      [false, true].forEach(function (skip) {
        var t = totalFor(w.days, skip);
        if (t <= 0) return;
        var total = t + fee;
        if (!found[total]) found[total] = w.label + (skip ? '·특별X' : '');
      });
    });

    var count = Object.keys(found).length;
    showChoices(found, 0);
    msg(preMsg, count
      ? '후보 ' + count + '개 — 하나를 고르세요' + (fee ? ' (주차 ' + fee.toLocaleString() + '원 포함)' : '')
      : '요금표 계산에 실패했습니다.', count ? 'ok' : 'err');

    // 빈자리가 있을 때는 캠핏 calculate 가 정확한 금액을 알려 줍니다(만실이면 실패하거나 0).
    // 오픈 전에 한 번만 조회해 추천 표시만 합니다 — 오픈 순간에는 호출하지 않습니다.
    if (!state.picked.length) return;
    var seq = priceSeq;
    var ci = dIn.value.split('-').map(Number), co = dOut.value.split('-').map(Number);
    calc({
      checkIn: { year: ci[0], month: ci[1], day: ci[2] },
      checkOut: { year: co[0], month: co[1], day: co[2] },
      adult: +v('adult'), teen: +v('teen'), child: +v('child'), car: +v('car')
    }, state.picked[0]).then(function (r) {
      if (seq !== priceSeq) return;   // 그 사이 조건이 바뀌었습니다.
      var exact = r.totalCharge || r.totalPrice || r.accommodationPrice;
      if (!exact) return;
      if (!found[exact]) found[exact] = '캠핏 계산';
      showChoices(found, exact);
      msg(preMsg, '캠핏 계산 금액 ' + exact.toLocaleString() + '원을 추천합니다 — 하나를 고르세요', 'ok');
    }).catch(function () {
      if (seq !== priceSeq) return;
      if (!count) msg(preMsg, '후보를 만들지 못했습니다. 금액을 직접 입력하세요.', 'err');
    });
  }

  var genMsg = h('div');
  var outArea = h('textarea', { id: 'cfOut', readonly: 'readonly', style: 'display:none' });
  // "예약"은 캠핑장 예약에만 씁니다. 시각을 정해 두는 쪽은 "타이머"라고 부릅니다.
  var runBtn = h('button', {}, ['지금 실행']);
  var armBtn = h('button', { class: 'sub' }, ['⏰ 타이머 실행']);
  var stopBtn = h('button', { class: 'sub', style: 'display:none' }, ['중지']);
  var copyBtn = h('button', { class: 'sub' }, ['스크립트 복사']);
  var tsInfo = h('div', { style: 'font-size:11px;color:#8a8f98;margin-top:6px' }, ['보안 토큰: 준비 전']);
  var logBox = h('div', { id: 'cfLog', style: 'margin-top:4px' });
  var logClear = h('button', { class: 'sub', style: 'padding:3px 9px;font-size:11px;font-weight:500' }, ['로그 지우기']);
  var logWrap = h('div', { style: 'display:none;margin-top:10px' }, [
    h('div', { style: 'display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#8a8f98' },
      ['실행 로그', logClear]),
    logBox
  ]);
  logClear.addEventListener('click', function () {
    logBox.innerHTML = '';
    logWrap.style.display = 'none';
    if (!running) msg(genMsg, '', '');
  });

  // 타이머 — 정한 시각(보정된 서버 시간)에 지금 실행과 같은 동작을 합니다.
  s3.appendChild(h('div', { style: 'border-top:1px solid #2a2d33;margin:12px 0 2px' }));
  s3.appendChild(h('div', { class: 'cfRow' }, [
    field('타이머 날짜', 'odate', _iso(new Date()), 'date'),
    field('타이머 시각 (서버 시간)', 'otime', '10:00:00', 'time')
  ]));
  s3.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:4px' }, [runBtn, armBtn, stopBtn, copyBtn]));
  s3.appendChild(tsInfo);
  s3.appendChild(genMsg);
  s3.appendChild(logWrap);
  // 인원·차량은 금액이 달라지고, 예약자 정보는 금액과 무관하니 다시 시도만 초기화합니다.
  s3.addEventListener('input', function (e) {
    var id = e.target && e.target.id;
    if (/^cf_(adult|teen|child|car)$/.test(id)) conditionChanged('인원·차량 변경');
    else if (/^cf_(name|contact|carno)$/.test(id)) resetRun('예약자 정보 변경');
  });
  // 보안 확인이 필요할 때만 여기에 Turnstile 위젯이 나타납니다.
  var tsBox = h('div', { id: 'cfTs', style: 'margin-top:8px' });
  s3.appendChild(tsBox);
  s3.appendChild(outArea);
  body.appendChild(s3);

  function v(id) { var e = document.getElementById('cf_' + id); return e ? e.value : ''; }

  // 금액 하나를 숫자로 만듭니다. "200,000원" 같은 표기도 받습니다.
  // 숫자 덩어리가 둘 이상이면(여러 금액) 0 — 한 금액만 보내기 위해서입니다.
  function parsePrice(raw) {
    var parts = String(raw || '').replace(/,/g, '').match(/\d+/g) || [];
    return parts.length === 1 ? Number(parts[0]) : 0;
  }

  // 입력값을 모아 설정 객체로 만듭니다.
  function collect() {
    if (!state.picked.length) { msg(genMsg, '사이트를 하나 이상 선택하세요.', 'err'); return null; }
    if (!v('name') || !v('contact')) { msg(genMsg, '이름과 연락처를 입력하세요.', 'err'); return null; }
    var ci = dIn.value.split('-').map(Number);
    var co = dOut.value.split('-').map(Number);
    var price = parsePrice(priceInput.value);
    if (!price) { msg(genMsg, '결제 금액을 하나만 고르거나 입력하세요.', 'err'); return null; }
    return {
      price: price,
      sites: state.picked.slice(),
      names: state.picked.map(function (id) {
        var f = state.sites.filter(function (x) { return x.id === id; })[0];
        return f ? f.name : id;
      }),
      checkIn: { year: ci[0], month: ci[1], day: ci[2] },
      checkOut: { year: co[0], month: co[1], day: co[2] },
      adult: +v('adult'), teen: +v('teen'), child: +v('child'), car: +v('car'),
      name: v('name'), contact: v('contact'), carNo: v('carno')
    };
  }

  // 로그 시각은 서버 시계 기준 밀리초까지 — 요청이 언제 나가고 언제 돌아왔는지 봅니다.
  function stamp() {
    var d = serverNow();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function log(text, kind) {
    logWrap.style.display = '';
    var line = h('div', { class: 'cfLine' + (kind ? ' ' + kind : '') }, [
      h('span', { class: 'ts' }, [stamp()]), text
    ]);
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // 초를 "2일 03:14:05" 형태로 (하루 미만이면 일 표기는 생략)
  function fmtLeft(t) {
    var days = Math.floor(t / 86400);
    return (days ? days + '일 ' : '') + pad(Math.floor(t / 3600) % 24) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
  }

  // 헤더 배지에 지금 무엇을 기다리는지 보여줍니다. 비우면 숨깁니다.
  var status = null;   // { label, since }
  function setStatus(label) {
    status = label ? { label: label, since: Date.now() } : null;
    tickStatus();
  }
  function tickStatus() {
    if (armTarget) {
      var left = Math.ceil((armTarget - serverNow()) / 1000);
      countdown.style.display = '';
      countdown.className = left <= 60 ? 'soon' : '';
      setKV(countdown, '실행까지', left > 0 ? fmtLeft(left) : '지금');
      return;
    }
    if (!status) { countdown.style.display = 'none'; return; }
    countdown.style.display = '';
    countdown.className = 'soon';
    setKV(countdown, status.label, ((Date.now() - status.since) / 1000).toFixed(1) + '초');
  }

  // ── 예약 요청 ──
  var H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  var REQ_TIMEOUT = 10000;   // 이 시간 안에 응답이 없으면 요청을 끊습니다.
  var inflight = null;       // 응답을 기다리는 요청의 AbortController

  function calc(cfg, id) {
    return fetch(API + '/booking/calculate', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        siteId: id, checkInDate: cfg.checkIn, checkoutDate: cfg.checkOut,
        numOfAdults: cfg.adult, numOfTeens: cfg.teen, numOfChildren: cfg.child,
        numOfCars: cfg.car, services: [], hasTrailer: false, hasCampingCar: false, pets: []
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.message || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  // nonce 는 Turnstile 토큰입니다. 못 받았으면 사이트와 똑같이 빼고 보냅니다.
  // 결과는 { ok, status, d, ms } 이고, 타임아웃이면 { timeout: true, ms } 입니다.
  function book(cfg, id, price, nonce) {
    var payload = {
      siteId: id, checkInDate: cfg.checkIn, checkoutDate: cfg.checkOut,
      numOfAdults: cfg.adult, numOfTeens: cfg.teen, numOfChildren: cfg.child,
      numOfCars: cfg.car, services: [], name: cfg.name, contact: cfg.contact,
      paymentMethod: 'bank', coupon: null, couponDiscount: 0, usePoint: 0,
      campingPass: null, carNumbers: cfg.carNo ? [cfg.carNo] : [],
      accommodationPrice: price, parkingPrice: 0, servicePrice: 0,
      hasTrailer: false, hasCampingCar: false, petCharge: 0, pets: [], provider: null
    };
    if (nonce) payload.nonce = nonce;

    var ctl = new AbortController();
    var timedOut = false;
    var t0 = Date.now();
    var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, REQ_TIMEOUT);
    inflight = ctl;

    return fetch(API + '/book', {
      method: 'POST', headers: H, body: JSON.stringify(payload), signal: ctl.signal
    }).then(function (r) {
      var ms = Date.now() - t0;
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d, ms: ms }; })
        .catch(function () { return { ok: r.ok, status: r.status, d: {}, ms: ms }; });
    }, function (e) {
      if (timedOut) return { timeout: true, ms: Date.now() - t0 };
      throw e;
    }).then(function (res) {
      clearTimeout(timer);
      if (inflight === ctl) inflight = null;
      return res;
    }, function (e) {
      clearTimeout(timer);
      if (inflight === ctl) inflight = null;
      throw e;
    });
  }

  // ── Cloudflare Turnstile ──
  // 캠핏은 예약 요청(/v1/book)의 nonce 에 Turnstile 토큰을 담습니다.
  // 사이트와 같은 사이트 키·action 으로 위젯을 띄워 토큰을 받습니다.
  // 토큰은 한 번 쓰면 끝이고 약 5분 뒤 만료됩니다. 사이트 선택 화면이 열리면 바로 위젯을 띄워
  // 미리 받아 두고(만료되면 자동 갱신), 쓴 위젯은 reset 해서 다음 토큰을 받습니다.
  var TS_KEY = '0x4AAAAAAFI5jECJgKCLjsP7';
  var TS_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  var TS_MAX = 6;          // 위젯을 너무 많이 띄우면 Cloudflare 가 의심할 수 있습니다.
  var TS_WAIT = 5000;      // 토큰이 없을 때 기다리는 최대 시간
  var TS_FRESH = 240000;   // 받은 지 4분이 지난 토큰은 쓰지 않고 새로 받습니다 (유효 시간 약 5분).
  var tsPool = [];         // { id, token }
  var tsWaiters = [];      // 토큰을 기다리는 요청들

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    return new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = TS_SRC;
      s.async = true;
      s.onload = function () {
        window.turnstile ? ok(window.turnstile) : fail(new Error('turnstile 객체 없음'));
      };
      s.onerror = function () { fail(new Error('Turnstile 스크립트 로드 실패')); };
      document.head.appendChild(s);
    });
  }

  function tsReadyCount() {
    return tsPool.filter(function (w) { return w.token; }).length;
  }

  function tsShow() {
    tsInfo.textContent = '보안 토큰: ' + tsReadyCount() + '/' + tsPool.length + ' 준비됨';
  }

  // 쓴 토큰은 재사용할 수 없으니 위젯을 reset 해 새 토큰을 받게 합니다.
  function tsRenew(w) {
    w.token = null;
    try { window.turnstile.reset(w.id); } catch (e) {}
    tsShow();
  }

  function tsAddWidget(ts) {
    var w = { id: null, token: null };
    var el = h('div');
    tsBox.appendChild(el);
    w.id = ts.render(el, {
      sitekey: TS_KEY,
      action: 'booking',
      appearance: 'interaction-only',
      'refresh-expired': 'auto',
      callback: function (t) {
        if (tsWaiters.length) { tsWaiters.shift()(t); tsRenew(w); return; }
        w.token = t;
        w.at = Date.now();
        tsShow();
      },
      'expired-callback': function () { w.token = null; tsShow(); },
      'error-callback': function () { w.token = null; tsShow(); },
      'before-interactive-callback': function () {
        tsInfo.textContent = '⚠️ 보안 확인 필요 — 아래 체크박스를 눌러주세요';
        if (running) log('⚠️ 보안 확인이 필요합니다 — 패널 아래 체크박스를 눌러주세요', 'err');
      }
    });
    tsPool.push(w);
    tsShow();
  }

  // 위젯을 n개까지 띄웁니다. 이미 있으면 모자란 만큼만 더합니다.
  function tsPrepare(n) {
    n = Math.min(Math.max(n, 1), TS_MAX);
    return loadTurnstile().then(function (ts) {
      while (tsPool.length < n) tsAddWidget(ts);
    }).catch(function (e) {
      tsInfo.textContent = '보안 토큰: 준비 실패 (' + e.message + ') — 토큰 없이 보냅니다';
    });
  }

  // 오래된 토큰은 만료 직전에 보내지 않도록 미리 새로 받습니다. 시계 표시와 함께 0.2초마다 확인합니다.
  // 자동 갱신(refresh-expired)은 만료된 뒤에야 일어나서, 그 직전에 보낸 토큰은 서버 확인 중 만료될 수 있습니다.
  function tsFreshen() {
    if (!tsPool) return;   // 패널을 여는 중 (아직 토큰 목록 전)
    var t = Date.now();
    tsPool.forEach(function (w) {
      if (w.token && t - w.at > TS_FRESH) tsRenew(w);
    });
  }

  // 준비된 토큰을 하나 꺼냅니다. 없으면 TS_WAIT 까지 기다리고, 그래도 없으면 null.
  function takeToken() {
    tsFreshen();
    for (var i = 0; i < tsPool.length; i++) {
      if (tsPool[i].token) {
        var t = tsPool[i].token;
        tsRenew(tsPool[i]);
        return Promise.resolve(t);
      }
    }
    if (!tsPool.length) return Promise.resolve(null);
    return new Promise(function (ok) {
      var settled = false;
      function give(t) { if (!settled) { settled = true; ok(t); } }
      tsWaiters.push(give);
      setTimeout(function () {
        var k = tsWaiters.indexOf(give);
        if (k > -1) tsWaiters.splice(k, 1);
        give(null);
      }, TS_WAIT);
    });
  }

  function tsClear() {
    tsWaiters.splice(0).forEach(function (f) { f(null); });
    tsPool.splice(0).forEach(function (w) {
      try { window.turnstile.remove(w.id); } catch (e) {}
    });
    tsBox.innerHTML = '';
  }

  // 누른 순간 우선순위대로 한 바퀴만 돌며, 사이트마다 고른 금액으로 한 번씩 보냅니다.
  // 끝나면(성공·실패·타임아웃) 버튼이 다시 살아나고, 다시 누르면 재시도합니다.
  var runCount = 0;

  function round(cfg) {
    var i = 0;
    runCount++;
    log('▶ ' + runCount + '번째 실행 — 사이트 ' + cfg.sites.length + '곳, ' +
      cfg.price.toLocaleString() + '원');

    function finish(text, kind) {
      log('■ ' + text, kind);
      msg(genMsg, text, kind);
      setBusy(false);
    }

    (function next() {
      if (!running) return;
      if (i >= cfg.sites.length) {
        finish('모든 사이트 실패 — 다시 누르면 재시도합니다', 'err');
        return;
      }
      var id = cfg.sites[i], nm = cfg.names[i];
      i++;
      var label = '[' + i + '/' + cfg.sites.length + ' ' + nm + ']';

      var tk = Date.now();
      setStatus('보안 토큰 대기');
      takeToken().then(function (nonce) {
        if (!running) return null;
        if (nonce) log(label + ' 보안 토큰 확보 (' + (Date.now() - tk) + 'ms)');
        else log(label + ' 보안 토큰 없음 — nonce 없이 보냅니다', 'err');

        log(label + ' → 요청 전송, 응답 대기 중 (최대 ' + REQ_TIMEOUT / 1000 + '초)');
        setStatus(nm + ' 응답 대기');
        return book(cfg, id, cfg.price, nonce);
      }).then(function (res) {
        if (!res || !running) return;
        setStatus(null);

        if (res.timeout) {
          // 요청은 서버에 닿았을 수 있습니다. 다음 사이트로 넘어가면 중복 예약이 될 수 있어 멈춥니다.
          log(label + ' ⌛ ' + (res.ms / 1000).toFixed(1) + '초 동안 응답 없음 — 요청을 끊었습니다', 'err');
          finish('타임아웃 — 서버에서 처리됐을 수 있습니다. 캠핏 예약 내역을 확인한 뒤 다시 누르세요', 'err');
          return;
        }
        if (res.ok && res.d.status !== 'fail') {
          log(label + ' ← HTTP ' + res.status + ' · ' + res.ms + 'ms — 예약 완료!', 'ok');
          finish('🎉 예약이 완료되었습니다 — ' + nm + ' ' + cfg.price.toLocaleString() + '원', 'ok');
          alert('예약이 완료되었습니다!\n' + nm + '\n' + cfg.price.toLocaleString() + '원');
          return;
        }
        var why = (res.d && (res.d.message || res.d.error || res.d.reason)) || '사유 없음';
        log(label + ' ← HTTP ' + res.status + ' · ' + res.ms + 'ms — 실패: ' + why, 'err');
        next();
      }).catch(function (e) {
        if (!running) return;
        setStatus(null);
        // 연결 자체가 실패한 경우라 서버가 처리하지 않았다고 보고 다음 사이트로 넘어갑니다.
        log(label + ' ✕ 요청 실패: ' + e.message, 'err');
        next();
      });
    })();
  }

  function setBusy(on) {
    running = on;
    runBtn.style.display = on ? 'none' : '';
    armBtn.style.display = on ? 'none' : '';
    stopBtn.style.display = on ? '' : 'none';
    if (!on) { armTarget = null; clearTimeout(armTimer); stopBtn.textContent = '중지'; }
    // 실행 중에 앞 단계를 바꾸면 이 화면(중지 버튼 포함)이 사라지므로 잠가 둡니다.
    [s0, s1, s2].forEach(function (el) {
      el.style.pointerEvents = on ? 'none' : '';
      el.style.opacity = on ? '.45' : '';
    });
    if (!on) {
      setStatus(null);
      if (runCount) runBtn.textContent = '다시 시도';
    }
  }

  runBtn.addEventListener('click', function () {
    if (running) return;
    var cfg = collect();
    if (!cfg) return;
    msg(genMsg, '실행 중…', '');
    setBusy(true);
    // 사이트마다 토큰이 하나씩 필요합니다. 모자라면 위젯을 더 띄웁니다.
    tsPrepare(cfg.sites.length);
    round(cfg);
  });

  // ── 타이머 실행 ──
  // 기다리는 동안에도 서버 시계는 1초마다 다시 맞춰지므로, 남은 시간을 매번 새로 계산합니다.
  // 1.5초 전까지는 최대 1초 간격으로, 그 뒤로는 10ms 간격으로 확인합니다.
  var armTarget = null, armTimer = 0;

  armBtn.addEventListener('click', function () {
    if (running) return;
    var cfg = collect();
    if (!cfg) return;
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v('odate'));
    var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v('otime'));
    if (!dm || !tm) { msg(genMsg, '타이머 날짜와 시각을 정하세요.', 'err'); return; }
    var target = new Date(+dm[1], dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] || 0), 0);
    var left = target - serverNow();
    if (left < -5 * 60 * 1000) {
      msg(genMsg, '타이머 시각이 이미 지났습니다 — ' + target.toLocaleString('ko-KR'), 'err');
      return;
    }
    if (clockErr === null) log('⚠️ 서버 시간을 아직 못 맞췄습니다 — PC 시계 기준으로 기다립니다', 'err');

    setBusy(true);
    tsPrepare(cfg.sites.length);
    if (left <= 0) {
      log('타이머 시각이 지나 바로 시작합니다');
      round(cfg);
      return;
    }
    armTarget = target;
    resync();   // 예약 2분 전에 촘촘히 재도록 측정 일정을 다시 잡습니다
    msg(genMsg, '⏰ 타이머 — ' + target.toLocaleString('ko-KR') + ' (서버 시간)에 실행합니다', 'ok');
    stopBtn.textContent = '타이머 취소';
    log('⏰ ' + target.toLocaleString('ko-KR') + ' 에 실행합니다 — 이 탭을 화면에 띄워 두세요');
    (function wait() {
      if (!running || !armTarget) return;
      // 오차만큼 더 기다립니다. 서버 시각이 "가장 늦게 잡아도" 목표를 넘긴 뒤에 보내므로 오픈 전에 도착하지 않습니다.
      // 대신 최대 오차의 두 배(보통 수십 ms)만큼 늦을 수 있습니다.
      var ms = armTarget - serverNow() + (clockErr || 0);
      if (ms <= 0) {
        armTarget = null;
        stopBtn.textContent = '중지';
        log('⏰ 타이머 시각 — 시작합니다 (서버 시간 오차 ±' + Math.round(clockErr || 0) + 'ms)', 'ok');
        round(cfg);
        return;
      }
      armTimer = setTimeout(wait, ms > 1500 ? Math.min(ms - 1000, 1000) : 10);
    })();
  });

  // 기다리는 동안 탭이 가려지면 브라우저가 타이머를 늦춥니다. 알려 줍니다.
  function onHidden() {
    if (!document.hidden) { resync(); return; }
    if (armTarget) log('⚠️ 탭이 가려졌습니다 — 실행이 늦어질 수 있으니 이 탭을 화면에 띄워 두세요', 'err');
  }
  document.addEventListener('visibilitychange', onHidden);

  stopBtn.addEventListener('click', function () {
    if (armTarget) {
      setBusy(false);
      log('타이머를 취소했습니다');
      msg(genMsg, '타이머를 취소했습니다.', '');
      return;
    }
    var wasWaiting = !!inflight;
    if (inflight) inflight.abort();
    setBusy(false);
    log(wasWaiting ? '중지 — 이미 보낸 요청은 서버에서 처리됐을 수 있습니다' : '중지했습니다', wasWaiting ? 'err' : '');
    msg(genMsg, '중지했습니다.', '');
  });

  copyBtn.addEventListener('click', function () {
    var cfg = collect();
    if (!cfg) return;
    var code = buildScript(cfg);
    outArea.style.display = '';
    outArea.value = code;
    outArea.select();
    navigator.clipboard.writeText(code).then(function () {
      msg(genMsg, '복사했습니다. 콘솔에 붙여넣으면 바로 실행됩니다.', 'ok');
    }).catch(function () {
      msg(genMsg, '아래 내용을 직접 복사하세요.', '');
    });
  });

  // 콘솔에 붙여넣으면 바로 실행되는 스크립트를 만듭니다.
  function buildScript(c) {
    return [
      '// ===== 캠핏 예약 스크립트 =====',
      '// 캠핏에 로그인한 상태에서 콘솔에 붙여넣으면 바로 실행됩니다.',
      '// 다시 시도: cfRun()   중지: stopCf()',
      '(async function () {',
      '    const C = ' + JSON.stringify(c, null, 4).replace(/\n/g, '\n    ') + ';',
      '',
      '    const T = window.localStorage.jwt;',
      '    if (!T) { alert("로그인이 필요합니다."); return; }',
      '    const H = { "Authorization": "Bearer " + T, "Content-Type": "application/json" };',
      '    const API = "https://api.camfit.co.kr/v1";',
      '    const TIMEOUT = ' + REQ_TIMEOUT + ';   // 이 시간 안에 응답이 없으면 요청을 끊습니다.',
      '',
      '    // 로그 앞에 밀리초까지 시각을 붙입니다.',
      '    const ts = () => new Date().toTimeString().slice(0, 8) + "." + String(new Date().getMilliseconds()).padStart(3, "0");',
      '    const log = (...a) => console.log("[" + ts() + "]", ...a);',
      '    const warn = (...a) => console.warn("[" + ts() + "]", ...a);',
      '',
      '    // Cloudflare Turnstile — 예약 요청의 nonce 에 담을 일회용 토큰을 받습니다.',
      '    const TS_KEY = "' + TS_KEY + '";',
      '    const pool = [], waiters = [];',
      '    const renew = w => { w.token = null; try { turnstile.reset(w.id); } catch (e) {} };',
      '    const loadTs = () => window.turnstile ? Promise.resolve() : new Promise((ok, no) => {',
      '        const s = document.createElement("script");',
      '        s.src = "' + TS_SRC + '"; s.onload = ok; s.onerror = no;',
      '        document.head.appendChild(s);',
      '    });',
      '    async function prepareTs(n) {',
      '        try { await loadTs(); } catch (e) { warn("Turnstile 로드 실패 — 토큰 없이 보냅니다"); return; }',
      '        let box = document.getElementById("cfTsBox");',
      '        if (!box) {',
      '            box = document.createElement("div"); box.id = "cfTsBox";',
      '            box.style.cssText = "position:fixed;bottom:10px;right:10px;z-index:2147483647";',
      '            document.body.appendChild(box);',
      '        }',
      '        while (pool.length < Math.min(n, ' + TS_MAX + ')) {',
      '            const w = { token: null }, el = document.createElement("div");',
      '            box.appendChild(el);',
      '            w.id = turnstile.render(el, {',
      '                sitekey: TS_KEY, action: "booking", appearance: "interaction-only", "refresh-expired": "auto",',
      '                callback: t => { if (waiters.length) { waiters.shift()(t); renew(w); } else w.token = t; },',
      '                "expired-callback": () => { w.token = null; },',
      '                "before-interactive-callback": () => warn("보안 확인이 필요합니다 — 화면 오른쪽 아래 체크박스를 눌러주세요")',
      '            });',
      '            pool.push(w);',
      '        }',
      '    }',
      '    const takeToken = () => {',
      '        const w = pool.find(x => x.token);',
      '        if (w) { const t = w.token; renew(w); return Promise.resolve(t); }',
      '        if (!pool.length) return Promise.resolve(null);',
      '        return new Promise(ok => {',
      '            const give = t => { const k = waiters.indexOf(give); if (k > -1) waiters.splice(k, 1); ok(t); };',
      '            waiters.push(give);',
      '            setTimeout(() => give(null), ' + TS_WAIT + ');',
      '        });',
      '    };',
      '',
      '    let ctl = null, running = false, n = 0;',
      '',
      '    // 결과: { ok, status, d, ms } 또는 타임아웃이면 { timeout: true, ms }',
      '    async function book(id, nonce) {',
      '        ctl = new AbortController();',
      '        let timedOut = false;',
      '        const t0 = Date.now();',
      '        const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT);',
      '        try {',
      '            const r = await fetch(API + "/book", {',
      '                method: "POST", headers: H, signal: ctl.signal,',
      '                body: JSON.stringify({',
      '                    ...(nonce ? { nonce } : {}),',
      '                    siteId: id, checkInDate: C.checkIn, checkoutDate: C.checkOut,',
      '                    numOfAdults: C.adult, numOfTeens: C.teen, numOfChildren: C.child,',
      '                    numOfCars: C.car, services: [], name: C.name, contact: C.contact,',
      '                    paymentMethod: "bank", coupon: null, couponDiscount: 0, usePoint: 0,',
      '                    campingPass: null, carNumbers: C.carNo ? [C.carNo] : [],',
      '                    accommodationPrice: C.price, parkingPrice: 0, servicePrice: 0,',
      '                    hasTrailer: false, hasCampingCar: false, petCharge: 0, pets: [], provider: null',
      '                })',
      '            });',
      '            const ms = Date.now() - t0;',
      '            return { ok: r.ok, status: r.status, d: await r.json().catch(() => ({})), ms };',
      '        } catch (e) {',
      '            if (timedOut) return { timeout: true, ms: Date.now() - t0 };',
      '            throw e;',
      '        } finally {',
      '            clearTimeout(timer);',
      '            ctl = null;',
      '        }',
      '    }',
      '',
      '    // 사이트마다 고른 금액(C.price)으로 한 번씩만 보냅니다. 끝나면 cfRun() 으로 다시 시도할 수 있습니다.',
      '    async function run() {',
      '        if (running) { warn("이미 실행 중입니다."); return; }',
      '        running = true; n++;',
      '        log("▶ " + n + "번째 실행 — 사이트 " + C.sites.length + "곳, " + C.price + "원");',
      '        try {',
      '            for (let i = 0; i < C.sites.length; i++) {',
      '                if (!running) return;',
      '                const label = "[" + (i + 1) + "/" + C.sites.length + " " + C.names[i] + "]";',
      '                const tk = Date.now();',
      '                const nonce = await takeToken();',
      '                if (!running) return;',
      '                if (nonce) log(label + " 보안 토큰 확보 (" + (Date.now() - tk) + "ms)");',
      '                else warn(label + " 보안 토큰 없음 — nonce 없이 보냅니다");',
      '',
      '                log(label + " → 요청 전송, 응답 대기 중 (최대 " + TIMEOUT / 1000 + "초)");',
      '                // 응답이 늦으면 2초마다 아직 기다리는 중이라고 알려 줍니다.',
      '                const t0 = Date.now();',
      '                const tick = setInterval(() => log(label + " … 응답 대기 " + ((Date.now() - t0) / 1000).toFixed(0) + "초"), 2000);',
      '                let res;',
      '                try { res = await book(C.sites[i], nonce); }',
      '                catch (e) {',
      '                    if (!running) return;',
      '                    // 연결 자체가 실패한 경우라 서버가 처리하지 않았다고 보고 다음 사이트로 넘어갑니다.',
      '                    warn(label + " ✕ 요청 실패: " + e.message);',
      '                    continue;',
      '                } finally { clearInterval(tick); }',
      '',
      '                if (res.timeout) {',
      '                    // 요청은 서버에 닿았을 수 있습니다. 다음 사이트로 넘어가면 중복 예약이 될 수 있어 멈춥니다.',
      '                    warn(label + " ⌛ " + (res.ms / 1000).toFixed(1) + "초 동안 응답 없음 — 요청을 끊었습니다");',
      '                    warn("■ 타임아웃 — 서버에서 처리됐을 수 있습니다. 캠핏 예약 내역을 확인한 뒤 cfRun() 으로 다시 시도하세요");',
      '                    return;',
      '                }',
      '                if (res.ok && res.d.status !== "fail") {',
      '                    console.log("%c[" + ts() + "] " + label + " ← HTTP " + res.status + " · " + res.ms + "ms — 예약 완료!",',
      '                                "color:#2d7d46;font-size:16px;font-weight:bold");',
      '                    alert("예약이 완료되었습니다!\\n" + C.names[i] + "\\n" + C.price + "원");',
      '                    return;',
      '                }',
      '                warn(label + " ← HTTP " + res.status + " · " + res.ms + "ms — 실패: " + (res.d?.message || res.d?.error || "사유 없음"));',
      '            }',
      '            warn("■ 모든 사이트 실패 — cfRun() 으로 다시 시도할 수 있습니다");',
      '        } finally { running = false; }',
      '    }',
      '',
      '    window.cfRun = run;',
      '    window.stopCf = () => {',
      '        const waiting = !!ctl;',
      '        running = false;',
      '        if (ctl) ctl.abort();',
      '        warn(waiting ? "중지 — 이미 보낸 요청은 서버에서 처리됐을 수 있습니다" : "중지했습니다.");',
      '    };',
      '',
      '    await prepareTs(C.sites.length);',
      '    run();',
      '})();'
    ].join('\n');
  }

  // ── 시작 ──
  // 캠핑장 상세 페이지에서 열었으면 검색을 건너뜁니다.
  if (!enterFromUrl()) searchInput.focus();
})();
