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
  var clockTimer = 0;
  var running = false;      // 예약 시도 진행 중 여부

  function serverNow() { return new Date(Date.now() + clockOffset); }

  // 응답의 Date 헤더로 로컬 시계 오차를 잽니다.
  function syncClock() {
    var t0 = Date.now();
    return fetch(API + '/camps/search/autocomplete?search=' + t0, { cache: 'no-store' })
      .then(function (r) {
        var t1 = Date.now(), hd = r.headers.get('Date');
        if (!hd) throw new Error('Date 헤더 없음');
        // 왕복 지연의 절반을 더해 보정합니다.
        clockOffset = new Date(hd).getTime() + (t1 - t0) / 2 - t1;
        return clockOffset;
      });
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
    + '.cfChips{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:5px;margin-top:8px}'
    + '.cfChip{position:relative;padding:7px 3px;border:1px solid #3a3d44;border-radius:6px;'
    + 'text-align:center;font-size:11px;cursor:pointer;user-select:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.cfChip:hover{border-color:#2d7d46}'
    + '.cfChip.sel{background:#2d7d46;border-color:#2d7d46;color:#fff}'
    + '.cfChip.blk{opacity:.45}'
    + '.cfChip.blk:not(.sel){border-style:dashed}'
    + '.cfChip .rk{position:absolute;top:-5px;right:-5px;background:#c23b22;color:#fff;'
    + 'font-size:9px;min-width:15px;height:15px;line-height:15px;border-radius:8px;padding:0 3px}'
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
    tickCountdown(d);
  }

  // 예약 시작을 누르면 그때 확정된 오픈 일시까지 남은 시간을 헤더에 표시합니다.
  // 대기 중에만 보여주므로, 평소에는 숨어 있습니다.
  var cdTarget = null;

  function startCountdown(target) {
    cdTarget = target;
    tickCountdown(serverNow());
  }

  function stopCountdown() {
    cdTarget = null;
    countdown.style.display = 'none';
  }

  function tickCountdown(now) {
    if (!cdTarget) { countdown.style.display = 'none'; return; }

    countdown.style.display = '';
    countdown.title = '오픈 ' + cdTarget.toLocaleString('ko-KR');

    var left = cdTarget - now;
    if (left <= 0) {
      // 오픈 시각이 되면 카운트다운을 끝내고 진행 상황에 자리를 내줍니다.
      countdown.className = 'soon';
      setKV(countdown, '', '오픈!');
      return;
    }
    countdown.className = left <= 60000 ? 'soon' : '';
    setKV(countdown, '시작까지', fmtSpan(left));
  }

  // 라벨과 값을 한 배지 안에 같은 모양으로 채웁니다.
  function setKV(el, label, value) {
    el.textContent = '';
    if (label) el.appendChild(h('span', { class: 'k' }, [label]));
    el.appendChild(h('span', { class: 'v' }, [value]));
  }

  // 밀리초를 "2일 03:14:05" 형태로 (하루 미만이면 일 표기는 생략)
  // 시계는 지나간 초를 버리고 보여주므로, 남은 시간은 올려야 둘의 합이 맞습니다.
  // (22:35:12 에 자정까지면 01:24:48 — 12 + 48 = 60)
  function fmtSpan(ms) {
    var t = Math.ceil(ms / 1000);
    var days = Math.floor(t / 86400);
    var hhmmss = pad(Math.floor(t / 3600) % 24) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
    return (days ? days + '일 ' : '') + hhmmss;
  }
  clock.classList.add('off');
  clockTime.textContent = '동기화 중';
  syncClock().then(function (off) {
    clock.classList.remove('off');
    clock.title = '서버 시간 (보정 ' + (off / 1000).toFixed(1) + '초)';
    tickClock();
    clockTimer = setInterval(tickClock, 200);
  }).catch(function () {
    clock.title = '동기화 실패 — 로컬 시계';
    tickClock();
    clockTimer = setInterval(tickClock, 200);
  });

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
  function setCampName(nm) {
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
    fetchCampName(u.campId).then(setCampName);

    loadZones();
    return true;
  }

  function doSearch() {
    var kw = searchInput.value.trim();
    if (!kw) { msg(s0Msg, '검색어를 입력하세요.', 'err'); return; }
    msg(s0Msg, '검색 중...', '');
    s0List.innerHTML = '';

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
            h('div', { class: 'nm' }, [nm]),
            h('div', { class: 'sub' }, [(c.address || '') + '  ' + id])
          ]);
          it.addEventListener('click', function () {
            s0List.querySelectorAll('.cfItem').forEach(function (x) { x.classList.remove('on'); });
            it.classList.add('on');
            state.camp = { id: id, name: nm };
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
        campNameFromApi(d).then(setCampName);
      }

      var list = Array.isArray(d) ? d : (d.zones || d.results || d.data || []);
      s1List.innerHTML = '';
      if (!list.length) { msg(s1Msg, '구역이 없습니다. 응답: ' + JSON.stringify(d).slice(0, 200), 'err'); return; }
      msg(s1Msg, list.length + '개 구역', 'ok');

      list.forEach(function (z) {
        var id = z.id || z._id;
        var nm = z.name || z.title || '(이름 없음)';
        var it = h('div', { class: 'cfItem' }, [
          h('div', { class: 'nm' }, [nm]),
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
    api('/zones/' + id + '?id=' + id + '&adult=2&teen=0&child=0')
      .then(function (z) {
        zoneInfo = z;
        // 구역 상세에도 캠핑장 정보가 실려 오므로, 아직 이름을 모르면 여기서 채웁니다.
        if (state.camp.name === state.camp.id) campNameFromApi(z).then(setCampName);
      })
      .catch(function () { /* 실패하면 수동 입력으로 진행합니다. */ });
    // 날짜를 정한 뒤 조회하므로 카드만 열어 둡니다.
    s2.style.display = '';
    s2Chips.innerHTML = '';
    state.picked = [];
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

    s2Chips.innerHTML = '';
    state.picked = [];
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
    }).catch(function (e) { msg(s2Msg, '사이트 조회 실패: ' + e.message, 'err'); });
  }

  function renderChips() {
    s2Chips.innerHTML = '';
    state.sites.forEach(function (s) {
      var i = state.picked.indexOf(s.id);
      var el = h('div', {
        class: 'cfChip' + (i > -1 ? ' sel' : '') + (s.blocked ? ' blk' : ''),
        title: s.name + (s.blocked ? ' — ' + s.reason : '')
      }, [s.name]);
      if (i > -1) el.appendChild(h('span', { class: 'rk' }, [String(i + 1)]));
      el.addEventListener('click', function () {
        var j = state.picked.indexOf(s.id);
        if (j > -1) state.picked.splice(j, 1); else state.picked.push(s.id);
        renderChips();
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

  var today = new Date();
  var iso = function (d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  var tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  var dayAfter = new Date(today); dayAfter.setDate(dayAfter.getDate() + 3);

  s3.appendChild(h('div', { class: 'cfRow' }, [
    field('성인', 'adult', '2', 'number'),
    field('청소년', 'teen', '1', 'number'),
    field('유아', 'child', '0', 'number'),
    field('차량', 'car', '1', 'number')
  ]));
  s3.appendChild(field('예약자 이름', 'name', ''));
  s3.appendChild(field('연락처', 'contact', ''));
  s3.appendChild(field('차량번호', 'carno', ''));
  s3.appendChild(h('div', { class: 'cfRow' }, [
    field('오픈 날짜', 'odate', iso(today), 'date'),
    field('오픈 시각', 'otime', '14:00:00', 'time')
  ]));

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
  var priceInput = h('input', { type: 'text', id: 'cf_price', placeholder: '예: 200000, 180000, 220000' });
  var preMsg = h('div');

  s3.appendChild(h('div', { style: 'border-top:1px solid #2a2d33;margin:12px 0 10px' }));
  s3.appendChild(h('div', { style: 'font-size:12px;color:#4ade80;font-weight:600;margin-bottom:4px' },
    ['결제 금액 (필수)']));
  s3.appendChild(h('div', { style: 'font-size:11px;color:#8a8f98;margin-bottom:8px' },
    ['구역 요금표로 계산합니다. 주말 해석이 갈리는 경우를 모두 후보로 넣습니다.']));
  s3.appendChild(h('button', { class: 'sub', onclick: preCalc }, ['요금 자동 계산']));
  s3.appendChild(preMsg);
  s3.appendChild(h('div', { style: 'font-size:11px;color:#8a8f98;margin:8px 0 3px' },
    ['결제 금액 (원) — 쉼표로 여러 개 입력하면 동시에 시도해 맞는 금액이 통과합니다']));
  s3.appendChild(priceInput);

  // 구역 요금표(charges·tempCharges·peakPeriods)로 박별 요금을 계산합니다.
  // 만실이면 API가 price를 0으로 주므로, 계산 방식이 오픈 직전에도 항상 동작합니다.
  // 주말 정의와 특별요금 적용 방식이 캠핑장마다 달라, 경우의 수를 모두 후보로 만듭니다.
  function preCalc() {
    if (!dIn.value || !dOut.value) { msg(preMsg, '날짜를 먼저 정하세요.', 'err'); return; }
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

    var list = Object.keys(found).map(Number).sort(function (a, b) { return a - b; });
    if (!list.length) { msg(preMsg, '계산에 실패했습니다. 금액을 직접 입력하세요.', 'err'); return; }

    priceInput.value = list.join(', ');
    msg(preMsg, '후보 ' + list.length + '개 — ' +
      list.map(function (x) { return x.toLocaleString() + '(' + found[x] + ')'; }).join(' / ') +
      (fee ? ' · 주차 ' + fee.toLocaleString() + ' 포함' : ''), 'ok');
  }

  var genMsg = h('div');
  var outArea = h('textarea', { id: 'cfOut', readonly: 'readonly', style: 'display:none' });
  var runBtn = h('button', {}, ['예약 시작']);
  var stopBtn = h('button', { class: 'sub', style: 'display:none' }, ['중지']);
  var copyBtn = h('button', { class: 'sub' }, ['스크립트 복사']);
  var logBox = h('div', { id: 'cfLog', style: 'display:none' });

  s3.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:10px' }, [runBtn, stopBtn, copyBtn]));
  s3.appendChild(genMsg);
  s3.appendChild(logBox);
  s3.appendChild(outArea);
  body.appendChild(s3);

  function v(id) { var e = document.getElementById('cf_' + id); return e ? e.value : ''; }

  // 오픈 날짜(YYYY-MM-DD) + 오픈 시각(HH:MM:SS)을 하나의 Date로 만듭니다.
  // 날짜를 빼먹으면 "오늘 그 시각"으로 해석돼 엉뚱한 날 즉시 돌진하므로,
  // 년월일과 시분초를 모두 명시적으로 지정합니다.
  // "YYYY-MM-DD" + "HH:MM[:SS]" 을 Date 로 만듭니다.
  // 어느 한 쪽이라도 비거나 형식이 틀리면 null — 시각이 빈 칸일 때
  // 자정으로 해석돼 엉뚱한 때에 시작하는 것을 막습니다.
  function openTarget(dateStr, timeStr) {
    var dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
    var tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr || '').trim());
    if (!dm || !tm) return null;

    var y = +dm[1], mo = +dm[2], d = +dm[3];
    var hh = +tm[1], mi = +tm[2], ss = +(tm[3] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (hh > 23 || mi > 59 || ss > 59) return null;

    var dt = new Date(y, mo - 1, d, hh, mi, ss, 0);
    // 2026-02-31 처럼 넘겨짚은 날짜는 다른 날로 굴러가므로 걸러 냅니다.
    if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  // 쉼표로 구분된 금액 후보를 숫자 배열로 만듭니다.
  function parsePrices(raw) {
    return (raw || '').split(/[,\s]+/).map(function (x) {
      return Number(String(x).replace(/[^0-9]/g, ''));
    }).filter(function (n) { return n > 0; });
  }

  // 입력값을 모아 설정 객체로 만듭니다.
  function collect() {
    if (!state.picked.length) { msg(genMsg, '사이트를 하나 이상 선택하세요.', 'err'); return null; }
    if (!v('name') || !v('contact')) { msg(genMsg, '이름과 연락처를 입력하세요.', 'err'); return null; }
    var ci = dIn.value.split('-').map(Number);
    var co = dOut.value.split('-').map(Number);
    var prices = parsePrices(priceInput.value);
    if (!prices.length) { msg(genMsg, '결제 금액을 하나 이상 입력하세요.', 'err'); return null; }
    if (!v('odate')) { msg(genMsg, '오픈 날짜를 입력하세요.', 'err'); return null; }
    // 시각을 비우면 자정(00:00)으로 해석되어 엉뚱한 때에 시작합니다.
    if (!v('otime')) { msg(genMsg, '오픈 시각을 입력하세요.', 'err'); return null; }
    return {
      prices: prices,
      sites: state.picked.slice(),
      names: state.picked.map(function (id) {
        var f = state.sites.filter(function (x) { return x.id === id; })[0];
        return f ? f.name : id;
      }),
      checkIn: { year: ci[0], month: ci[1], day: ci[2] },
      checkOut: { year: co[0], month: co[1], day: co[2] },
      adult: +v('adult'), teen: +v('teen'), child: +v('child'), car: +v('car'),
      name: v('name'), contact: v('contact'), carNo: v('carno'),
      openDate: v('odate'),
      openTime: v('otime').length === 5 ? v('otime') + ':00' : v('otime')
    };
  }

  function log(text, kind) {
    logBox.style.display = '';
    var line = h('div', { class: 'cfLine' + (kind ? ' ' + kind : '') }, [
      h('span', { class: 'ts' }, [clockTime.textContent]), text
    ]);
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  // ── 예약 실행 ──
  var H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

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

  function book(cfg, id, price) {
    return fetch(API + '/book', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        siteId: id, checkInDate: cfg.checkIn, checkoutDate: cfg.checkOut,
        numOfAdults: cfg.adult, numOfTeens: cfg.teen, numOfChildren: cfg.child,
        numOfCars: cfg.car, services: [], name: cfg.name, contact: cfg.contact,
        paymentMethod: 'bank', coupon: null, couponDiscount: 0, usePoint: 0,
        campingPass: null, carNumbers: cfg.carNo ? [cfg.carNo] : [],
        accommodationPrice: price, parkingPrice: 0, servicePrice: 0,
        hasTrailer: false, hasCampingCar: false, petCharge: 0, pets: [], provider: null
      })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; })
        .catch(function () { return { ok: r.ok, status: r.status, d: {} }; });
    });
  }

  var tryCount = 0;

  // 우선순위대로 한 바퀴 돌며 예약을 시도합니다.
  function round(cfg) {
    if (!running) return;
    tryCount++;
    var i = 0;

    (function next() {
      if (!running) return;
      if (i >= cfg.sites.length) {
        log('빈자리 없음 — ' + tryCount + '회차 완료, 재시도합니다');
        setTimeout(function () { round(cfg); }, 800);
        return;
      }
      var id = cfg.sites[i], nm = cfg.names[i];
      i++;

      // 두 경로를 동시에 씁니다.
      //  ① 미리 계산한 후보 금액들 — 왕복 1회라 빠릅니다.
      //  ② calculate로 받은 정확한 금액 — 한 박자 느리지만 확실합니다.
      // 후보가 맞으면 ①이 먼저 통과하고, 다 틀리면 ②가 뒤늦게라도 잡습니다.
      var done = false;
      var fails = [];   // 실패 사유를 모아 한 번에 보여줍니다.

      function attempt(price, via) {
        return book(cfg, id, price).then(function (res) {
          var okRes = res.ok && res.d.status !== 'fail';
          if (okRes && !done) {
            done = true;
            running = false;
            setBusy(false);
            log('예약 완료! ' + nm + ' — ' + price.toLocaleString() + '원 (' + via + ')', 'ok');
            msg(genMsg, '🎉 예약이 완료되었습니다 — ' + nm, 'ok');
            alert('예약이 완료되었습니다!\n' + nm + '\n' + price.toLocaleString() + '원');
          } else if (okRes) {
            // 이미 성공한 뒤 또 통과한 경우 — 중복 예약일 수 있습니다.
            log('⚠️ ' + price.toLocaleString() + '원도 통과 — 중복 예약 여부를 확인하세요', 'err');
          } else {
            var why = (res.d && (res.d.message || res.d.error || res.d.reason)) || ('HTTP ' + (res.status || '?'));
            fails.push({ price: price, via: via, why: String(why) });
          }
          return okRes;
        }).catch(function (e) {
          fails.push({ price: price, via: via, why: '요청 실패: ' + e.message });
          return false;
        });
      }

      var jobs = cfg.prices.map(function (price) { return attempt(price, '후보'); });

      // calculate 경로 — 응답이 오는 대로 그 금액으로 시도합니다.
      jobs.push(
        calc(cfg, id).then(function (r) {
          if (done || !running) return false;
          var exact = r.totalCharge || r.totalPrice || r.accommodationPrice;
          if (!exact) return false;
          // 후보로 이미 쏜 금액이면 다시 보내지 않습니다.
          if (cfg.prices.indexOf(exact) > -1) return false;
          log(nm + ' 정확한 금액 ' + exact.toLocaleString() + '원 확인', 'ok');
          return attempt(exact, 'calc');
        }).catch(function (e) {
          // 요금 조회가 막히는 것도 자리가 없다는 신호입니다.
          fails.push({ price: 0, via: 'calc', why: e.message });
          return false;
        })
      );

      Promise.all(jobs).then(function () {
        if (done || !running) return;

        // 같은 사유는 묶어서 한 줄로 보여줍니다.
        var byWhy = {};
        fails.forEach(function (f) {
          (byWhy[f.why] = byWhy[f.why] || []).push(f.price);
        });
        var keys = Object.keys(byWhy);
        if (!keys.length) {
          log(nm + ': 예약 실패 (사유 없음)', 'err');
        } else {
          keys.forEach(function (w) {
            // 금액이 0인 건 요금 조회 단계의 실패라 금액을 붙이지 않습니다.
            var ps = byWhy[w].filter(function (x) { return x > 0; });
            log(nm + ' — ' + w + (ps.length ? ' (' + ps.map(function (x) {
              return x.toLocaleString();
            }).join(', ') + '원)' : ''), 'err');
          });
        }
        next();
      });
    })();
  }

  function setBusy(on) {
    running = on;
    runBtn.style.display = on ? 'none' : '';
    stopBtn.style.display = on ? '' : 'none';
    if (!on) stopCountdown();
  }

  runBtn.addEventListener('click', function () {
    var cfg = collect();
    if (!cfg) return;

    logBox.innerHTML = '';
    tryCount = 0;
    setBusy(true);

    var target = openTarget(cfg.openDate, cfg.openTime);
    if (!target) {
      msg(genMsg, '오픈 날짜 형식이 올바르지 않습니다.', 'err');
      setBusy(false);
      return;
    }
    var left = target - serverNow();

    if (left <= 0) {
      // 이미 지난 일시라면 사용자가 날짜를 잘못 넣었을 가능성이 큽니다.
      // 옛날 날짜로 즉시 돌진하지 않도록, 최근 5분 이내일 때만 바로 시작합니다.
      if (left < -5 * 60 * 1000) {
        msg(genMsg, '오픈 일시가 이미 지났습니다 — ' + target.toLocaleString('ko-KR'), 'err');
        log('오픈 일시가 과거입니다. 날짜를 확인하세요.', 'err');
        setBusy(false);
        return;
      }
      msg(genMsg, '오픈 시각이 지나 즉시 시작합니다.', 'ok');
      log('즉시 시작');
      round(cfg);
      return;
    }

    startCountdown(target);
    msg(genMsg, '오픈까지 대기 중 — ' + target.toLocaleString('ko-KR'), 'ok');
    log('오픈까지 ' + Math.floor(left / 86400000) + '일 ' +
        Math.floor(left / 3600000 % 24) + '시간 ' +
        Math.floor(left / 60000 % 60) + '분 ' +
        Math.floor(left / 1000 % 60) + '초 대기');

    // 긴 setTimeout은 오차가 크므로 1초 전부터 짧은 간격으로 재확인합니다.
    setTimeout(function tick() {
      if (!running) return;
      if (serverNow() >= target) { log('오픈! 예약을 시작합니다', 'ok'); round(cfg); }
      else setTimeout(tick, 20);
    }, Math.max(left - 1000, 0));
  });

  stopBtn.addEventListener('click', function () {
    setBusy(false);
    log('중지했습니다');
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
      msg(genMsg, '복사했습니다. 콘솔에 붙여넣어 실행하세요.', 'ok');
    }).catch(function () {
      msg(genMsg, '아래 내용을 직접 복사하세요.', '');
    });
  });

  // 콘솔에 붙여넣어 직접 실행할 수 있는 스크립트를 만듭니다.
  function buildScript(c) {
    return [
      '// ===== 캠핏 예약 스크립트 =====',
      '// 캠핏에 로그인한 상태에서 콘솔에 붙여넣어 실행하세요.',
      '(async function () {',
      '    const C = ' + JSON.stringify(c, null, 4).replace(/\n/g, '\n    ') + ';',
      '',
      '    const T = window.localStorage.jwt;',
      '    if (!T) { alert("로그인이 필요합니다."); return; }',
      '    const H = { "Authorization": "Bearer " + T, "Content-Type": "application/json" };',
      '    const API = "https://api.camfit.co.kr/v1";',
      '',
      '    // 서버 시간 보정 — PC 시계가 어긋나 있어도 정확히 맞춥니다.',
      '    let off = 0;',
      '    try {',
      '        const t0 = Date.now();',
      '        const r = await fetch(API + "/camps/search/autocomplete?search=" + t0, { cache: "no-store" });',
      '        const t1 = Date.now(), hd = r.headers.get("Date");',
      '        if (hd) { off = new Date(hd).getTime() + (t1 - t0) / 2 - t1; }',
      '        console.log("서버 시간 보정", (off / 1000).toFixed(1) + "초");',
      '    } catch (e) { console.warn("시간 동기화 실패 — 로컬 시계 사용"); }',
      '    const now = () => new Date(Date.now() + off);',
      '',
      '    const calc = (id) => fetch(API + "/booking/calculate", {',
      '        method: "POST", headers: H,',
      '        body: JSON.stringify({',
      '            siteId: id, checkInDate: C.checkIn, checkoutDate: C.checkOut,',
      '            numOfAdults: C.adult, numOfTeens: C.teen, numOfChildren: C.child,',
      '            numOfCars: C.car, services: [], hasTrailer: false, hasCampingCar: false, pets: []',
      '        })',
      '    }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message); return d; });',
      '',
      '    const book = (id, price) => fetch(API + "/book", {',
      '        method: "POST", headers: H,',
      '        body: JSON.stringify({',
      '            siteId: id, checkInDate: C.checkIn, checkoutDate: C.checkOut,',
      '            numOfAdults: C.adult, numOfTeens: C.teen, numOfChildren: C.child,',
      '            numOfCars: C.car, services: [], name: C.name, contact: C.contact,',
      '            paymentMethod: "bank", coupon: null, couponDiscount: 0, usePoint: 0,',
      '            campingPass: null, carNumbers: C.carNo ? [C.carNo] : [],',
      '            accommodationPrice: price, parkingPrice: 0, servicePrice: 0,',
      '            hasTrailer: false, hasCampingCar: false, petCharge: 0, pets: [], provider: null',
      '        })',
      '    }).then(async r => ({ ok: r.ok, status: r.status, d: await r.json().catch(() => ({})) }));',
      '',
      '    let stop = false;',
      '    window.stopCf = () => { stop = true; console.log("중지했습니다."); };',
      '',
      '    async function round(n) {',
      '        for (let i = 0; i < C.sites.length; i++) {',
      '            if (stop) return true;',
      '            let done = false;',
      '',
      '            const fails = [];   // 실패 사유를 모아 한 번에 보여줍니다.',
      '            const attempt = async (price, via) => {',
      '                try {',
      '                    const res = await book(C.sites[i], price);',
      '                    const ok = res.ok && res.d.status !== "fail";',
      '                    if (ok && !done) {',
      '                        done = true;',
      '                        console.log("%c예약 완료! " + C.names[i] + " — " + price + "원 (" + via + ")",',
      '                                    "color:#2d7d46;font-size:16px;font-weight:bold");',
      '                        alert("예약이 완료되었습니다!\\n" + C.names[i] + "\\n" + price + "원");',
      '                    } else if (ok) {',
      '                        console.warn("⚠️ " + price + "원도 통과 — 중복 예약 여부를 확인하세요");',
      '                    } else {',
      '                        const why = res.d?.message || res.d?.error || ("HTTP " + res.status);',
      '                        fails.push({ price, why: String(why) });',
      '                    }',
      '                    return ok;',
      '                } catch (e) { fails.push({ price, why: "요청 실패: " + e.message }); return false; }',
      '            };',
      '',
      '            // 후보 금액(빠름)과 calculate로 받은 정확한 금액(확실)을 동시에 씁니다.',
      '            const jobs = C.prices.map(p => attempt(p, "후보"));',
      '            jobs.push((async () => {',
      '                try {',
      '                    const r = await calc(C.sites[i]);',
      '                    if (done || stop) return false;',
      '                    const exact = r.totalCharge || r.totalPrice || r.accommodationPrice;',
      '                    if (!exact || C.prices.includes(exact)) return false;',
      '                    console.log(C.names[i] + " 정확한 금액 " + exact + "원 확인");',
      '                    return attempt(exact, "calc");',
      '                } catch (e) { return false; }',
      '            })());',
      '',
      '            await Promise.all(jobs);',
      '            if (done) return true;',
      '',
      '            // 같은 사유는 묶어서 한 줄로 보여줍니다.',
      '            const byWhy = {};',
      '            fails.forEach(f => (byWhy[f.why] = byWhy[f.why] || []).push(f.price));',
      '            Object.keys(byWhy).forEach(w => {',
      '                const ps = byWhy[w].filter(x => x > 0);',
      '                console.log(C.names[i] + " — " + w + (ps.length ? " (" + ps.join(", ") + "원)" : ""));',
      '            });',
      '        }',
      '        console.log("빈자리 없음 — " + n + "회차 완료");',
      '        return false;',
      '    }',
      '',
      '    // 오픈 일시(년월일 + 시분초)까지 대기합니다.',
      '    const [yy, mo, dd] = C.openDate.split("-").map(Number);',
      '    const [hh, mm, ss] = C.openTime.split(":").map(Number);',
      '    if ([yy, mo, dd, hh, mm].some(Number.isNaN)) {',
      '        console.log("오픈 날짜/시각이 올바르지 않습니다:", C.openDate, C.openTime);',
      '        return;',
      '    }',
      '    const target = new Date(yy, mo - 1, dd, hh, mm, ss || 0, 0);',
      '    const left = target - now();',
      '',
      '    // 5분 넘게 지난 일시면 날짜를 잘못 넣은 것으로 보고 중단합니다.',
      '    if (left < -5 * 60 * 1000) {',
      '        console.log("오픈 일시가 이미 지났습니다 — " + target.toLocaleString("ko-KR") + ". 날짜를 확인하세요.");',
      '        return;',
      '    }',
      '',
      '    if (left > 0) {',
      '        const d = Math.floor(left / 86400000), hR = Math.floor(left / 3600000 % 24);',
      '        console.log("오픈 " + target.toLocaleString("ko-KR") + " — " + (d ? d + "일 " : "") + hR + "시간 " + Math.floor(left / 60000 % 60) + "분 " + Math.floor(left / 1000 % 60) + "초 남음 — 중지하려면 stopCf()");',
      '        await new Promise(res => {',
      '            setTimeout(function tick() {',
      '                if (stop || now() >= target) return res();',
      '                setTimeout(tick, 20);',
      '            }, Math.max(left - 1000, 0));',
      '        });',
      '    }',
      '',
      '    console.log("예약을 시작합니다 — 중지하려면 stopCf()");',
      '    let n = 0;',
      '    while (!stop) {',
      '        if (await round(++n)) break;',
      '        await new Promise(r => setTimeout(r, 800));',
      '    }',
      '})();'
    ].join('\n');
  }

  // ── 시작 ──
  // 캠핑장 상세 페이지에서 열었으면 검색을 건너뜁니다.
  if (!enterFromUrl()) searchInput.focus();
})();
