<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.ko.md)
<!-- doc-navigation:end -->

# 기여

Team AI Box 개선에 도움을 주셔서 감사합니다. 버그 보고서, 번역, 문서화, 접근성, 애플리케이션 통합 및 집중적인 코드 변경 등 모든 것이 중요합니다. 독립적으로 확인할 수 있는 문서나 구성 요소를 개선하기 위해 DGX Spark가 필요하지 않습니다.

## 아이디어에서 끌어오기 요청까지

1. [기존 문제](https://github.com/weerocksllc/teamaibox/issues)를 검색하세요. 사용자 문제, 예상되는 동작, 실제 동작 및 관련 버전을 설명합니다. 구현에 투자하기 전에 더 큰 변경 사항에 대해 논의하세요.
2. 공용 저장소를 포크하고 포크를 복제합니다. 집중된 분기를 만듭니다. 비공개 마케팅 웹사이트, 런타임 데이터 또는 다운로드한 모델은 포함하지 마세요.
3. 노드, pnpm 및 로컬 구성 요소 빌드에 대해서는 [BUILDING](docs/open-source/BUILDING.ko.md)을 따르세요. 신규 어플라이언스 설치 프로그램은 다른 워크플로우입니다. 단지 UI 개발을 위해 비즈니스 데이터가 포함된 시스템에서 실행하지 마십시오.
4. 최소한의 일관성 있는 변경을 수행하고, 영향을 받는 문서를 업데이트하고 관련 검사를 실행합니다. 실행할 수 없는 하드웨어 종속 검사에 대해 설명하십시오.
5. 문제, 해결책, 호환성 영향 및 점검 사항을 설명하는 풀 요청을 엽니다. 눈에 띄는 변경 사항을 확인하려면 삭제된 스크린샷을 포함하세요. 리뷰 피드백에 응답합니다. 관리자는 병합하기 전에 검토합니다.

로컬 OpenSpec 작업공간은 선택사항이며 이 저장소에 게시되지 않습니다. 공공 기여자는 이슈나 PR에 직접 제안과 승인 기준을 넣을 수 있습니다. 참여하기 위해 누락된 개인 사양이 필요하지 않습니다.

## 번역 및 스크린샷

상세 기능 목록을 수정하려면 `docs/readme-features/<locale>.json`을 편집하고, 그룹·항목 ID와 순서를 영어판과 일치시키며, `docs/readme-features/evidence.json`의 소스 참조도 관리하세요.

17개 제품 언어 모두 README가 있습니다. `docs/readme-locales/<locale>.json`를 편집한 후 `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`를 실행하세요. 생성된 README를 직접 편집하지 마십시오. 로케일 목록은 `packages/ui-system/src/locale-registry.mjs`에서 제공됩니다. 링크된 설치, 빌드, 기여, 보안 및 라이선스 가이드는 동일한 17개 언어를 사용합니다. 해당 문서 목록은 `docs/document-locales/manifest.json`에 있습니다. `docs/document-locales/<locale>.json`에서 원어 페이지와 단락 번역을 편집한 후 `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`를 실행합니다. 번역 키는 소스 단락의 SHA-256 해시입니다. 해당 번역이 업데이트될 때까지 소스 변경으로 인해 렌더러가 실패합니다. 코드 예제는 그대로 공유되며 선택한 언어에 대한 문서 링크가 생성됩니다. 새로운 번역은 보호된 코드와 링크가 포함된 기계 지원 초안입니다. 언어 및 용어 검토를 환영합니다. 생성 및 검사는 번역 서비스, API 키 또는 어플라이언스에 대한 액세스 없이 로컬에서 실행됩니다. 공개 이미지를 추가하기 전에 [스크린샷 정책](docs/assets/screenshots/README.ko.md)을 참조하세요. 용어 및 자연스러운 표현을 포함한 번역은 리뷰 기여를 환영합니다.

## 기여 규칙

- 원본 기여는 저장소의 MIT 라이선스에 따라 제출됩니다. 제3자 헤더를 보존하고 복사된 자료의 출처/라이센스를 명시하세요. 별도의 필수 CLA 또는 유료 기여자 권한이 필요하지 않습니다.
- Node 24와 `package.json`에 고정된 pnpm 버전을 사용하세요. Python 및 Go 요구 사항은 [빌딩](docs/open-source/BUILDING.ko.md)에 설명되어 있습니다.
- 변경 사항과 관련된 테스트만 실행하고 실행된 내용을 정확하게 보고하세요. 로컬 고정 장치는 실제 장치 승인을 의미하지 않습니다. 단지 문서 변경을 완료하기 위해 과거 승인 결과를 반복하거나 삭제하지 마십시오.
- 사용자 데이터에 대해 삭제, 재설치 또는 복구를 테스트하지 마십시오. 합성 설비나 명시적으로 지정된 임시 자원을 사용하십시오.
- 이슈/PR에는 개인 키, 토큰, 쿠키, 고객 프롬프트/파일, 로그인한 게스트 이미지, 개인 배포 스냅샷 또는 개인 스크린샷이 없습니다. 비공개 보고는 [보안](SECURITY.ko.md)을 참조하세요.
- 작업공간 패키지에 `private: true`를 유지합니다. 공유 Git 기록을 다시 작성하거나, 전달 태그를 이동하거나, PR의 일부로 비공개 빌드 아티팩트를 게시하지 마세요.

기여 시 관련 테스트, 마이그레이션 및 동작 변경 사항을 문서화하세요. 하드웨어 종속 검사에서는 실제 구성과 제한을 식별해야 합니다.
