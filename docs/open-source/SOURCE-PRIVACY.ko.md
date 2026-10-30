<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.ko.md)
<!-- doc-navigation:end -->

# 공개 소스 개인 정보 보호 경계

공개 제품 저장소는 비공개 개발 기록의 미러가 아닌 새로운 소스 스냅샷입니다. 마케팅 웹사이트에는 자체 개인 저장소가 있으며 여기에는 포함되지 않습니다.

## 삭제된 자료

- 배포 테스트 계정 이름과 비밀번호, 개인 계정 목록이 수정되었습니다.
- 기록 장치 ID를 기록하거나 개인 증거의 결과를 주장하는 단일 장치 배포/복구 래퍼 및 스크립트입니다.
- 실제 호스트 주소, 홈 디렉터리, 컨테이너/장치 ID 및 기록 유지 관리 스냅샷. 유지된 테스트는 명시적으로 합성 픽스처를 사용합니다. 유지 관리되는 운영 도구에는 명시적인 목표 입력이 필요합니다.
- 게스트 디스크, Android 로그인 상태, 브라우저 세션, 설치 패키지, 모델 가중치 및 개인 증거는 공개 소스 배포 외부에 있습니다.

개인 아카이브와 원본 배송 태그는 그대로 유지됩니다. 이 소스 정리에서는 어플라이언스 계정, 게스트 데이터, 실행 중인 서비스 또는 웹 사이트 배포를 변경하지 않습니다. `admin / admin` 공장 기본값은 의도적으로 유지됩니다. 개인 자격 증명이 아닙니다. 관리자는 노출 전에 이를 변경해야 합니다.

## 검토 및 검증

게시 중인 저장소에서 작업 트리와 도달 가능한 모든 커밋/태그를 모두 검토하세요. Gitleaks와 `tools/open_source_sensitive.py`를 사용하세요. 이것만으로는 엔트로피가 낮은 비밀번호나 개인 메타데이터가 없다는 증거가 아닙니다. 커밋된 테스트 픽스처가 아닌 비공개 외부 거부 목록을 사용하여 확인된 이전 비공개 값을 비교하세요. 테스트 파일을 포함하여 나머지 결과를 개별적으로 검토합니다.

정리 검사는 소스 정책, 합성 회귀, 구성 및 구문 검사입니다. 그들은 발견된 자격 증명을 사용하여 로그인하지 않으며, 상자를 다시 설치하거나 제품 승인을 반복하지 않습니다. 이전 API 패키징 수정 사항(공유 UI 소스 및 가져오기 전용 진입점 확인 포함)은 소스에 남아 있습니다.

새 클론은 폐기된 커밋, 참조 또는 태그를 가져오면 안 됩니다. 저장소를 삭제해도 다른 사람이 이미 다운로드한 복사본은 회수되지 않습니다. 알 수 없는 자격 증명이 복사되지 않았음을 확인할 수 있는 스캔은 없습니다. 실제로 사용된 자격 증명은 해당 운영자가 교체해야 합니다. 이 정리는 회전했다고 주장하지 않습니다.

소스 내보내기 및 검토 지침은 [RELEASING.md](RELEASING.ko.md)를 참조하고, 빌드 전제 조건 및 별도로 획득한 자산은 [BUILDING.md](BUILDING.ko.md)를 참조하세요.
