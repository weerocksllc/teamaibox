<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.ko.md)
<!-- doc-navigation:end -->

# 공개 제품 스크린샷

이는 실제 Team AI Box 워크벤치 캡처로, 17개 UI 로케일 각각에 대한 밝은 이미지 하나와 어두운 이미지 하나입니다. 이는 개인 마케팅 웹사이트의 소스, 템플릿 또는 빌드 출력이 아닌 제품 문서 자산입니다.

## 캡처 규칙

- 실제 제품 언어 및 테마 컨트롤을 사용합니다. 라벨을 영어 스크린샷으로 번역하거나 성공적인 결과를 만들어내지 마세요.
- 데모 계정을 사용하여 모든 이미지에서 개인 메시지, 파일 이름, 자격 증명, 수신자 PIN, 네트워크 주소 및 브라우저 크롬을 검사하세요. 로그인된 게스트 디스크나 이미지가 포함된 세션/쿠키 내보내기를 게시하지 마세요.
- 현재 워크벤치 캡처에는 일반 데모 작업 상태와 일반 관리자 계정만 표시됩니다. 작업 페이로드를 노출하지 않습니다.
- 제품 설정을 캡쳐 후 그대로 유지하세요. 스크린샷을 얻기 위해 사용자 데이터를 삭제하거나 비즈니스 워크로드를 다시 실행하지 마세요.
- `workbench-light.jpg` and `workbench-dark.jpg`가 원본입니다. 대부분은 전체 페이지 캡처를 사용합니다. 브라우저의 전체 페이지 RTL 캡처가 페이지를 대체했기 때문에 아랍어는 실제 뷰포트를 사용합니다. 라벨이나 결과는 변경되지 않았습니다.
- 일부 라이브 작업 상태 단어는 현지화된 보기에서는 여전히 영어입니다. 이러한 이미지는 배송된 UI를 수정하는 대신 의도적으로 보존합니다. 게스트 운영 체제, 모델 응답 및 사용자 정의 이름은 별도의 언어 설정을 가지며 UI 선택기로 번역되지 않습니다.

README 렌더러는 모든 제품 로케일에 대해 두 이미지를 모두 요구하며 자동으로 영어 스크린샷으로 돌아가는 대신 실패합니다. UI를 새로 고칠 때 두 테마를 모두 바꾸고 이미지 매니페스트를 `node tools/screenshot-manifest.mjs`로 다시 생성합니다. 네트워크/장치 식별자와 로컬 캡처 로그를 이 공개 디렉터리에 보관하세요.
