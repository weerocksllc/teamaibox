<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.ko.md)
<!-- doc-navigation:end -->

# Team AI Box 오프라인 패키지 도구

원래 설치 프로그램은 MIT 라이센스가 있습니다. 패키지에는 루트 라이선스, 타사 인벤토리 및 파일 해시 인벤토리의 라이선스 텍스트가 포함됩니다. 이는 모델, Google 서비스, 드라이버 또는 컨테이너 종속성을 MIT로 재라이센스하지 않습니다. 배포하기 전에 [출시 경계](../docs/open-source/RELEASING.ko.md)를 읽어보세요. 기존의 전체 테스트 패키지에는 재배포 허가가 자동으로 부여되지 않습니다.

고객은 준비된 패키지** 내에서 **`sudo ./install.sh`를 실행합니다. 유지관리자는 `build-package.sh`를 사용하여 해당 패키지를 빌드합니다. 오프라인 고객에게는 Git, Node, Go, pip 또는 공개 패키지 저장소가 필요하지 않습니다.

공개 클론에서 자동 다운로드, 빌드 및 설치를 수행하려면 `sudo bash install/from-source.sh`를 실행하세요. 중국의 네트워크는 `--region cn`를 사용할 수 있습니다. 작동, 재개 및 오프라인 전송에 대해서는 [SOURCE-INSTALL.md](SOURCE-INSTALL.ko.md)를 참조하세요. 이력서가 지원됩니다. 최종 준비 결과만 설치 완료를 결정합니다. 성공적인 프리플라이트나 다운로드만으로는 충분하지 않습니다.

대상은 공장 Ubuntu 24.04 ARM64 시스템과 작동 중인 Docker 엔진, Compose v2, NVIDIA 컨테이너 툴킷/GPU 및 KVM을 갖춘 새로운 DGX Spark입니다. 설치 프로그램은 Docker/NVIDIA를 교체하거나 Docker를 다시 시작하거나 개발 어플라이언스의 계정, 데이터베이스, 키 또는 가상 머신을 복사하지 않습니다.

> 개인 설치 승인 기록은 과거 개발 저장소에 보관됩니다. 공개 소스 파일도 아니고 빌드 입력도 아닙니다. 기존의 최초 설치, 재개 및 부팅 복구 증거는 단순히 소스 게시를 위해 다시 실행되지 않으며 새로 빌드된 임의의 이미지에 대한 자격을 부여하거나 타사 바이너리에 대한 재배포 권한을 부여하지 않습니다.

## 유지관리자: 릴리스 입력 준비

**새로운 공개 GitHub 빌드의 경우 [PUBLIC-BUILD.md](PUBLIC-BUILD.ko.md)로 시작하세요.** 개발 어플라이언스의 이미지가 필요 없이 공개 이미지, 카메라 런타임, 모델 다운로드/양자화 및 펌웨어를 다룹니다. 아래의 계층화된 이미지 도우미는 확인된 아티팩트의 증분 업데이트를 지원합니다. 이는 새로운 빌드를 위한 전제조건이 아닙니다.

준비는 인터넷을 이용하셔도 됩니다. 제공된 패키지의 설치는 종속성을 다운로드해서는 안 됩니다. 패키징 호스트에는 Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` 및 충분한 스토리지가 필요합니다. 모델과 이미지는 클 수 있습니다. 패키저는 추출된 트리와 `.tar`를 모두 유지하여 실제 입력에서 공간을 추정합니다. 전체 개발 어플라이언스를 스캔하지도 않고 실행 중인 컨테이너에서 쓰기 가능한 레이어를 내보내지도 않습니다.

1. 모든 필수 역할에 대해 **하나의 릴리스 버전**에서 ARM64 이미지를 준비합니다. `deploy/images/`, `deploy/appliance/` 및 해당 게스트/모델 디렉터리 아래의 빌드 진입점을 사용하세요. 플랫폼 API, 노드 에이전트, 스케줄러 및 에이전트 컨트롤러는 로컬 이미지 ID를 지원해야 합니다. PostgreSQL 이미지에는 마이그레이션 116을 포함하여 현재 마이그레이션 매니페스트가 포함되어야 합니다. 패키저는 임의의 이전 이미지를 현재 이미지로 컴파일하지 않습니다. 확인된 동일한 버전의 상위 이미지가 있는 경우 `build_runtime_images.py --bases … --node-agent-binary … --output …`를 사용하여 5개의 후속 이미지를 빌드합니다. `--bases`는 JSON 역할-전체 이미지 ID 맵입니다. 먼저 `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`를 사용하여 노드 에이전트를 빌드합니다. 이 도우미는 가져오기/네트워크 빌드를 금지하고, 상위/소스 ID를 기록하고, 라이브 태그를 배포하거나 변경하지 않고 새 이미지를 생성합니다. 깨끗한 Android ROM에는 현재 제어 네트워크 어댑터도 필요합니다. 네트워크 액세스나 ROM 데이터 변경 없이 두 ROM 후속 레이어에 `phone_network.py`를 추가하려면 `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>`를 사용하세요. 정확한 이미지 ID와 소스 다이제스트를 기록합니다. Android 사이드카를 이전 ID가 아닌 두 새 ID에 바인딩합니다. `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`를 사용하여 웹과 9개의 공식 앱을 빌드하세요. 먼저 `apps/web/package.json`에 지정된 대로 웹을 빌드합니다. 도우미는 프로덕션 Dockerfile을 사용하고, `/opt/teamaibox/web`에서 웹 디렉터리를 수정하고, 이미지 파일을 현재 빌드 입력 해시와 비교합니다. 개발 컨테이너 이미지가 완전한 웹 빌드라고 가정하지 마십시오. 추가 정적 디렉터리 변수에 의존하거나 이전 디렉터리를 포함할 수 있습니다. 이 오프라인 도우미는 배포되지 않습니다. 10개의 새 이미지 ID를 모두 릴리스 입력에 입력합니다.
2. 구성, 샤드, 토크나이저, 필수 코드 및 라이선스 등 6개 모델에 대한 완전하고 깨끗한 디렉터리를 수집합니다. 또한 두 개의 깨끗한 Android 이미지, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` 및 그리기 런타임 스크립트를 준비합니다. 전화 인스턴스 디렉터리, 사용자 디스크, Google 로그인 상태, 사용자 ISO 또는 전역 자격 증명을 수집하지 마십시오. Android ROM은 이미 `phone-runtime` / `phone-google-runtime` 안에 있습니다. 두 번째 디스크를 복사하지 마십시오. `android-standard` / `android-google` 자산 디렉토리에는 출처, 라이선스, `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` 및 `runtimeImageId: "sha256:…"`만 포함되어 있습니다. ID는 내보낸 런타임 이미지와 일치해야 합니다. 드라이버 디렉터리에는 `virtio.iso`만 포함되어 있습니다. `windows.iso`도 포함하는 개발 디렉터리는 거부됩니다.
3. 빌드 호스트에 설치하지 않고 두 개의 번들 Linux ARM64 호스트 도구를 빌드합니다.

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. 인터넷에 연결된 ARM64 빌드 호스트에서 명시적인 로컬 Ubuntu 24.04 이미지를 사용하여 호스트 도구 종속성을 수집합니다. 개발 어플라이언스에서 복사한 ID가 아닌 해당 호스트에서 확인된 이미지 ID를 사용합니다.

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   cryptsetup, ext4, USB/카메라, QEMU 이미지 도구, 네트워킹 및 소규모 시스템 유틸리티에 대한 종속성만 수집합니다. Docker, Containerd, NVIDIA, CUDA 및 커널 교체 패키지는 금지됩니다. 설치에는 누락된 도구만 ​​제공됩니다. apt는 온라인 대체 없이 `--no-download --no-remove`를 사용하여 패키지의 로컬 파일 저장소를 읽습니다.

5. 릴리스 입력 매니페스트를 생성하고 **명시적 아티팩트 경로 및 로컬 이미지 콘텐츠 ID**를 제공합니다.

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   템플릿에는 41개의 이미지 역할과 12개의 외부 자산 카테고리가 모두 포함되어 있습니다. 도구에 의해 또 다른 공장 자산이 생성됩니다. 자리 표시자는 패키지에 들어갈 수 없습니다. `sourceCommit`는 결제와 일치해야 하고, `agentVersion`는 실제 에이전트 빌드와, `hostPackageCollection`는 4단계 `collection.json`와 일치해야 합니다. 빌드 호스트 경로는 고객 런타임 구성이 아닌 컬렉션 입력입니다. 현재 팩토리 생성기를 사용합니다. 그리기 UI의 `drawing.automatic` / `drawing.fast` 경로는 로컬 모델 구성과 일치해야 합니다. 작업자 건강이나 직접적인 모델 호출만으로는 애플리케이션 준비가 완료되지 않습니다. 패키징에서는 이러한 매핑이 누락된 오래된 팩토리 템플릿을 거부합니다.

이미지 역할 계약은 `python3 install/package.py --describe-contract`에 의해 보고됩니다.

- 코어, 웹, 팀 드라이브, 메시징, 게이트웨이, 스케줄러, 유지 관리, 플러그인, 동적 에이전트 샌드박스 및 패키지 소스 게이트웨이.
- 9개의 애플리케이션 플러그인, 6개의 사무실 모델 작업자 및 주문형 ASR/스피커 런타임.
- 표준 Android, Google Android, 컴퓨터 런타임 및 웹 디스플레이/오디오 게이트웨이.
- 캐스팅 리시버, 미디어 처리 및 SFU.

두 역할이 하나의 이미지 콘텐츠 ID를 공유할 수 있습니다. 해당 아카이브는 한 번만 내보내집니다. 모델 샤드 인덱스도 확인됩니다. 일치하는 파일 해시는 누락된 샤드를 용서하지 않습니다. 호스트 도구는 실제 ARM64 ELF 바이너리여야 합니다.

## 패키지 빌드

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

출력은 `teamaibox-<releaseId>-linux-arm64.tar`, 해당 `.sha256` 파일 및 추출된 디렉터리입니다. 복사, 이미지 내보내기, 해싱 및 보관은 최종 체크섬이 게시되기 전에 임시 디렉터리에서 발생합니다. 기존 출력은 덮어쓰이지 않습니다. 중단된 빌드는 완전한 릴리스처럼 보여서는 안 됩니다. 이미지 ID가 변경되지 않은 설치 프로그램 전용 변경의 경우 `--image-cache <previous-extracted-package>`를 사용하세요. 아카이브가 실제 이미지 ID로 재사용되기 전에 전체 이전 패키지가 확인되고 새 패키지가 다시 확인됩니다. 이전 설치 또는 컨테이너 쓰기 가능 레이어에서는 데이터를 가져오지 않습니다. 이렇게 하면 수백 GB의 동일한 이미지를 다시 내보내는 것을 방지할 수 있습니다.

일반 릴리스에서는 번들 소스 파일이 선언된 Git 커밋에 속해야 합니다. 명시적인 `--allow-working-tree`는 개발 후보를 생성합니다. 매니페스트는 `candidate: true` 및 변경된 파일을 기록합니다. 집중 승인을 통과해도 커밋되지 않은 소스가 게시된 릴리스로 바뀌지는 않습니다.

패키지 레이아웃:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

`./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`로 독립적으로 확인하세요. 이는 무결성을 확인합니다. 새 하드웨어에서 성공적인 부팅이 입증되지는 않습니다.

## 고객: 오프라인 설치 및 재개

[패키지 설치 가이드](PACKAGE-README.ko.md)를 읽어보세요. 기본 루트는 `/srv/teamaibox/installation`입니다. LUKS/ext4는 시스템 디스크나 기존 디스크가 아닌 새 `volume/data.img` 내부에서만 생성됩니다. 데이터 풀은 고정된 256GiB 제한이 아닌 물리적 안전 여유를 뺀 사용 가능한 스토리지를 사용합니다. 모델, 비즈니스 파일 및 게스트 데이터는 암호화된 볼륨에 있습니다. 기존 Docker는 컨테이너 이미지를 관리합니다.

새로 설치하면 초기 비밀번호가 `admin`인 관리자 `admin`가 생성됩니다. 일반 사용자는 관리자가 생성합니다. 배송/사용 전 초기 비밀번호를 변경하세요. 이는 빈 계정 데이터베이스에만 적용됩니다. 재개, 재실행, 재부팅 및 업그레이드는 기존 계정이나 비밀번호를 재설정하지 않습니다. 장치 ID, 서비스 자격 증명, 인증서 및 관리자 복구 코드는 독립적으로 생성되며 다른 어플라이언스에서 복사되지 않습니다. 초기 GPU 커널 캐시 준비는 번들 도구 및 모델을 사용하여 어플라이언스에서 실행됩니다. 호환되는 캐시는 유지됩니다. 부팅 복구는 데이터 및 장치 서비스를 먼저 복원한 다음 핵심 서비스 및 개별 AI 작업자를 복원합니다. 설치 프로그램은 설치 중에만 실행됩니다. 상주 설치 관리자를 추가하지 않습니다.

중단 후 원래 명령을 반복하십시오. 완료된 단계가 확인되었습니다. 데이터를 삭제하거나 컨테이너를 다시 생성하여 충돌을 숨기지 마십시오. 완료된 동일한 버전 설치를 다시 실행하면 확인만 됩니다. 다른 버전에서는 정식 업그레이드 경로를 사용합니다. 실패 세부사항은 `install-state.json`, `readiness.json`에 있으며 설치 루트 아래의 단계 기록에 있습니다.

## 검증 경계

설치 프로그램별 테스트에서는 작은 구조적 아티팩트, 임시 파일 및 격리된 오프라인 데이터베이스/Docker 데몬을 사용합니다. 비즈니스 데이터베이스에 액세스하거나 기존 VM 디스크를 마운트하면 안 됩니다. 실제로 새로 설치하려면 해당 목적을 위해 명시적으로 지정된 호환 가능한 DGX Spark가 필요합니다. 업무용 기기를 지우지 마세요. 승인에는 관련 없는 비즈니스 테스트가 아닌 새로운 설치에 대한 최소 시작, 재개 및 부팅 복구가 포함됩니다. 소스 릴리스 준비 자체로는 기존 어플라이언스를 삭제, 재설치 또는 배포하지 않습니다.

빌드 호스트에서 `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>`를 실행하여 캐시가 비어 있고 공용 네트워크가 없는 별도의 Docker 데몬으로 전체 패키지를 가져옵니다. 새로 설치 스크립트를 호출하거나 GPU를 사용하거나 고객 디렉터리를 마운트하거나 시스템 Docker를 다시 시작하지 않습니다. 해당 보고서에서는 전체 하드웨어 설치를 명시적으로 주장하지 않습니다. 테스트 이미지는 전용 테스트 디렉터리에 남아 있으며 추가 디스크 공간이 필요하고 시스템 Docker의 이미지 저장소에 들어가지 않습니다.
