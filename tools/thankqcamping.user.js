// ==UserScript==
// @name         땡큐캠핑 예약 자동화
// @namespace    https://m.thankqcamping.com/
// @version      1.0
// @description  예약 오픈 시각에 맞춰 진입 → 사이트 선택 → 예약 정보 입력까지 자동 진행
// @match        https://m.thankqcamping.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ────────────────────────── 설정 ──────────────────────────
    // 예약 때마다 여기만 고치면 됩니다.
    const CONFIG = {
        // 예약 실행일 (이 날짜가 아니면 스크립트는 아무것도 하지 않음)
        runDate: '2026-09-01',
        // 예약 오픈 시각
        openTime: '14:00:00',
        // openTime 이후 몇 분 동안만 동작할지 (지나면 자동 정지)
        activeWindowMin: 10,

        // 예약 대상
        booking: {
            campseq: '16706',
            campsiteseq: '116159',
            res_dt: '20260912',      // 입실일
            res_edt: '20260914',     // 퇴실일
            res_path: 'HM',
            enter_path: '',
            temporary_yn: '',
            wg_pass: 'N',
        },

        // 사이트 번호 우선순위 (앞쪽이 1순위)
        siteNumbers: [5, 23, 25, 3, 53, 1, 27, 29, 51],

        // 예약 정보
        carNo: '',              // 예: '12가3456'
        specDisc: 4,

        // 사이트를 못 찾았을 때 재조회 설정
        retry: {
            maxAttempts: 60,   // 최대 재조회 횟수
            intervalMs: 500,   // 재조회 간격
        },
    };
    // ──────────────────────────────────────────────────────────

    const log = (...args) => console.log('[캠핑]', ...args);

    // ── 실행 조건 확인: 지정한 날짜/시간대가 아니면 즉시 종료 ──
    function withinActiveWindow() {
        const now = new Date();
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (today !== CONFIG.runDate) return false;

        const open = openTimeToday();
        const end = new Date(open.getTime() + CONFIG.activeWindowMin * 60 * 1000);
        // 오픈 10분 전부터 활성화 (①단계 타이머를 걸어둘 여유)
        const start = new Date(open.getTime() - 10 * 60 * 1000);
        return now >= start && now <= end;
    }

    function openTimeToday() {
        const [h = 0, m = 0, s = 0] = CONFIG.openTime.split(':').map(Number);
        const t = new Date();
        t.setHours(h, m, s, 0);
        return t;
    }

    // 개발자도구 감지기 무력화 (있을 때만)
    function stopDevtoolsDetector() {
        try { window.devtoolsDetector.stop(); } catch {}
    }

    // ── ① 예약 페이지 진입: hidden form POST ──
    function submitBookingForm() {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = 'https://m.thankqcamping.com/booking/resStep.hbb';

        for (const [name, value] of Object.entries(CONFIG.booking)) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.appendChild(input);
        }

        document.body.appendChild(form);
        form.submit();
    }

    // 오픈 시각에 맞춰 ①단계 예약
    function scheduleEntry() {
        const now = new Date();
        const target = openTimeToday();

        if (now >= target) {
            log('⚡ 오픈 시각이 지났습니다. 즉시 진입합니다.');
            submitBookingForm();
            return;
        }

        const delay = target - now;
        log(`⏰ 오픈까지 ${Math.floor(delay / 60000)}분 ${Math.floor((delay / 1000) % 60)}초`);
        log(`📅 진입 예정: ${target.toLocaleString('ko-KR')}`);

        // 긴 setTimeout은 오차가 커서, 1초 전까지만 대기한 뒤
        // 마지막 구간은 짧은 간격으로 시각을 재확인합니다.
        const coarse = Math.max(delay - 1000, 0);
        setTimeout(function tick() {
            if (new Date() >= openTimeToday()) {
                log('🚀 진입!');
                submitBookingForm();
            } else {
                setTimeout(tick, 20);
            }
        }, coarse);
    }

    // ── ② 사이트 선택 ──
    // 우선순위대로 훑어서 예약 가능한(=End 클래스가 없는) 첫 사이트를 클릭합니다.
    function pickSite() {
        const container = document.querySelector('#DivCampSiteNo');
        if (!container) return false;   // 이 페이지가 아님

        // DOM을 한 번만 읽어 번호 → 엘리먼트로 매핑
        const byNumber = new Map();
        for (const el of container.querySelectorAll('.flex_item')) {
            const title = el.querySelector('.tit');
            if (title) byNumber.set(title.textContent.trim(), el);
        }

        for (const siteNo of CONFIG.siteNumbers) {
            const el = byNumber.get(String(siteNo));
            if (!el) continue;

            if (el.classList.contains('End')) {
                log(`❌ ${siteNo}번 예약완료`);
                continue;
            }

            log(`✅ ${siteNo}번 예약 가능! 클릭합니다.`);
            el.click();
            goResDetTq();
            return true;
        }

        return false;   // 페이지는 맞는데 가능한 사이트가 없음
    }

    // 사이트 목록만 ajax로 갈아끼웁니다.
    // 응답 구조가 확인되지 않은 경로라, 실패하면 새로고침으로 넘어갑니다.
    async function refreshSiteList() {
        const body = new URLSearchParams({
            campseq: CONFIG.booking.campseq,
            campsiteseq: CONFIG.booking.campsiteseq,
            res_dt: CONFIG.booking.res_dt,
            res_edt: CONFIG.booking.res_edt,
            site_no_tp: 'Y',
            site_cnt: '41',
            resno_week: '',
            twobak_yn: 'N',
        });

        const res = await fetch('https://m.thankqcamping.com/booking/axCampSiteNo.hbb', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body,
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const html = await res.text();
        const container = document.querySelector('#DivCampSiteNo');
        if (!container) throw new Error('#DivCampSiteNo 없음');

        // 응답이 컨테이너를 통째로 포함하면 그 안쪽만, 아니면 응답 전체를 씁니다.
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        const fresh = parsed.querySelector('#DivCampSiteNo');
        const markup = fresh ? fresh.innerHTML : html;

        if (!markup.includes('flex_item')) throw new Error('사이트 목록이 응답에 없음');
        container.innerHTML = markup;
    }

    // 사이트를 찾을 때까지 재조회를 반복합니다.
    async function pickSiteWithRetry() {
        for (let attempt = 1; attempt <= CONFIG.retry.maxAttempts; attempt++) {
            if (new Date() > new Date(openTimeToday().getTime() + CONFIG.activeWindowMin * 60000)) {
                log('⏹ 활성 시간이 끝나 중단합니다.');
                return;
            }

            log(`⚠️ 가능한 사이트 없음. 재조회 ${attempt}/${CONFIG.retry.maxAttempts}`);
            await new Promise(r => setTimeout(r, CONFIG.retry.intervalMs));

            try {
                await refreshSiteList();
            } catch (e) {
                // ajax가 안 먹히면 새로고침으로 대체 (이 함수는 여기서 끝남)
                log('ajax 재조회 실패 → 새로고침으로 전환:', e.message);
                location.reload();
                return;
            }

            if (pickSite()) return;   // 찾아서 클릭 완료
        }

        log('⏹ 재조회 횟수를 모두 소진했습니다.');
    }

    // ── ③ 예약 정보 입력 ──
    function fillReservation() {
        if (!document.querySelector('#car_no')) return false;   // 이 페이지가 아님

        log('📝 예약 정보를 입력합니다.');
        $('#car_no').val(CONFIG.carNo);
        clkSpecDisc(CONFIG.specDisc);
        $('#agree_all, #resp_agree_1').click();
        SavResDetOk();
        return true;
    }

    // ── 진입점 ──
    // 사이트 목록은 ajax로 나중에 그려지므로, 페이지 로드 직후에는 아직 비어 있습니다.
    // DOM을 감시하다가 각 단계의 표식이 실제로 나타나는 순간 해당 단계를 실행합니다.
    function run() {
        if (!withinActiveWindow()) return;

        stopDevtoolsDetector();

        let done = false;          // 모든 단계 종료 (감시 중단)
        let sitePicked = false;    // ②를 이미 처리했는지
        const finish = () => { done = true; observer.disconnect(); clearTimeout(fallback); };

        // 지금 DOM 상태로 실행 가능한 단계가 있으면 실행합니다.
        function tryStages() {
            if (done) return true;

            // ③ 예약 정보 입력 페이지 — 마지막 단계이므로 여기서 감시 종료
            try {
                if (document.querySelector('#car_no')) {
                    finish();
                    fillReservation();
                    return true;
                }
            } catch (e) { log('③ 건너뜀:', e.message); }

            // ② 사이트 선택 페이지 — 목록이 실제로 채워졌을 때만.
            // 클릭 후 ③이 ajax로 그려질 수 있으므로 감시는 계속 유지합니다.
            if (!sitePicked) {
                try {
                    const box = document.querySelector('#DivCampSiteNo');
                    if (box && box.querySelector('.flex_item')) {
                        sitePicked = true;
                        clearTimeout(fallback);   // ①로 잘못 빠지지 않도록
                        if (!pickSite()) pickSiteWithRetry();
                        return true;
                    }
                } catch (e) { log('② 건너뜀:', e.message); }
            }

            return false;
        }

        // 렌더링이 끝난 뒤 나타나는 요소를 놓치지 않도록 DOM 변화를 감시합니다.
        const observer = new MutationObserver(tryStages);
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // ②③ 어느 쪽도 나타나지 않으면 대기 페이지로 보고 ①단계(진입)를 예약합니다.
        // ajax 렌더링을 기다려야 하므로 즉시 판단하지 않고 잠시 여유를 둡니다.
        const fallback = setTimeout(() => {
            if (done) return;
            finish();
            try {
                scheduleEntry();
            } catch (e) { log('① 건너뜀:', e.message); }
        }, 1500);

        // 이미 그려져 있는 경우를 대비해 한 번 즉시 확인
        tryStages();
    }

    run();
})();
