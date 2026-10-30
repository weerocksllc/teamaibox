<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.ko.md)
<!-- doc-navigation:end -->

# 릴리스 경계

## 별도의 아티팩트

1. **MIT 소스 후보**: 원본 코드, 현재 사양, 검토된 빌드/테스트 도구 및 공지 사항; Git 기록이나 개인 실험실 증거가 없습니다.
2. **제3자 자료**: 자체 라이센스 및 속성이 있는 정확한 업스트림 소스/바이너리/모델. Copyleft 소스 의무는 바이너리와 함께 이동합니다.
3. **완전한 오프라인 어플라이언스 패키지**: `install/`에 의해 구축됨; 공개 재배포에 대한 라이선스가 자동으로 부여되지 않습니다. GMS, HunyuanOCR, NVIDIA 구성 요소 및 게스트/펌웨어 라이선스에는 아티팩트별 검토가 필요합니다. MIT 라벨 아래에 비공개 패키지, 모델 번들 또는 로그인 이미지를 게시하지 마세요.
4. **마케팅 웹사이트**: 기사 템플릿, 콘텐츠, 디자인 자산, 분석 및 배포 구성을 포함한 `website/`는 비공개 `weerocksllc/teamaibox.com` GitHub 저장소에 유지됩니다. GitLab은 웹사이트 개발 저장소가 아닌 기록 보관소입니다. 웹사이트는 공개 제품 소스 배포의 일부가 아닙니다. `apps/`의 어플라이언스 브라우저 UI는 오픈 소스 제품의 일부로 남아 있습니다.

과거의 단일 장치 배포, 복구 및 증거 기록 스크립트는 재사용 가능한 제품 도구가 아닙니다. 릴리스 정책에서는 폐기된 스크립트와 스냅샷을 제외합니다. 개인 아카이브에서 복원하지 마십시오. 보유 도구에는 개발자의 호스트, 계정, 컨테이너 또는 증거 파일 대신 명시적인 운영자 제공 대상이 필요합니다. Gitleaks뿐만 아니라 추가 민감 스캔을 실행하십시오. 장치 ID, 컨테이너 ID, GSF 해시 및 개인 계정 이름은 사용할 수 없는 로그인 자격 증명인 경우에도 메타데이터를 테스트합니다. 공개 기록 정리에는 명시적인 소유자 승인이 필요하며 개인 아카이브 또는 해당 배달 태그를 다시 작성해서는 안 됩니다. 승인된 재작성 후에는 폐기된 기록을 유지관리 저장소에 다시 병합하는 대신 새로운 공개 복제본을 사용하세요.

내부 개발 저장소와 해당 태그는 그대로 유지됩니다. 접근 가능한 기록에는 이전 배포 기록과 폐기된 독점 SDK 자산이 포함되어 있습니다. 변경되지 않은 상태로 공개되어서는 안 됩니다. 새로 내보낸 트리는 원래 전달 기록을 자동으로 다시 작성하지 않고 공개 시작점을 제공합니다.

## 현지 준비

공식 GitHub 릴리스에서 다운로드한 **Gitleaks 8.30.1**을 사용하고 체크섬을 확인하세요. 감사 도구는 시스템 패키지를 설치하거나 데이터를 업로드하지 않습니다. 비공개 출력은 공개 PR이 아닌 무시된 `.runtime/open-source-audit/`에 들어갑니다.

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

출력은 새로운 경로여야 합니다. 도구는 이전 후보를 덮어쓰지 않습니다. 수정된 위치를 검토할 뿐 아니라 중요한 위치도 검토하세요. 합성 설비, 공용 부트스트랩 자격 증명, 식별자 오탐지 및 실제/가능한 개인 자격 증명을 별도로 문서화합니다. 패턴 스캔은 자격 증명이나 OCR 스크린샷을 확인할 수 없습니다. 바이너리 아티팩트는 제외되며 검사 완료로 선언되지 않습니다. 소스 내보내기는 [release-policy.json](release-policy.json)에서 Git에 알려진 파일과 추적되지 않은 명시적인 입력만 허용합니다. 추적되지 않은 새로운 입력은 검토가 필요합니다. 심볼릭 링크와 경로 탐색을 거부하고 파일별 SHA-256과 제외 항목을 내보냅니다. `website/`는 추적되거나 추적되지 않은 입력으로 나열되는 경우에도 항상 제외됩니다. 비공개 저장소의 `.git` 디렉터리를 공개 체크아웃에 복사하지 마세요. 게시하기 전에 트리와 도달 가능한 모든 공개 커밋에 웹 사이트 파일이 없는지 확인하세요. 이후 커밋에서 파일을 삭제해도 이전 기록은 제거되지 않습니다.

보충 검사에는 도달 가능한 커밋/태그 메시지, 낮은 엔트로피 자격 증명 및 로그인 리터럴, 장치 ID 및 개발 주소가 포함됩니다. 테스트는 자동으로 면제되지 않습니다. 유지된 각 고정 장치가 왜 합성인지 설명하십시오. 알려진 비공개 값은 `{id, value, word?}` 레코드의 외부 JSON 배열로 `--denylist`와 함께 제공될 수 있습니다. 불투명하고 민감하지 않은 ID를 사용하십시오. 이 파일을 소스 체크아웃 외부에 보관하세요. 보고서에는 위치와 해시가 표시되며 값은 표시되지 않습니다. 알려진 마커가 일치하면 검사가 실패합니다. 청소하는 동안 `--scope worktree`를 사용하세요. 게시하기 전에 상위 없는 새 릴리스 저장소에서 `--scope all`를 검사하세요. 오래된 역사나 비공개 검토 보고서를 게시하지 마십시오.

유일한 의도적 공장 관리자 기본값은 `admin / admin`입니다. 배포 중에 변경하세요. 배포/브라우저 테스트 도구는 보호된 로컬 입력을 통해 기존 계정 자격 증명을 받아야 합니다. 새로 생성된 연기 테스트 계정은 임의의 자격 증명을 사용하며 정리 중에 비활성화됩니다. 실패한 정리는 성공적인 실행이 아니라 테스트 실패입니다. 갑작스러운 프로세스 종료로 인해 정리가 방해될 수 있습니다. 운영자는 그러한 중단 이후 임시 계정을 조정해야 합니다. 현재 테스트 자격 증명이 유효하다고 주장하는 공개 문서는 없습니다.

유지 관리되는 `install/` 진입점만 클린 어플라이언스 설치 경로입니다. 구성요소 소유권 평가는 [OWNERSHIP.md](OWNERSHIP.ko.md)에 있습니다.

여기에서는 Git을 푸시하고, 가시성을 변경하고, 기록을 다시 작성하고, 라이브 자격 증명을 교체하고, 장치를 변경하거나 타사 재배포 권한을 부여하는 명령은 없습니다. 공개 릴리스에는 명시적으로 선택된 공개 대상과 최종 아티팩트 검토가 필요합니다. 비공개 저장소에 `delivery-2026-10-22`를 보존합니다.
