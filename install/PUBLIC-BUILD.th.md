<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.th.md)
<!-- doc-navigation:end -->

# สร้างเครื่องใช้ไฟฟ้าจากแหล่งสาธารณะ

จุดเข้าจัดระเบียบใหม่ได้รับการบันทึกไว้ใน [SOURCE-INSTALL.md](SOURCE-INSTALL.th.md) มันทำให้สูตรอาหารด้านล่างเป็นแบบอัตโนมัติ สถานะการตรวจสอบอุปกรณ์เต็มรูปแบบระบุไว้ที่นั่น สูตรแบบทำเองเหล่านี้ยังคงมีให้สำหรับผู้ดูแลและการวินิจฉัยแต่ละระยะ

นี่คือเส้นทางจากต้นทางถึงแพ็คเกจ จะไม่นำเข้าการติดตั้ง Team AI Box ก่อนหน้า คอนเทนเนอร์ บัญชี ใบรับรอง ผู้เยี่ยมชม หรือฐานข้อมูล เครื่องประกอบจำเป็นต้องเชื่อมต่ออินเทอร์เน็ต แพ็คเกจที่สมบูรณ์ที่ได้ผลลัพธ์จะติดตั้งแบบออฟไลน์ ลูกค้าจัดหาสื่อการติดตั้ง Windows/Linux แยกต่างหาก

ใช้ Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git, Go 1.26 และพื้นที่ดิสก์เพียงพอสำหรับการดาวน์โหลดต้นฉบับ สร้างเลเยอร์ และบันเดิลสุดท้ายที่ไม่มีการบีบอัด การหาปริมาณโมเดลยังต้องใช้ GPU NVIDIA ที่เข้ากันได้และมีหน่วยความจำว่างเพียงพอ อย่าหยุดปริมาณงานอื่นๆ เพื่อรับหน่วยความจำนั้นโดยไม่ได้รับอนุญาตจากเจ้าของเครื่อง Docker และ NVIDIA เป็นข้อกำหนดเบื้องต้น ไม่ใช่ส่วนประกอบที่แทนที่โดยโปรแกรมติดตั้ง

เรียกใช้คำสั่งจากการชำระเงินสาธารณะครั้งใหม่ ตั้งค่า `BUILD` เป็นไดเร็กทอรีบิวด์สัมบูรณ์ใหม่ **นอก** การชำระเงิน ต้องไม่มีการกำหนดเอาท์พุต แบบจำลอง และรายงาน ผู้ช่วยเหลือทุกคนจะปฏิเสธเอาท์พุตที่ถูกครอบครอง เว้นแต่จะบันทึกการดำเนินการเรซูเม่ที่เฉพาะเจาะจง ใช้ข้อมูลอ้างอิง/รหัสของรายงานที่ประสบความสำเร็จ ไม่ใช่ชื่อรูปภาพที่คัดลอกมาจากเครื่องของผู้อื่น ID เนื้อหา Docker ในเครื่องไม่ใช่ข้อมูลอ้างอิงรีจิสทรีที่ดาวน์โหลดได้ อาร์กิวเมนต์พาเรนต์ของ Dockerfile จำเป็นต้องมีแท็กในเครื่องที่เกี่ยวข้องหรือข้อมูลสรุปอัปสตรีมที่ผ่านการรับรอง

## 1. บริการและแอพพลิเคชั่น

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

`--network host` มีผลกับ **builds** ออนไลน์ ไม่ใช่บริการเครือข่ายที่ติดตั้ง ขั้นตอนการขึ้นต่อกันของโหนดจะใช้เวลา 2 วินาทีต่อความพยายามในการเชื่อมต่อ แทนที่จะเป็นค่าเริ่มต้นของโหนดที่ 250 มิลลิวินาที ซึ่งจะทำให้การดาวน์โหลด npm อย่างเป็นทางการสามารถใช้งานได้บนลิงก์ที่มีเวลาแฝงสูงกว่า รวมถึง VPN ที่จัดการโดยผู้ใช้ โดยไม่ต้องเปลี่ยนรีจิสทรี ปิดการใช้งาน IPv6 หรือลดการตรวจสอบความสมบูรณ์ของ TLS/แพ็คเกจ การตั้งค่านี้เป็นอาร์กิวเมนต์ build-stage ไม่ใช่การเปลี่ยนแปลงสภาพแวดล้อมในแอปพลิเคชันที่ติดตั้ง สำหรับลิงก์ที่ช้ากว่า บิลด์ Docker โดยตรงสามารถแทนที่ `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000` ได้ รูปภาพของเว็บสร้างการขึ้นต่อกันและเนื้อหาที่ถูกล็อคของตัวเอง บริการโหนดแบ่งปันการปิดการพึ่งพา API ที่สร้างขึ้นใหม่ OCR มีอะแดปเตอร์สาธารณะ ไม่จำเป็นต้องมีแพ็คเกจผู้ปฏิบัติงานที่ไม่ได้เผยแพร่จากโครงการอื่น การแปลใช้อิมเมจ vLLM สาธารณะ NVIDIA ที่ปักหมุดไว้ การฝัง ASR แบบแบตช์ และสื่อการหล่อจงใจแบ่งปันอิมเมจรันไทม์สาธารณะตามลำดับ อิมเมจคอมพิวเตอร์สร้าง QEMU 11.1.1 ที่ตรวจสอบลายเซ็นพร้อมรองรับ ARM TPM/PPI, KVM, VNC และ PulseAudio โดยคงความสามารถของรันไทม์ดั้งเดิมของ Windows ไว้ Debian จัดเตรียมไลบรารีรันไทม์ แต่ QEMU แพ็คเกจเก่าจะต้องไม่แทนที่ไฟล์ปฏิบัติการนี้ อิมเมจสุดท้ายจะตรวจสอบทั้งคุณสมบัติ ARM TIS `ppi` และแบ็กเอนด์ PulseAudio และมี RAM framebuffer ROM ที่ตรงกัน ดู [คู่มือรันไทม์คอมพิวเตอร์เสมือน](../deploy/windows-computer/README.th.md) สำหรับรันไทม์โพรบที่มีขอบเขตและข้อกำหนดการอัปเดตที่เก็บรักษาข้อมูล

แต่ละบทบาทมีบันทึก รายงานที่ล้มเหลวจะรักษาผลลัพธ์ของบทบาทที่ประสบความสำเร็จไว้ สร้างเฉพาะบทบาทที่ล้มเหลวและรวมรายงานที่ประสบความสำเร็จในภายหลัง อย่าแทนที่คอนเทนเนอร์การพัฒนาที่ทำงานอยู่เป็นอิมเมจที่ขาดหายไป

## 2. รันไทม์ Android และกล้องที่ไม่มีบัญชี

ล็อคพินบิลด์ AOSP ของ Google, แพ็คเกจโฮสต์, อินพุตเคอร์เนล และการแก้ไขแหล่งที่มา การดาวน์โหลดจะถูกตรวจสอบก่อนการใช้งาน ไม่มีแขกคนไหนถูกบู๊ตระหว่างการประกอบ

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

สำหรับแพตช์ APK ของกล้อง ให้ติดตั้งเครื่องมือบรรทัดคำสั่ง Android สาธารณะของ Google, แพลตฟอร์ม `android-36.1`, เครื่องมือสร้าง `36.1.0` และ JDK ที่รองรับ Java release
8. ตั้งค่า `ANDROID_SDK_ROOT` and `JDK_HOME` ไปยังไดเร็กทอรีเครื่องมือเหล่านั้น เครื่องมือนี้เป็นการสร้างการอ้างอิง ไม่ใช่โปรไฟล์ผู้ใช้ Android ที่ส่งออก บน ARM64 Linux `zipalign` ของ Google อาจเป็น x86 เท่านั้น: ติดตั้งแพ็คเกจ ARM64 `zipalign` ของ Ubuntu และส่ง `--zipalign /usr/bin/zipalign` ด้านล่าง D8 และ apksigner เป็นโปรแกรม Java APK บิลด์สามารถทำงานบนโฮสต์ SDK ที่รองรับแยกต่างหากได้ ถ่ายโอนเฉพาะไฟล์เอาต์พุตสองไฟล์ (`Camera2.apk`, `camera-preview.json`) โดยห้ามใช้การตั้งค่า Android หรือโปรไฟล์ผู้ใช้ของโฮสต์นั้น

แยก APK ของหุ้นออกจากบิลด์ AOSP ที่สะอาด (ต้องมีไดเร็กทอรีเอาต์พุตและสามารถเขียนได้โดยคอนเทนเนอร์บิลด์):

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

APK จะเก็บ **ผู้ลงนามทดสอบ AOSP สาธารณะ** ที่รู้จัก ไม่ใช่คีย์ผลิตภัณฑ์ส่วนตัว ตัวช่วยจะตรวจสอบใบรับรองต้นฉบับและผลลัพธ์ รวมถึงทรัพยากร APK ที่ไม่เปลี่ยนแปลง และลบสื่อการลงนามชั่วคราวออก นี่ไม่ใช่บัญชีหรือข้อมูลประจำตัวของอุปกรณ์ Google

สัญญาการติดตั้งฉบับสมบูรณ์ในปัจจุบันยังรวมถึงเวอร์ชันทดลองของ Google Android ด้วย การล็อคอินพุตสาธารณะและการตรวจสอบลายเซ็น **ไม่**ให้การรับรอง Google หรือสิทธิ์ในการแจกจ่ายซ้ำ สร้าง/ใช้งานภายในข้อกำหนดของบุคคลที่สามที่เกี่ยวข้องเท่านั้น อย่าเผยแพร่บันเดิลแบบเต็มที่ได้เป็นการดาวน์โหลด MIT ที่ไม่จำกัด

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

## 3. ไฟล์โมเดลผู้จัดพิมพ์และสูตรการหาปริมาณสาธารณะ

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

การดาวน์โหลดโมเดลทั้งหมดใช้การแก้ไขที่ไม่เปลี่ยนรูปใน `deploy/compute/*profile*` และแฮช Git/LFS ของผู้จัดพิมพ์ ตัวเลือก `--cache <directory>` เป็นแบบอ่านอย่างเดียวและยอมรับไฟล์เฉพาะเมื่อไบต์ตรงกับผู้เผยแพร่เท่านั้น ไม่ใช่วิธีการนำเข้าไดเร็กทอรีโมเดลที่ติดตั้งโดยไม่เลือกปฏิบัติ ข้อความ MIT แบบสแตนด์อโลนของ ASR ถูกปักหมุดไว้ที่รุ่น Whisper ดั้งเดิม เนื่องจากสแน็ปช็อตโมเดลที่แปลงแล้วจะประกาศเฉพาะใบอนุญาตเท่านั้น OCR ยังคงมีใบอนุญาตของตัวเอง ไม่ใช่ MIT การ์ดโมเดลการแปลและการฝังที่ปักหมุดจะประกาศ Apache-2.0 โดยไม่ต้องจัดส่งข้อความแบบสแตนด์อโลน ผู้ช่วยของพวกเขารวมถึงใบอนุญาต Apache ที่ปักหมุดในการตรวจสอบและบันทึกที่มาหลังจากตรวจสอบการประกาศนั้น

การดาวน์โหลดการจับคู่ที่ถูกขัดจังหวะรองรับ `--resume` `--transfer ranges` ใช้ช่วง HTTP ที่กลับมาทำงานต่อแบบมีขอบเขตได้ `--transfer huggingface` ต้องการแพ็คเกจ `huggingface_hub`/`hf_xet` อย่างเป็นทางการ และปิดใช้งานการใช้โทเค็น แคชบางส่วนและการดาวน์โหลดยังคงอยู่นอกไดเร็กทอรีโมเดลที่เผยแพร่ได้ จำเป็นต้องมีการตรวจสอบผลรวมกับการขนส่งทุกครั้ง อย่าทำให้อ่อนลงสำหรับหน้าเข้าสู่ระบบ/ท้าทาย HTML หรือการดาวน์โหลดที่ถูกตัดทอน

การกำหนดปริมาณทำงานแบบออฟไลน์ในคอนเทนเนอร์บิลด์ที่แยกต่างหากโดยใช้ข้อมูลการสอบเทียบสังเคราะห์สาธารณะของ ModelOpt โดยไม่ต้องมีประวัติการแชท เฉพาะเอาต์พุตที่ `build.json` ระบุว่า `quantized` เท่านั้นที่สามารถจ่าย `assistant-model` and `translation-model`; เลือกไดเรกทอรีย่อย `model/` ไม่ใช่แหล่งข้อมูลดิบหรือพื้นที่ทำงานบิลด์ทั้งหมด หลังจากตรวจสอบอินพุตแล้ว บิลด์ Linux จะแนะนำให้เคอร์เนลปล่อยเพจแคชของไฟล์เฉพาะเหล่านั้น วิธีนี้จะหลีกเลี่ยงการอ่านหน่วยความจำ GPU โดยไม่ทำให้เข้าใจผิดในหน่วยความจำที่ใช้ร่วมกันของ GB10 โดยจะไม่ลบน้ำหนัก ล้างแคชทั่วทั้งโฮสต์ หรือหยุดปริมาณงาน สำหรับ GB10 GPU หนึ่งตัว ตัวช่วยจะตั้งงบประมาณจาก Linux `MemAvailable` และสงวนความจุสำหรับการสอบเทียบและโฮสต์ โดยจะปฏิเสธความจุที่ไม่เพียงพอ แทนที่จะยอมรับโครงสร้าง CPU ส่วนใหญ่อย่างเงียบๆ เมื่อโมเดลเต็มเหมาะสม งบประมาณ ModelOpt ที่ชัดเจนจะหลีกเลี่ยงเส้นทางการส่งออก CPU-offload ที่ไม่จำเป็นของ Accelerate คอนเทนเนอร์บิลด์ยังตั้งค่าหน่วยความจำที่ล็อคไม่จำกัดและสแต็ก 64 MiB เป็นไปตามข้อกำหนดการเปิดตัวเชิงปริมาณของ [NVIDIA](https://build.nvidia.com/spark/nvfp4-quantization/instructions) การตั้งค่าเหล่านี้กำหนดขอบเขตไว้ที่คอนเทนเนอร์บิลด์ ไม่ใช่ขีดจำกัดทั้งโฮสต์

## 4. ใส่แพ็คเกจให้สมบูรณ์

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

การควบรวมกิจการจะต้องรายงาน **41 บทบาทและไม่มีบทบาทที่ขาดหายไป** โดยจะตรวจสอบสถาปัตยกรรมรูปภาพ/รหัสเนื้อหา และปฏิเสธเอาต์พุตที่ขัดแย้งกัน ทรัพยากรประกอบด้วยเฟิร์มแวร์ UEFI อัปสตรีมเท่านั้น (รวมถึงเทมเพลตการจัดเก็บตัวแปรใหม่), ISO ไดรเวอร์ virtio ที่ปักหมุดเช็คซัม, รันไทม์การวาดแหล่งที่มา และประกาศของ Android ที่เชื่อมโยงกับอิมเมจที่สร้างขึ้นใหม่ ISO ไม่ใช่สื่อการติดตั้ง Windows มิเรอร์ Microsoft OpenVMM ที่เหมือนกันในการตรวจสอบจะหลีกเลี่ยงการใช้หน้าดาวน์โหลด Fedora แบบโต้ตอบ

รวบรวมแพ็คเกจโฮสต์ด้วย `collect_host_packages.py` ตามที่อธิบายไว้ใน [README.md](README.th.md) จากนั้นสร้างเทมเพลตด้วย `prepare-release.py --template` กรอกแผนที่รูปภาพจาก `images.json`; กรอกบทบาทสินทรัพย์ทั้ง 12 บทบาทจากเอาต์พุตโมเดล `resources/assets.json` and `guest-tools` ตั้งค่า `sourceCommit` เป็นการชำระเงินและเวอร์ชันตัวแทนจริง ไม่ยอมรับตัวยึดตำแหน่งหรือการกำหนดค่าการติดตั้งก่อนหน้า

เรียกใช้ `prepare-release.py --inputs … --output …` จากนั้น `build-package.sh` โดยใช้รีลีสที่เตรียมไว้นั้น แหล่งที่มาที่มีการแก้ไข/ไม่มีข้อผูกมัดจำเป็นต้องมีแฟล็กผู้สมัคร `--allow-working-tree` ที่ชัดเจน พวกเขาไม่ใช่การกระทำที่ปล่อยออกมา ดูการติดตั้งที่ [PACKAGE-README.md](PACKAGE-README.th.md) ฐานข้อมูลบัญชีเปล่าใหม่ได้รับ `admin/admin`; ข้อมูลประจำตัวบริการและข้อมูลระบุตัวตนของอุปกรณ์ทั้งหมดถูกสร้างขึ้นโดยอิสระ บิลด์เพียงอย่างเดียวไม่ได้พิสูจน์ว่าการติดตั้งสำเร็จ

## สูตรชั้นประวัติศาสตร์และการตรวจสอบสิ่งพิมพ์

Dockerfiles สำหรับการวินิจฉัย/แบบเลเยอร์ที่เก่ากว่าจะถูกเก็บไว้เพื่อการบำรุงรักษาต้นทาง ซึ่งไม่ได้ใช้งานโดยไปป์ไลน์นี้ อาร์กิวเมนต์ `BUILD_PARENT_N` ของพวกเขาตั้งใจไม่มีรูปภาพส่วนตัวเป็นค่าเริ่มต้น จัดหาพาเรนต์ที่เข้ากันได้ที่คุณสร้างขึ้น หรือใช้ไปป์ไลน์สาธารณะด้านบน อย่าเดาสรุปการพัฒนาที่ไม่พร้อมใช้งาน

ก่อนเผยแพร่ ให้รัน Source Guard และ Secret Scanner ตรวจสอบประวัติแยกกัน และยกเว้นไดเร็กทอรีบิวด์ แพ็คเกจ ดิสก์สำหรับแขก ข้อมูลบัญชี และเว็บไซต์ส่วนตัวทั้งหมด รายงานที่มีเส้นทางในเครื่องอยู่นอกแผนผังสาธารณะ การตรวจสอบความถูกต้องสำหรับงานนี้จำกัดอยู่ที่การสร้างการปิดอินพุต ข้อมูลระบุตัวตน การติดตั้ง และเส้นทางบริการขั้นต่ำที่ติดตั้งใหม่ จะไม่เรียกใช้การยอมรับธุรกิจที่ไม่เกี่ยวข้องอีกครั้ง
