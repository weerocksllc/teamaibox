<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.ko.md)
<!-- doc-navigation:end -->

# 소스빌드

공개 아티팩트는 사전 구축된 오프라인 어플라이언스 이미지가 아닌 소스입니다. 소스 빌드는 종속성을 다운로드할 수 있습니다. 준비된 전체 패키지를 사용한 설치는 오프라인 상태로 유지됩니다. 두 프로세스 모두 ViKey SDK 또는 USB 키가 필요하지 않습니다.

완전한 어플라이언스 설치를 위해서는 루트 [빠른 시작](../../README.ko.md#install) 및 [소스 설치 프로그램](../../install/SOURCE-INSTALL.ko.md)으로 시작하세요. `sudo bash install/from-source.sh`는 호환되는 최신 Spark에 다운로드, 빌드, 패키지 및 설치합니다. 아래 개발 웹 빌드는 해당 설치 프로그램이 아니며 전체 제품을 시작하지 않습니다.

## 개발

Node.js 24, pnpm 11.1.3(루트 `package.json` 참조), Python 3.10+ 및 각 `go.mod`(현재 node-agent 1.26)에 선언된 Go 버전을 사용하세요. 빌드 머신에서:

소스 내보내기에는 의도적으로 개인 Git 기록이 없습니다. 내보낸 트리에서 소스 도구를 실행하기 전에 자체 저장소를 초기화하고 검토된 트리(`git init`, `git add .`, `git commit`)를 커밋하세요. 일반 공개 Git 클론에는 이 단계가 필요하지 않습니다. 해당 새 커밋을 빌드 ID로 사용하세요. 내보내고 수정된 트리가 이전 전달 커밋이라고 주장하지 마세요.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

웹 빌드는 제품 승인이 아닌 컴파일 확인입니다. 런타임 서비스는 `deploy/` 아래의 Dockerfile을 사용합니다. DGX Spark 실행에는 Linux ARM64 및 기존 NVIDIA/Docker 환경이 필요합니다. 데스크탑 소스 체크아웃은 해당 하드웨어를 대체하지 않습니다. 과거의 랩 스크립트를 설치 프로그램으로 사용하지 마십시오.

Python 팩토리 빌드 도우미에는 PyYAML이 추가로 필요합니다. 설치 프로그램 종속성 프리플라이트를 참조하세요. 설치된 운영 체제 디스크나 개발자 계정이 필요하지 않습니다.

## 제외된 컴파일된 입력

내보내기 프로그램은 확장명이 무해해 보이는 경우에도 바이너리 파일을 생략합니다.

- Go 소스에서 `services/node-agent` 및 `cmd/factory-worker-spec` 도우미를 빌드합니다. 저장소 루트 `node-agent` 실행 파일은 소스 입력이 아닙니다.
- Android Fixture APK 및 서명 파일은 배송되지 않습니다. `tools/fixtures/` 아래의 소스와 매니페스트는 로컬 테스트 빌드에 계속 사용할 수 있습니다.
- 현재 어플라이언스 캐스팅 빌드는 `deploy/appliance/wireless-casting-plugin.Dockerfile`를 사용합니다. 이전 Alpine 패키지 아카이브가 필요하지 않습니다. 대신 독립 실행형 플러그인 Dockerfile을 사용하는 경우 [업스트림 체크섬 매니페스트](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json)에서 식별된 정확한 패키지를 얻고 빌드하기 전에 해당 SHA-256 값을 확인하세요. 고정된 업스트림 아티팩트를 사용할 수 없는 경우 임의 패키지를 대체하지 마십시오.
- LiveKit 브라우저 모듈과 해당 라이센스는 플러그인의 공개 소스 디렉토리에 남아 있습니다. 중복 npm `.tgz` 아카이브는 배송되지 않습니다.

이는 실행 중인 어플라이언스에 대한 변경 사항이 아니라 소스 배포 제외 사항입니다.

## 오프라인 패키지 완성

[공개 소스 파이프라인](../../install/PUBLIC-BUILD.ko.md)으로 시작하세요. 공개 상위 이미지와 소스 기반 런타임 종속성을 제공합니다. 이전 개발자 설치가 필요하지 않습니다. 기록 계층형 이미지 레시피는 새로 설치하는 진입점이 아닙니다.

애플리케이션 이미지 빌드, 게스트 호스트 도구, 오프라인 호스트 패키지, 자산 수집 및 최종 패킹에 대해서는 [install/README.md](../../install/README.ko.md)를 따르세요. 대상 어플라이언스는 종속성을 가져오거나 Docker/NVIDIA를 대체하지 않습니다. 빌드 입력을 실제 소스 커밋, ARM64 OCI 콘텐츠 ID 및 정리 자산 경로로 설정하세요. 개발 호스트 IP, 계정, 인증서 또는 볼륨이 필요하지 않습니다. 모델 가중치와 게스트/런타임 자산은 [comComponents.json](components.json) 및 저장소 잠금에서 식별된 정확한 업스트림 소스와 별도로 획득됩니다. 라이선스와 필수 소스 공지를 보존하세요.

**소스 가용성은 바이너리 재배포 허가가 아닙니다.** 현재 완전한 오프라인 패키지 계약에는 Google Android 런타임이 포함되어 있습니다. 개인 설치 증거는 GMS 배포 권한이 없습니다. 기존 패키저는 변경되지 않고 유지되지만, 그러한 패키지는 해당 권한을 획득하지 않는 한 승인된 공개 다운로드가 아닙니다. AOSP 전용 공개 바이너리 에디션은 별도로 범위가 지정된 패키징 변경 사항이며 여기서는 자동으로 대체되지 않습니다. Windows/Linux ISO 파일은 각 사용자가 제공합니다. 설치된 테스트 게스트 또는 계정 상태는 공개 빌드 입력이 아닙니다.
