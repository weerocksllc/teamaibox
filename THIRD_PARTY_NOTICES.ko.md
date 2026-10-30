<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.ko.md)
<!-- doc-navigation:end -->

# 라이센스 범위 및 제3자 고지사항

저작권 © 2026 Weerocks LLC. 루트 [MIT 라이선스](LICENSE)에는 원본 Team AI Box 코드와 소유자가 승인한 문서가 포함됩니다. 타사 코드, 복사/수정된 업스트림 파일, 종속성, 모델, 펌웨어, 운영 체제, 글꼴 또는 이미지에 대한 라이선스를 다시 부여하지 않습니다. 해당 자료에 대해서는 기존 저작권, LICENSE 및 NOTICE 파일이 우선적으로 적용됩니다. 패키지 메타데이터 `license: MIT`는 배포된 이미지에 포함된 모든 것이 아니라 해당 패키지의 원본 코드를 나타냅니다. 실수로 패키지 레지스트리 게시를 방지하기 위해 `private: true`가 유지됩니다. MIT 부여를 취소하지 않습니다.

## 인벤토리

기계 판독 가능한 [구성 요소 인벤토리](docs/open-source/components.json)에는 버전 또는 버전 소스, 라이선스 증거, 재배포 범위 및 해결되지 않은 바이너리 의무 사항이 기록됩니다. [종속성 인벤토리](docs/open-source/dependencies.json)는 잠금 파일, 설치된 종속성 메타데이터, Go 모듈 및 Python 요구 사항 파일에서 생성됩니다. 누락된 라이선스 메타데이터는 명시적으로 알 수 없으며 MIT로 간주되지 않습니다. `python3 tools/open_source_inventory.py`로 다시 생성하세요.

| 부품/재료 | 라이센스 경계 | 배포 요구 사항 |
| --- | --- | --- |
| UxPlay 수신기 및 `deploy/casting/uxplay-*.patch` | GPL-3.0-only | GPL, 공지, 정확한 업스트림 소스, 패치 및 모든 수신자 바이너리와 함께 빌드 스크립트를 유지합니다. 바이너리 릴리스에는 단순히 업스트림으로 연결하는 것만으로는 충분하지 않습니다. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | 공지를 유지하고 수정된 적용 소스 파일을 제공합니다. |
| G스트리머 | LGPL 및 개별 플러그인 라이센스 | 실제 플러그인 세트를 검사하고 해당 의무를 이행합니다. |
| LiveKit 서버/브라우저 SDK | Apache-2.0 | 저작권, 라이센스 및 해당 공지를 보유합니다. |
| 오징어 / AOSP | Apache-2.0 및 GPL 커널을 포함한 파일별 라이선스 | 업스트림 공지 및 해당 소스를 보존합니다. AOSP에는 Google 서비스 라이선스가 포함되어 있지 않습니다. |
| QEMU/Linux/EDK II/virtio 드라이버 | 프로젝트별 및 파일별 라이선스 | 실제 바이너리 빌드, 펌웨어 및 드라이버를 감사합니다. MIT라는 포괄적인 라벨을 붙이지 마세요. |
| 과카몰리 | Apache-2.0 | 컴퓨터 플러그인 Dockerfile에서 복사한 LICENSE 및 NOTICE를 유지합니다. |
| Node / React / Vite 및 JS 종속성 트리 | 패키지별 라이센스 | 번들 출력을 배포할 때 종속성 알림을 유지합니다. |
| PostgreSQL 및 컨테이너 OS 패키지 | PostgreSQL / 패키지별 | 설치된 패키지 라이센스 기록을 바이너리 릴리스에 포함합니다. |
| OCR에서 사용되는 PyMuPDF/MuPDF | AGPL-3.0-or-later 또는 상업용 라이센스 | 결합된 OCR 작업자 배포/서비스는 포괄적인 MIT가 아닙니다. AGPL 의무를 준수하거나 상업적 권리를 획득합니다. 원본 코드는 MIT 부여를 유지할 수 있습니다. |
| Qwen / LMT / Whisper / FLUX 모델 자산 | 정확한 모델 용어 | 모델은 MIT 소스 부여와 별개입니다. FLUX **4B** 용어는 다른 FLUX 모델로 대체되어서는 안 됩니다. |
| HunyuanOCR 가중치 | Tencent Hunyuan 커뮤니티 라이센스 | 조건부 모델 라이선스 각 릴리스에 대한 수신자, 지역, 용도, 귀속 및 재배포 조건을 검토합니다. |
| NVIDIA 소프트웨어 | NVIDIA 및 제3자 용어 포함 | 기존 호스트 Docker/NVIDIA 설치는 이 소스 패키지에 의해 재배포되지 않습니다. 번들로 제공되는 CUDA/컨테이너 라이브러리에는 여전히 자체 검토가 필요합니다. |
| Google 모바일 서비스/플레이 스토어 | 독점 | 공개 소스 후보의 일부가 아닙니다. 런타임 통합 코드는 GMS 이미지 배포 권한을 부여하지 않습니다. |
| Windows 설치 미디어, 게스트 디스크, 계정 | 보장되지 않음 | 사용자는 승인된 ISO 미디어와 라이센스를 제공합니다. 테스트 VM 디스크 또는 로그인된 게스트 상태를 배송하지 마세요. |
| 단종된 ViKey SDK | 독점/공공 보조금이 설정되지 않음 | SDK가 작업 소스에서 제거되었습니다. 비공개 기록 커밋과 보관된 SDK 사본은 게시하면 안 됩니다. USB 키가 필요하지 않습니다. |

정확한 캐스팅 공지는 [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt)에 남아 있습니다. ADB 전송 알림은 전화 클라이언트 옆에 남아 있습니다. 축소하거나 포장하는 동안 제거하지 마십시오. 컨테이너 격리 자체만으로는 카피레프트 의무가 취소되지 않습니다. 분포 분석은 실제 결합된 아티팩트에 따라 달라집니다.

## 브랜드 및 기여자

MIT는 상표권이나 보증이 아닌 저작권 허가를 부여합니다. Team AI Box 및 Weerocks 이름/로고는 수정된 제품에 대한 공식 지원을 암시해서는 안 됩니다. NVIDIA, DGX Spark, Android, Google Play, Windows 및 Apple/AirPlay는 해당 소유자의 소유입니다. 호환성은 인증이 아닙니다.

현지 작성자 메타데이터는 저작권 할당 증거가 아닌 목록입니다. 검토된 소유권 범주는 [OWNERSHIP.md](docs/open-source/OWNERSHIP.ko.md)에 기록됩니다. 프로젝트 소유자의 승인은 원래 기여에 적용됩니다. 기여자는 라이선스를 받을 자격이 있는 작품만 제출해야 합니다. 누락된 것으로 의심되는 저작자 표시: teamaibox@weerocks.llc.
