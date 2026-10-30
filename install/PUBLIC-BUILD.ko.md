<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.ko.md)
<!-- doc-navigation:end -->

# 공개 소스에서 어플라이언스를 구축합니다.

새로운 오케스트레이션 진입점은 [SOURCE-INSTALL.md](SOURCE-INSTALL.ko.md)에 문서화되어 있습니다. 아래 레시피를 자동화합니다. 전체 어플라이언스 검증 상태가 여기에 명시되어 있습니다. 이러한 수동 레시피는 유지관리자 및 개별 단계 진단에 계속 사용할 수 있습니다.

이는 소스-패키지 경로입니다. 이전 Team AI Box 설치, 해당 컨테이너, 계정, 인증서, 게스트 또는 데이터베이스를 가져오지 않습니다. 빌드 머신에는 인터넷 액세스가 필요합니다. 결과로 생성된 전체 패키지는 오프라인으로 설치됩니다. 고객은 Windows/Linux 설치 미디어를 별도로 제공합니다.

Linux ARM64(Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 및 소스 다운로드, 빌드 레이어 및 압축되지 않은 최종 번들을 위한 충분한 디스크 공간을 사용하세요. 모델 양자화에는 충분한 여유 메모리를 갖춘 호환 가능한 NVIDIA GPU도 필요합니다. 시스템 소유자의 허가 없이 해당 메모리를 확보하기 위해 다른 워크로드를 중지하지 마십시오. Docker 및 NVIDIA는 필수 구성 요소이며 설치 프로그램으로 대체되는 구성 요소가 아닙니다.

새로운 공개 결제에서 명령을 실행하세요. `BUILD`를 체크아웃 **외부의** 새로운 절대 빌드 디렉터리로 설정합니다. 출력, 모델 및 보고서를 커밋해서는 안 됩니다. 모든 도우미는 특정 재개 작업을 문서화하지 않는 한 점유된 출력을 거부합니다. 다른 사람의 컴퓨터에서 복사한 이미지 이름이 아닌 성공한 보고서의 참조/ID를 사용하세요. 로컬 Docker 콘텐츠 ID는 다운로드 가능한 레지스트리 참조가 아닙니다. Dockerfile 상위 인수에는 해당 로컬 태그 또는 정규화된 업스트림 다이제스트가 필요합니다.

## 1. 서비스 및 애플리케이션

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host`는 설치된 서비스 네트워킹이 아닌 온라인 **빌드**에 영향을 미칩니다. 노드 종속성 단계에서는 노드 기본값인 250ms 대신 연결 시도당 2초를 허용합니다. 이를 통해 레지스트리를 전환하거나 IPv6를 비활성화하거나 TLS/패키지 무결성 검사를 약화시키지 않고도 사용자 관리 VPN을 포함하여 지연 시간이 더 긴 링크에서 공식 npm 다운로드를 사용할 수 있습니다. 설정은 설치된 애플리케이션의 환경 변경이 아니라 빌드 단계 인수입니다. 링크 속도가 느린 경우 직접 Docker 빌드가 `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`를 재정의할 수 있습니다. 웹 이미지는 자체적으로 잠긴 종속성과 자산을 구축합니다. 노드 서비스는 새로 구축된 API 종속성 클로저를 공유합니다. OCR에는 공용 어댑터가 포함되어 있습니다. 다른 프로젝트의 게시되지 않은 작업자 패키지는 필요하지 않습니다. Translation은 고정된 공개 NVIDIA vLLM 이미지를 사용합니다. 임베딩, 일괄 ASR 및 캐스팅 미디어는 각각의 공개 런타임 이미지를 의도적으로 공유합니다. 컴퓨터 이미지는 ARM TPM/PPI, KVM, VNC 및 PulseAudio 지원을 통해 서명 검증 QEMU 11.1.1을 구축하여 원래 Windows 런타임 기능을 유지합니다. 데비안은 런타임 라이브러리를 제공하지만 이전 패키지 QEMU는 이 실행 파일을 대체해서는 안 됩니다. 최종 이미지는 ARM TIS `ppi` 속성과 PulseAudio 백엔드를 모두 확인하고 일치하는 RAM 프레임 버퍼 ROM을 포함합니다. 제한된 런타임 프로브 및 데이터 보존 업데이트 요구 사항은 [가상 컴퓨터 런타임 가이드](../deploy/windows-computer/README.ko.md)를 참조하세요.

각 역할에는 로그가 있습니다. 실패한 보고서는 성공적인 역할 출력을 유지합니다. 실패한 역할만 빌드하고 나중에 성공한 보고서를 병합합니다. 실행 중인 개발 컨테이너를 누락된 이미지로 대체하지 마세요.

## 2. 계정이 필요 없는 Android 및 카메라 런타임

잠금 장치는 Google의 AOSP 빌드, 호스트 패키지, 커널 입력 및 소스 개정을 고정합니다. 사용하기 전에 다운로드를 확인합니다. 어셈블리 중에는 게스트가 부팅되지 않습니다.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

카메라 APK 패치의 경우 Google의 공개 Android 명령줄 도구, 플랫폼 `android-36.1`, 빌드 도구 `36.1.0` 및 Java 릴리스를 지원하는 JDK를 설치합니다.
8. 해당 도구 디렉터리에 `ANDROID_SDK_ROOT` and `JDK_HOME`를 설정합니다. 도구는 내보낸 Android 사용자 프로필이 아닌 빌드 종속성입니다. ARM64 Linux에서 Google의 번들 `zipalign`는 x86 전용일 수 있습니다. Ubuntu의 ARM64 `zipalign` 패키지를 설치하고 아래의 `--zipalign /usr/bin/zipalign`를 전달하세요. D8과 apksigner는 Java 프로그램입니다. APK 빌드는 지원되는 별도의 SDK 호스트에서 실행할 수도 있습니다. 두 개의 출력 파일(`Camera2.apk`, `camera-preview.json`)만 전송하고 해당 호스트의 Android 설정이나 사용자 프로필은 전송하지 마세요.

깨끗한 AOSP 빌드에서 스톡 APK를 추출합니다(출력 디렉터리가 존재하고 빌드 컨테이너에서 쓸 수 있어야 함).

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK는 비공개 제품 키가 아닌 알려진 **공개 AOSP 테스트 서명자**를 유지합니다. 도우미는 원본 및 결과 인증서와 변경되지 않은 APK 리소스를 확인하고 임시 서명 자료를 제거합니다. 이는 계정이나 Google 기기 ID가 아닙니다.

현재의 전체 설치 프로그램 계약에는 실험적인 Google Android 변형도 포함되어 있습니다. 공개 입력 잠금 및 서명 검사는 Google 인증 또는 재배포 권한을 부여하지 **않습니다**. 해당 제3자 약관 내에서만 구축/사용합니다. 결과로 나온 전체 번들을 무제한 MIT 다운로드로 게시하지 마세요.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. 퍼블리셔 모델 파일 및 공개 양자화 레시피

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

모든 모델 다운로드는 `deploy/compute/*profile*` 및 게시자의 Git/LFS 해시에서 변경할 수 없는 개정판을 사용합니다. 선택 사항인 `--cache <directory>`는 읽기 전용이며 해당 바이트가 게시자와 일치하는 경우에만 파일을 허용합니다. 설치된 모델 디렉터리를 무분별하게 가져오는 방법은 아닙니다. 변환된 모델 스냅샷은 라이센스만 선언하기 때문에 ASR의 독립 실행형 MIT 텍스트는 원래 Whisper 릴리스에 고정되어 있습니다. OCR은 MIT가 아닌 자체 라이선스를 보유합니다. 고정된 번역 및 임베딩 모델 카드는 독립형 텍스트를 제공하지 않고 Apache-2.0를 선언합니다. 도우미에는 체크섬 고정 Apache 라이센스와 해당 선언을 확인한 후 출처 기록이 포함됩니다.

중단된 일치 다운로드는 `--resume`를 지원합니다. `--transfer ranges`는 제한된 재개 가능한 HTTP 범위를 사용합니다. `--transfer huggingface`에는 공식 `huggingface_hub`/`hf_xet` 패키지가 필요하며 토큰 사용을 비활성화합니다. 부분 및 다운로드 캐시는 게시 가능한 모델 디렉터리 외부에 유지됩니다. 모든 전송에는 체크섬이 필수입니다. HTML 로그인/챌린지 페이지 또는 잘린 다운로드에 대해 이를 약화시키지 마십시오.

양자화는 ModelOpt의 공개 합성 보정 데이터를 사용하여 별도의 빌드 컨테이너에서 오프라인으로 실행되며 채팅 기록은 사용하지 않습니다. `build.json`가 `quantized`라고 표시된 출력만 `assistant-model` and `translation-model`를 제공할 수 있습니다. 원시 소스나 전체 빌드 작업공간이 아닌 `model/` 하위 디렉터리를 선택하세요. 입력의 유효성을 검사한 후 Linux 빌드는 커널에 해당 특정 파일의 캐시된 페이지를 해제하도록 조언합니다. 이는 GB10의 공유 메모리에 대한 오해의 소지가 있는 즉각적 GPU 메모리 판독을 방지합니다. 가중치를 삭제하거나 호스트 전체 캐시를 지우거나 작업 부하를 중지하지 않습니다. 하나의 GB10 GPU에 대해 도우미는 Linux `MemAvailable`에서 예산을 책정하고 교정 및 호스트를 위한 용량을 예약합니다. CPU가 대부분인 빌드를 조용히 받아들이기보다는 용량 부족을 거부합니다. 전체 모델이 적합하면 명시적인 ModelOpt 예산은 Accelerate의 불필요한 CPU 오프로드 내보내기 경로를 방지합니다. 또한 빌드 컨테이너는 [NVIDIA의 양자화 시작 요구 사항](https://build.nvidia.com/spark/nvfp4-quantization/instructions)에 따라 무제한 잠긴 메모리와 64MiB 스택을 설정합니다. 이러한 설정은 호스트 전체 제한이 아닌 빌드 컨테이너로 범위가 지정됩니다.

## 4. 완전한 패키지 입력

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

합병 시 **41개의 역할과 누락된 역할**을 보고해야 합니다. 이미지 아키텍처/콘텐츠 ID를 확인하고 충돌하는 출력을 거부합니다. 리소스에는 업스트림 UEFI 펌웨어(새로운 변수 저장소 템플릿 포함), 체크섬 고정 virtio 드라이버 ISO, 소스 그리기 런타임 및 새로 빌드된 이미지에 바인딩된 Android 알림만 포함됩니다. ISO는 Windows 설치 미디어가 아닙니다. 체크섬과 동일한 Microsoft OpenVMM 미러는 대화형 Fedora 다운로드 페이지에 의존하지 않습니다.

[README.md](README.ko.md)에 설명된 대로 `collect_host_packages.py`를 사용하여 호스트 패키지를 수집한 다음 `prepare-release.py --template`를 사용하여 템플릿을 생성합니다. `images.json`에서 이미지 맵을 채웁니다. 모델 출력 `resources/assets.json` and `guest-tools`에서 12개의 자산 역할을 모두 채웁니다. `sourceCommit`를 결제 및 실제 에이전트 버전으로 설정합니다. 자리 표시자나 이전 설치 구성은 허용되지 않습니다.

`prepare-release.py --inputs … --output …`를 실행한 다음 준비된 릴리스를 사용하여 `build-package.sh`를 실행합니다. 수정되거나 커밋되지 않은 소스에는 명시적인 `--allow-working-tree` 후보 플래그가 필요합니다. 이는 릴리스된 커밋이 아닙니다. 설치 방법은 [PACKAGE-README.md](PACKAGE-README.ko.md)를 참조하세요. 새로운 빈 계정 데이터베이스는 `admin/admin`를 얻습니다. 모든 서비스 자격 증명과 장치 ID는 독립적으로 생성됩니다. 빌드만으로는 설치 성공을 증명할 수 없습니다.

## 기록 계층 레시피 및 출판 확인

이전 진단/계층화된 Dockerfile은 소스 유지 관리를 위해 보관되며 이 파이프라인에서는 사용되지 않습니다. 해당 `BUILD_PARENT_N` 인수에는 의도적으로 비공개 이미지 기본값이 없습니다. 구축한 호환 가능한 상위 항목을 제공하거나 위의 공개 파이프라인을 사용하세요. 사용할 수 없는 개발 다이제스트를 추측하지 마세요.

게시하기 전에 소스 가드 및 비밀 스캐너를 실행하고 기록을 별도로 검토하고 모든 빌드 디렉터리, 패키지, 게스트 디스크, 계정 데이터 및 개인 웹사이트를 제외하세요. 로컬 경로가 포함된 보고서는 공개 트리 외부에 속합니다. 이 작업에 대한 확인은 빌드 입력 클로저, 아티팩트 ID, 설치 및 새로 설치된 최소 서비스 경로로 제한됩니다. 관련 없는 업무 수락을 다시 실행하지 않습니다.
