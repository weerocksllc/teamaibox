<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.ko.md)
<!-- doc-navigation:end -->

# ARM 가상 컴퓨터 런타임

`Public.Dockerfile`는 원래 `windows-arm64-ppi` 런타임에 필요한 것과 동일한 ARM TPM PPI(물리적 존재) 기능을 구축합니다. 고정된 릴리스 관리자 지문에 대해 분리된 서명을 확인한 후 공식 릴리스에서 QEMU 11.1.1을 빌드합니다. 데비안은 게스트를 실행하는 데 사용되는 QEMU 실행 파일이 아닌 컨테이너 라이브러리와 도구를 제공합니다.

이 실행 파일을 이전 배포 QEMU 패키지로 바꾸지 마십시오. Windows 프로필에서는 `tpm-tis-device,...,ppi=on`를 활성화합니다. 해당 ARM 속성이 없는 빌드는 펌웨어가 시작되기 전에 종료됩니다. `ppi=on` 제거, TPM 비활성화 또는 게스트 TPM 재설정은 호환되는 수리가 아닙니다.

최종 이미지 빌드는 ARM TIS PPI 및 PulseAudio 지원을 확인하고 일치하는 RAM 프레임 버퍼 ROM을 포함합니다. ARM KVM 호스트에서 번들로 제공되는 `python3 /usr/local/bin/probe-ppi`는 디스크가 없고 일시 중지된 QEMU/TPM 검사를 수행합니다. 기존 게스트 디스크를 마운트하거나 Windows 설치가 완료되었음을 증명하지 않습니다. Windows 부팅은 명시적으로 지정된 테스트 게스트에서 별도로 확인해야 합니다.

기존 설치의 경우 플랫폼의 런타임 업데이트 정책과 일치하는 노드 에이전트 프로필 이미지 다이제스트를 사용합니다. 디스크, 펌웨어, TPM ID 및 상태를 보존합니다. 단순히 Windows 런타임을 복구하기 위해 게스트를 다시 생성하거나 실행 중인 Linux 게스트 이미지를 변경하지 마세요. 소스 변경 사항이 커밋되고 릴리스될 때까지 로컬로 빌드된 이미지를 게시되지 않은 상태로 기록합니다.

업데이트할 때 설치된 구성의 소유권과 읽기 권한을 유지합니다. 런타임 업데이트 정책을 로드하기 위해 Platform API를 다시 생성하는 경우 변경되지 않은 이미지에서 네트워크 네임스페이스 종속 항목(`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` 및 `maintenance-controller`)도 다시 생성합니다. 새 API 컨테이너의 네트워크 네임스페이스에 가입해야 합니다. 이는 게스트, Docker 데몬 또는 AI 작업자 다시 시작이 아닙니다. Windows 시작 작업을 제출하기 전에 노드의 정상적으로 인증된 하트비트가 준비 상태를 복원할 때까지 기다립니다.
