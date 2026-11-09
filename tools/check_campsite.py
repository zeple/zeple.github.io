#!/usr/bin/env python3
"""
땡큐캠핑 axCampSiteNo 엔드포인트 요청 검사용 스크립트 (유지보수/점검 목적)

기본은 dry-run: 실제 요청을 보내지 않고 구성될 요청만 출력합니다.
실제 전송은 --send 플래그를 명시할 때만 수행합니다.
가능하면 --url 로 본인 스테이징 환경을 지정해 테스트하세요.
"""
import argparse
import sys

import requests  # pip install requests


DEFAULT_URL = "https://m.thankqcamping.com/booking/axCampSiteNo.hbb"

# 확인된 파라미터. 의미는 추정치이므로 실제 스펙과 대조하세요.
DEFAULT_PARAMS = {
    "campseq":     "16706",      # 캠핑장 ID
    "campsiteseq": "116159",     # 개별 사이트 ID
    "res_dt":      "20260908",   # 입실일
    "res_edt":     "20260909",   # 퇴실일
    "site_no_tp":  "Y",
    "site_cnt":    "41",         # 총 사이트 수(추정)
    "resno_week":  "",           # 주중/주말 구분(추정)
    "twobak_yn":   "N",          # 2박 여부(추정)
}


def build_headers(cookie):
    headers = {
        "User-Agent": "Mozilla/5.0 (maintenance-check)",
        "X-Requested-With": "XMLHttpRequest",  # .hbb ajax 엔드포인트로 추정
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": "https://m.thankqcamping.com/",
    }
    # 이 엔드포인트는 로그인 세션 쿠키가 없으면 정상 응답이 안 나올 가능성이 큽니다.
    if cookie:
        headers["Cookie"] = cookie
    return headers


def main():
    p = argparse.ArgumentParser(description="axCampSiteNo POST 요청 검사")
    p.add_argument("--url", default=DEFAULT_URL,
                   help="대상 URL (기본: 라이브. 가능하면 스테이징 URL 지정)")
    p.add_argument("--cookie", default=None,
                   help="인증 세션 쿠키 문자열 (예: 'JSESSIONID=...')")
    p.add_argument("--send", action="store_true",
                   help="실제로 요청을 전송. 없으면 dry-run(전송 안 함)")
    p.add_argument("--timeout", type=float, default=10.0)
    # 개별 파라미터 오버라이드 허용
    for k, v in DEFAULT_PARAMS.items():
        p.add_argument(f"--{k}", default=v)
    args = p.parse_args()

    params = {k: getattr(args, k) for k in DEFAULT_PARAMS}
    headers = build_headers(args.cookie)

    print("=== 구성된 요청 ===")
    print(f"POST {args.url}")
    for k, v in headers.items():
        shown = v if k != "Cookie" else "<hidden>"
        print(f"  {k}: {shown}")
    print("  body:")
    for k, v in params.items():
        print(f"    {k}={v}")
    print()

    if not args.send:
        print("[dry-run] --send 가 없어 실제 전송하지 않았습니다.")
        print("          라이브가 아닌 본인 스테이징에서 먼저 --send 로 확인하세요.")
        return 0

    if args.url == DEFAULT_URL:
        print("[경고] 라이브 URL로 전송하려 합니다.")
        ans = input("       계속하려면 'yes' 입력: ").strip().lower()
        if ans != "yes":
            print("       중단했습니다.")
            return 1

    resp = requests.post(args.url, data=params, headers=headers, timeout=args.timeout)
    print(f"=== 응답 {resp.status_code} ===")
    print(f"Content-Type: {resp.headers.get('Content-Type')}")
    print(resp.text[:2000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
