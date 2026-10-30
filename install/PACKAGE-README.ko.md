<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.ko.md)
<!-- doc-navigation:end -->

# Team AI Box 오프라인 설치 패키지

원본 코드에 대한 라이선스는 번들로 제공되는 `LICENSE`에 있습니다. 타사 구성요소는 원래 라이센스를 유지합니다. `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`를 참조하세요. MIT는 Google 서비스, Windows, 모델 가중치 또는 타사 브랜드에 대한 추가 재배포 권한을 부여하지 않습니다. 패키지 무결성 검사를 통과해도 모든 구성 요소에 대한 재배포 권한이 설정되지는 않습니다.

이 패키지는 호환되는 공장 Linux 시스템을 유지하는 새로운 DGX Spark용입니다. 기존 Docker, Compose 및 NVIDIA GPU 환경을 교체하거나 시스템 디스크를 포맷하지 않고 사용합니다.

## 설치

함께 제공되는 `.sha256` 파일을 사용하여 아카이브를 확인한 후 추출합니다.

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

일반 설치에는 공용 인터넷 액세스나 수동 환경 변수 편집이 필요하지 않습니다. 설치 프로그램은 필요한 번들 도구를 제공하고 독립적인 로컬 구성을 생성하며 새 데이터베이스를 초기화하고 서비스를 시작합니다. 초기 모델을 로드하는 데 시간이 걸릴 수 있습니다. 로딩 표시기는 성공적인 설치를 확인하는 것이 아닙니다.

설치하지 않고 환경과 패키지를 확인하려면 `sudo ./install.sh --check`를 실행하세요. `./install.sh --verify-package`는 패키지 내용만 확인하며 패키징 워크스테이션에서도 실행할 수 있습니다. 새 설치 루트를 지정하려면 `--installation-root /dedicated/path/installation`를 사용하세요. 기존 데이터를 가리키지 마십시오.

## 중단 및 기존 데이터

실패 또는 중단 후에는 보고된 문제를 해결하고 원래 명령을 반복하십시오. 설치 디렉터리를 삭제하지 마세요. 설치 프로그램은 생성된 ID와 데이터를 보존합니다. 전체 동일 버전 설치를 다시 실행하면 해당 상태만 확인됩니다. 다른 버전에서는 삭제 및 재설치가 아닌 정식 업그레이드 경로를 사용합니다. 강제 덮어쓰기 옵션은 없습니다.

## 처음 사용

어플라이언스의 현재 IP에서 HTTPS 주소를 열고 로그인합니다.

- 관리자 사용자 이름: `admin`
- 초기 비밀번호 : `admin`

설치 프로그램은 이 관리자를 자동으로 생성합니다. 설정 토큰 추출이나 수동 등록이 필요하지 않습니다. 초기 비밀번호는 공개되어 있으며 단순합니다. 배송/사용 전 사용자 관리에서 변경하세요. 일반 사용자는 기본 계정이 없으며 관리자가 생성합니다. 이는 빈 계정 데이터베이스에만 적용됩니다. 재개, 재실행, 재부팅 및 업그레이드는 기존 계정이나 비밀번호를 기본값으로 재설정하지 않습니다. 독립적으로 생성된 관리자 복구 코드는 설치 루트 `secrets/initial-owner-recovery.json`에 저장되며 루트만 읽을 수 있습니다. 절대로 채팅, 티켓 또는 공개 로그에 복구 코드를 보내지 마세요. 기존 설치에서는 복구 코드를 생성하거나 교체하지 않습니다. 로컬에서 발급된 HTTPS 인증서의 경우 관리자의 CA 지침에 따라 브라우저 신뢰를 구성합니다. 인증서의 이름은 LAN DNS/mDNS 확인을 보장하지 않습니다. 로컬 CA 공개 인증서는 일반적으로 `/srv/teamaibox/installation/https/ca.crt`에 있습니다. 해당 공개 인증서만 배포하고 옆에 있는 개인 키는 배포하지 마십시오.

설치에는 기존 가상 머신, Google 로그인 상태 또는 사용자 파일이 포함되지 않습니다. 사용자는 Windows/Linux ISO를 업로드하거나 팀 드라이브에서 선택한 다음 게스트 시스템을 직접 설치합니다. Google Play 및 외부 API에는 인터넷 액세스가 필요하며 오프라인 가용성 약속에는 포함되지 않습니다.

구성 요소 라이센스 텍스트는 해당 릴리스 리소스와 함께 유지됩니다. 저작권 © Weerocks LLC. 연락처: teamaibox@weerocks.llc.
